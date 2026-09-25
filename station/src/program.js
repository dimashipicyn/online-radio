'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const log = require('./logger');
const settings = require('./settings');
const { PcmFifo } = require('./pcm');
const { TrackPlayer } = require('./player');
const library = require('./library');
const dj = require('./dj');

const { sampleRate, channels, bitrate } = config.icecast;
const BYTES_PER_SEC = sampleRate * channels * 2;
const CHUNK_BYTES = (BYTES_PER_SEC * 100) / 1000; // 17640 — тик микшера 100мс
const PREBUFFER_BYTES = BYTES_PER_SEC * 3;

// --- оверлей: вставка поверх приглушённого финала трека ---
const OVERLAY_TRIGGER_SEC = 20; // за сколько секунд до конца трека начинаем говорить поверх
const OVERLAY_MIN_SEC = 8;      // если меньше — не успеваем, играем вставку после трека как обычно
const DUCK_RAMP_SEC = 1.5;      // за сколько секунд музыка проваливается вниз
const MUSIC_DUCK_LEVEL = 0.18;  // уровень приглушённой музыки под голосом
const INSERT_START_GAIN = 0.40; // с какой доли громкости входит голос
const RELEASE_RAMP_SEC = 1.5;   // возврат громкости музыки после вставки
const SPEECH_BED_LEAD_SEC = 6;  // за сколько до конца речи запускаем следующий трек
const SPEECH_FADE_SEC = 4;      // нарастание музыки под хвостом спича

/**
 * Программный директор эфира. Микшер дёргает program.readChunk() каждый тик.
 * Состояния: music (трек) -> insert (джингл/DJ/звонок) -> music -> ...
 * Пока нечего ставить — отдаём null, микшер льёт тишину.
 */
class Program {
  constructor() {
    this.mixerFeeder = null;          // назначит index.js: mixer.feederProgram = program
    this.player = null;               // текущий TrackPlayer
    this.inserts = [];                // очередь {path, bytes, text, kind, speaker}
    this.currentInsert = null;        // {stream, fifo, served, ...}
    this.overlay = null;              // {insert, buf, pos, ...} — вставка поверх финала трека
    this.duckRelease = null;          // плавный возврат громкости музыки после оверлея
    this.bedTrack = null;             // трек, уже играющий под хвостом спича
    this.pendingAfterOverlay = null;  // трек, закончившийся во время оверлея
    this.preparingBreak = false;
    this.breakCounter = 0;
    this.nowPlaying = null;           // {title, artist, duration}
    this.startedAt = Date.now();
  }

  start() {
    this._startMusic();
    this._prewarmTts();
  }

  /** Прогрев Silero: холодный первый синтез занимает до минуты — вставка
   * опоздает к оверлею. TTS может подняться позже станции — ретраи. */
  _prewarmTts(attempt = 0) {
    require('./tts-client')
      .prepareInsert({ text: 'Эфир пошёл.', speaker: config.dj.speaker, kind: 'prewarm' })
      .then((ins) => {
        if (ins) {
          try { fs.unlinkSync(ins.path); } catch { /* ок */ }
          log.info('program: tts прогрет');
        } else if (attempt < 4) {
          setTimeout(() => this._prewarmTts(attempt + 1), 15000);
        }
      })
      .catch(() => { if (attempt < 4) setTimeout(() => this._prewarmTts(attempt + 1), 15000); });
  }

  status() {
    return {
      nowPlaying: this.nowPlaying,
      djEnabled: config.dj.enabled,
      musicEnabled: config.music.enabled,
      insertQueue: this.inserts.length,
      preparing: this.preparingBreak,
      breaksToday: this.breakCounter,
    };
  }

  // ---------------- музыка ----------------

  _startMusic({ underSpeech = false } = {}) {
    if (!config.music.enabled) return; // спич-режим: музыки нет, микшер льёт тишину
    if (this.player) return;
    let track = library.nextTrack({ category: 'music' });
    if (!track) {
      log.warn('program: в /music нет треков — молчим. Закиньте файлы в ./music');
      this._retryMusic(15000);
      return;
    }
    const p = new TrackPlayer(track, { sampleRate, channels, bytesPerSec: BYTES_PER_SEC, leadSec: config.dj.leadSec });
    this.player = p;
    if (underSpeech) this.bedTrack = track;
    else this.nowPlaying = { title: track.title, artist: track.artist, duration: track.duration || null };

    p.onReady = () => {
      // пребуферизовались — микшер сам подхватит из readChunk
      log.debug('program: музыка готова к эфиру');
    };
    p.onAlmostDone = (_pl, remaining) => {
      this._prepareBreakSoon(track, remaining);
    };
    p.onDone = () => {
      library.logHistory(track);
      this._onTrackFinished(track);
    };
    p.onError = () => {
      this.player = null;
      this._retryMusic(3000);
    };
    p.start();
  }

  _retryMusic(delay) {
    this.nowPlaying = null;
    setTimeout(() => this._startMusic(), delay);
  }

  _onTrackFinished(track) {
    this.player = null;
    this.bedTrack = null;
    if (this.currentInsert) return; // трек кончился под речью — вставку не рвём
    this.breakCounter++;
    // вставка поверх финала ещё звучит — музыку запустим, когда она договорит
    if (this.overlay) {
      this.pendingAfterOverlay = track;
      return;
    }
    this._playNextInsertOrMusic(track);
  }

  async _prepareBreakSoon(track, _remaining) {
    if (!config.dj.enabled || this.preparingBreak) return;
    this.preparingBreak = true;
    try {
      let insert = null;
      const topic = dj.takeTopic();
      const isFirst = this.breakCounter === 0;
      const wantChatter = Math.random() < config.dj.chatterChance;
      if (topic || isFirst || wantChatter) {
        const nextTrack = library.peekTrack({ category: 'music' }); // для контекста, ротацию не портим
        insert = await dj.prepareBreak({
          kind: topic ? 'topic' : isFirst ? 'greeting' : 'chatter',
          topic,
          prevTrack: track,
          nextTrack,
        });
      }
      if (insert) {
        // джингл перед голосом, если есть
        const jingle = library.nextTrack({ category: 'jingle' });
        if (jingle) this.inserts.push(await this._decodeJingle(jingle));
        this.inserts.push(insert);
      }
    } finally {
      this.preparingBreak = false;
    }
  }

  /** Джингл декодируем сразу в raw-файл через ffmpeg (быстрее, чем трек в эфире). */
  _decodeJingle(track) {
    return new Promise((resolve) => {
      const out = `/tmp/jingle-${Math.random().toString(36).slice(2)}.raw`;
      const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', track.path, '-f', 's16le', '-ar', '44100', '-ac', '2', '-y', out]);
      ff.on('close', (code) => {
        if (code !== 0) return resolve(null);
        const bytes = fs.statSync(out).size;
        resolve({ path: out, bytes, kind: 'jingle', text: track.title, speaker: 'jingle', temp: true });
      });
      ff.on('error', () => resolve(null));
    });
  }

  // ---------------- вставки ----------------

  /** Вставка из веба (звонок). priority=true — в начало очереди. */
  enqueueInsert(insert, { priority = false } = {}) {
    if (!insert) return;
    if (priority) this.inserts.unshift(insert);
    else this.inserts.push(insert);
    // если музыка стоит и ждём (и не звучит оверлей) — ткнём; в спич-режиме вставка идёт сразу в эфир
    if (!this.player && !this.currentInsert && !this.overlay) {
      if (config.music.enabled) this._startMusic();
      else this._playNextInsertOrMusic();
    }
  }

  _playNextInsertOrMusic(finishedTrack) {
    const insert = this.inserts.shift();
    if (!insert || !fs.existsSync(insert.path)) {
      this._startMusic();
      return;
    }
    const fifo = new PcmFifo();
    const stream = fs.createReadStream(insert.path, { highWaterMark: BYTES_PER_SEC });
    const state = { stream, fifo, ended: false };
    this.currentInsert = { ...insert, state };
    this.nowPlaying = {
      title: insert.kind === 'jingle' ? 'джингл' : insert.kind === 'call' ? 'звонок в студию' : `в эфире ${config.dj.name}`,
      artist: null,
      duration: insert.bytes / BYTES_PER_SEC,
      isInsert: true,
      insertText: insert.text,
    };
    log.info(`program: вставка ${insert.kind} в эфир`);
    stream.on('data', (d) => fifo.push(d));
    stream.on('end', () => { state.ended = true; });
    stream.on('error', () => { state.ended = true; });
    this._insertDone = () => {
      if (insert.temp) { try { fs.unlinkSync(insert.path); } catch { /* ок */ } }
      this.currentInsert = null;
      if (this.bedTrack && this.player && !this.inserts.length) {
        const t = this.bedTrack;
        this.bedTrack = null;
        this.nowPlaying = { title: t.title, artist: t.artist, duration: t.duration || null };
        return; // трек уже звучит, не стартуем второй
      }
      this._playNextInsertOrMusic(finishedTrack); // цепочкой до конца очереди
    };
  }

  /** За LEAD секунд до конца речи поднимаем следующий трек, чтобы хвост ушёл в музыку. */
  _maybeBedMusic() {
    const ci = this.currentInsert;
    if (!ci || ci.kind === 'jingle' || !config.music.enabled) return;
    if (this.player || this.inserts.length) return;
    const remain = ci.bytes - (ci.state.served || 0);
    if (remain > SPEECH_BED_LEAD_SEC * BYTES_PER_SEC) return;
    log.info(`program: музыка под хвостом спича (осталось ${(remain / BYTES_PER_SEC).toFixed(1)}с)`);
    this._startMusic({ underSpeech: true });
  }

  _mixSpeechTail(speech) {
    const ci = this.currentInsert;
    if (!ci || !this.player || ci.kind === 'jingle') return speech;
    const start = ci.state.served || 0;
    const fadeBytes = SPEECH_FADE_SEC * BYTES_PER_SEC;
    const fadeFrom = ci.bytes - fadeBytes;
    if (start + speech.length <= fadeFrom) return speech;
    const music = this.player.readExact(speech.length);
    if (!music) return speech;
    for (let i = 0; i < speech.length; i += 2) {
      const t = Math.max(0, Math.min(1, (start + i - fadeFrom) / fadeBytes));
      let v = Math.round(speech.readInt16LE(i) + music.readInt16LE(i) * t);
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      speech.writeInt16LE(v, i);
    }
    return speech;
  }

  _readInsertChunk() {
    const ci = this.currentInsert;
    if (!ci) return null;
    const st = ci.state;
    const buf = st.fifo.readExact(CHUNK_BYTES);
    if (buf) {
      const mixed = this._mixSpeechTail(buf);
      st.served = (st.served || 0) + buf.length;
      return mixed;
    }
    if (st.ended) {
      if (st.fifo.length > 0) {
        // хвост вставки: отдаём целиком (не выбрасываем!), добив тишиной до тика
        const out = Buffer.alloc(CHUNK_BYTES);
        const tail = st.fifo.readExact(st.fifo.length);
        tail.copy(out);
        const mixed = this._mixSpeechTail(out);
        st.served = (st.served || 0) + tail.length;
        return mixed;
      }
      const done = this._insertDone;
      this._insertDone = null;
      if (done) done();
      return null;
    }
    return null;
  }

  // ---------------- оверлей: вставка поверх затухающего трека ----------------

  _maybeStartOverlay() {
    if (this.overlay || this.currentInsert || !this.player) return;
    const p = this.player;
    if (!p.alive || p.remainingSec > OVERLAY_TRIGGER_SEC || p.remainingSec < OVERLAY_MIN_SEC) return;
    // оверлей — только голосовые вставки; джинглы играют между треками как обычно
    const idx = this.inserts.findIndex((i) => i.kind !== 'jingle');
    if (idx === -1) return;
    const insert = this.inserts[idx];
    if (!fs.existsSync(insert.path)) return;
    this.inserts.splice(idx, 1);
    let buf;
    try {
      buf = fs.readFileSync(insert.path); // 30-60с речи ≈ 5-10 МБ — ок для памяти
    } catch (e) {
      log.warn(`program: оверлей не удался, вставка после трека: ${e.message}`);
      return;
    }
    this.overlay = {
      insert,
      buf,
      pos: 0,
      musicConsumed: 0,
      savedNowPlaying: this.nowPlaying,
    };
    this.nowPlaying = {
      title: insert.kind === 'call' ? 'звонок в студию' : `в эфире ${config.dj.name}`,
      artist: null,
      duration: insert.bytes / BYTES_PER_SEC,
      isInsert: true,
      insertText: insert.text,
    };
    log.info(`program: ${insert.kind} поверх затухающего финала трека`);
  }

  _readOverlayChunk() {
    const st = this.overlay;
    if (!st) return null;
    const out = Buffer.alloc(CHUNK_BYTES);
    // голос (или джингл)
    const take = Math.min(st.buf.length - st.pos, CHUNK_BYTES);
    st.buf.copy(out, 0, st.pos, st.pos + take);
    st.pos += take;
    // музыка быстро утапливается и остаётся тихим фоном — «Валера пиздит, трек на фоне доигрывает»
    const music = this.player ? this.player.readExact(CHUNK_BYTES) : null;
    if (music) {
      st.musicConsumed += CHUNK_BYTES;
      const t = Math.min(1, st.musicConsumed / (DUCK_RAMP_SEC * BYTES_PER_SEC)); // дакинг за ~1.5с
      const musicGain = 1 - t * (1 - MUSIC_DUCK_LEVEL);
      const insertGain = INSERT_START_GAIN + t * (1 - INSERT_START_GAIN);
      for (let i = 0; i < CHUNK_BYTES; i += 2) {
        let v = Math.round(music.readInt16LE(i) * musicGain + out.readInt16LE(i) * insertGain);
        if (v > 32767) v = 32767;
        else if (v < -32768) v = -32768;
        out.writeInt16LE(v, i);
      }
    }
    // вставка договорила
    if (st.pos >= st.buf.length) {
      this.overlay = null;
      if (this.player) {
        this.nowPlaying = st.savedNowPlaying; // трек ещё доигрывает
        this.duckRelease = { consumed: 0, total: RELEASE_RAMP_SEC * BYTES_PER_SEC, from: MUSIC_DUCK_LEVEL };
      } else {
        const done = this.pendingAfterOverlay;
        this.pendingAfterOverlay = null;
        this._playNextInsertOrMusic(done);
      }
    }
    return out;
  }

  // ---------------- контракт микшера ----------------

  readChunk() {
    this._maybeStartOverlay();
    if (this.overlay) {
      const c = this._readOverlayChunk();
      if (c) return c;
    }
    if (this.currentInsert) {
      this._maybeBedMusic();
      const c = this._readInsertChunk();
      if (c) return c;
      if (this.currentInsert) return null; // вставка ещё пребуферизовывается
    }
    const p = this.player;
    if (!p) return null;
    // пребуфер только пока декодер жив: у доигрывающего трека добираем хвост
    if (p.alive && p.buffered < PREBUFFER_BYTES && p.remainingSec > 1) return null;
    const chunk = p.readExact(CHUNK_BYTES);
    if (!chunk) return null;
    // после оверлея музыка плавно возвращается к полной громкости
    if (this.duckRelease) {
      const r = this.duckRelease;
      r.consumed += CHUNK_BYTES;
      const t = Math.min(1, r.consumed / r.total);
      const g = r.from + t * (1 - r.from);
      for (let i = 0; i < chunk.length; i += 2) {
        chunk.writeInt16LE(Math.round(chunk.readInt16LE(i) * g), i);
      }
      if (t >= 1) this.duckRelease = null;
    }
    return chunk;
  }

  /** Принудительная подготовка звонка (вызывает web.js). */
  async makeCall({ name, text }) {
    const who = name || 'аноним';
    const insert = await dj.prepareBreak({
      kind: 'call',
      topic: `Звонок слушателя ${who}: «${text}»`,
      call: { name: who, text },
    });
    this.enqueueInsert(insert, { priority: true });
    return insert != null;
  }

  setDjEnabled(v) {
    settings.set({ 'dj.enabled': !!v }); // пишем через общие настройки — GUI подхватит
    return config.dj.enabled;
  }

  /** Включили музыку, а эфир молчит — стартуем сразу. */
  kickMusic() {
    if (config.music.enabled && !this.player && !this.currentInsert) this._startMusic();
  }
}

module.exports = { Program, CHUNK_BYTES, BYTES_PER_SEC };
