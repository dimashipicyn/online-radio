'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const log = require('./logger');
const { PcmFifo } = require('./pcm');
const { TrackPlayer } = require('./player');
const library = require('./library');
const dj = require('./dj');

const { sampleRate, channels, bitrate } = config.icecast;
const BYTES_PER_SEC = sampleRate * channels * 2;
const CHUNK_BYTES = (BYTES_PER_SEC * 100) / 1000; // 17640 — тик микшера 100мс
const PREBUFFER_BYTES = BYTES_PER_SEC * 3;

// --- оверлей: вставка поверх затухающего финала трека ---
const OVERLAY_TRIGGER_SEC = 20; // за сколько секунд до конца трека начинаем говорить поверх
const OVERLAY_MIN_SEC = 8;      // если меньше — не успеваем, играем вставку после трека как обычно
const MUSIC_FADE_MIN = 0.10;    // до какой доли громкости затухает музыка
const INSERT_START_GAIN = 0.25; // с какой доли громкости входит голос

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
    this.pendingAfterOverlay = null;  // трек, закончившийся во время оверлея
    this.preparingBreak = false;
    this.breakCounter = 0;
    this.djEnabled = config.dj.enabled;
    this.nowPlaying = null;           // {title, artist, duration}
    this.startedAt = Date.now();
  }

  start() {
    this._startMusic();
    this._prewarmTts();
  }

  /** Прогрев Silero: холодный первый синтез занимает до минуты — вставка
   * опоздает к оверлею. Греем сразу, результат в эфир не пойдёт. */
  _prewarmTts() {
    require('./tts-client')
      .prepareInsert({ text: 'Эфир пошёл.', speaker: config.dj.speaker, kind: 'prewarm' })
      .then((ins) => { if (ins) { try { fs.unlinkSync(ins.path); } catch { /* ок */ } } })
      .catch(() => {});
  }

  status() {
    return {
      nowPlaying: this.nowPlaying,
      djEnabled: this.djEnabled,
      insertQueue: this.inserts.length,
      preparing: this.preparingBreak,
      breaksToday: this.breakCounter,
    };
  }

  // ---------------- музыка ----------------

  _startMusic() {
    if (this.player) return;
    let track = library.nextTrack({ category: 'music' });
    if (!track) {
      log.warn('program: в /music нет треков — молчим. Закиньте файлы в ./music');
      this._retryMusic(15000);
      return;
    }
    const p = new TrackPlayer(track, { sampleRate, channels, bytesPerSec: BYTES_PER_SEC, leadSec: config.dj.leadSec });
    this.player = p;
    this.nowPlaying = { title: track.title, artist: track.artist, duration: track.duration || null };

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
    this.breakCounter++;
    // вставка поверх финала ещё звучит — музыку запустим, когда она договорит
    if (this.overlay) {
      this.pendingAfterOverlay = track;
      return;
    }
    this._playNextInsertOrMusic(track);
  }

  async _prepareBreakSoon(track, _remaining) {
    if (!this.djEnabled || this.preparingBreak) return;
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
    // если музыка стоит и ждём (и не звучит оверлей) — ткнём
    if (!this.player && !this.currentInsert && !this.overlay) this._startMusic();
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
      this._playNextInsertOrMusic(finishedTrack); // цепочкой до конца очереди
    };
  }

  _readInsertChunk() {
    const ci = this.currentInsert;
    if (!ci) return null;
    const st = ci.state;
    const buf = st.fifo.readExact(CHUNK_BYTES);
    if (buf) return buf;
    if (st.ended) {
      if (st.fifo.length > 0) {
        // хвост вставки: отдаём целиком (не выбрасываем!), добив тишиной до тика
        const out = Buffer.alloc(CHUNK_BYTES);
        st.fifo.readExact(st.fifo.length).copy(out);
        return out;
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
      musicTotal: Math.max(CHUNK_BYTES, Math.round(p.remainingSec * BYTES_PER_SEC)),
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
    // музыка с плавным затуханием — «Валера пиздит, трек на фоне доигрывает»
    const music = this.player ? this.player.readExact(CHUNK_BYTES) : null;
    if (music) {
      st.musicConsumed += CHUNK_BYTES;
      const t = Math.min(1, st.musicConsumed / st.musicTotal); // 0..1 по остатку трека
      const musicGain = 1 - t * (1 - MUSIC_FADE_MIN);
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
      const c = this._readInsertChunk();
      if (c) return c;
      if (this.currentInsert) return null; // вставка ещё пребуферизовывается
    }
    const p = this.player;
    if (!p) return null;
    // пребуфер только пока декодер жив: у доигрывающего трека добираем хвост
    if (p.alive && p.buffered < PREBUFFER_BYTES && p.remainingSec > 1) return null;
    return p.readExact(CHUNK_BYTES);
  }

  /** Принудительная подготовка звонка (вызывает web.js). */
  async makeCall({ name, text }) {
    const prompt = `Звонок слушателя ${name || 'аноним'}: «${text}»`;
    const insert = await dj.prepareBreak({ kind: 'call', topic: prompt });
    this.enqueueInsert(insert, { priority: true });
    return insert != null;
  }

  setDjEnabled(v) {
    this.djEnabled = !!v;
    return this.djEnabled;
  }
}

module.exports = { Program, CHUNK_BYTES, BYTES_PER_SEC };
