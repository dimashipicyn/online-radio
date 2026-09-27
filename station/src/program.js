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
const rss = require('./rss');
const { db } = require('./db');

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
const SPEECH_BED_LEAD_SEC = 3.5; // за сколько до конца речи запускаем следующий трек
const SPEECH_FADE_SEC = 2.5;     // мягкий вход музыки под хвостом спича (до duck-уровня)

function formatInsertMeta(insert) {
  const djName = settings.get('dj.name') || config.dj.name || 'Валера';
  const cohostName = settings.get('dj.cohostName') || config.dj.cohostName || 'Ксюша';
  if (insert.kind === 'jingle') return { title: 'джингл', artist: null };
  if (insert.kind === 'call') return { title: 'звонок в студию', artist: 'Звонок' };
  if (insert.kind === 'duo') return { title: 'разгон в студии', artist: `${djName} и ${cohostName}` };
  return { title: `в эфире ${djName}`, artist: djName };
}

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
    this.tracksSinceNews = 0;
    this.plannedNextTrack = null;
    this.nowPlaying = null;           // {title, artist, duration}
    this.startedAt = Date.now();
  }

  _ensureNextTrack() {
    if (!this.plannedNextTrack && config.music.enabled) {
      const pendingReq = db.prepare(`
        SELECT r.id, r.track_id, r.user_name, r.message, t.title, t.artist, t.path, t.duration
        FROM requests r
        JOIN tracks t ON r.track_id = t.id
        WHERE r.status = 'pending'
        ORDER BY r.id ASC
        LIMIT 1
      `).get();
      if (pendingReq) {
        this.plannedNextTrack = {
          id: pendingReq.track_id,
          title: pendingReq.title,
          artist: pendingReq.artist,
          path: pendingReq.path,
          duration: pendingReq.duration,
          category: 'music',
          requestId: pendingReq.id,
          requestUser: pendingReq.user_name,
          requestMessage: pendingReq.message,
        };
      } else {
        this.plannedNextTrack = library.nextTrack({ category: 'music' });
      }
    }
    return this.plannedNextTrack;
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
      nextTrack: this.plannedNextTrack ? {
        title: this.plannedNextTrack.title,
        artist: this.plannedNextTrack.artist,
      } : null,
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
    let track = this.plannedNextTrack || this._ensureNextTrack();
    this.plannedNextTrack = null;
    this._ensureNextTrack();
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
    this.tracksSinceNews = (this.tracksSinceNews || 0) + 1;
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

      // 1. Проверяем стол заказов
      let request = null;
      if (!topic && !isFirst) {
        request = db.prepare(`
          SELECT r.id, r.track_id, r.user_name, r.message, t.title, t.artist, t.path, t.duration
          FROM requests r
          JOIN tracks t ON r.track_id = t.id
          WHERE r.status = 'pending'
          ORDER BY r.id ASC
          LIMIT 1
        `).get();
      }

      // Новости по расписанию треков
      const newsInterval = Number(settings.get('news.intervalTracks')) || 0;
      const newsEnabled = Boolean(settings.get('news.enabled'));
      const isNewsDue = newsEnabled && newsInterval > 0 && ((this.tracksSinceNews || 0) >= newsInterval);

      let newsItems = null;
      if (!topic && !request && !isFirst && isNewsDue) {
        const count = Number(settings.get('news.itemsPerBreak')) || 2;
        newsItems = rss.takePendingNews(count);
        if (newsItems && newsItems.length > 0) {
          this.tracksSinceNews = 0;
        } else {
          newsItems = null;
        }
      }

      const wantChatter = Math.random() < config.dj.chatterChance;
      const cohostEnabled = settings.get('dj.cohostEnabled') !== false && (config.dj.cohostEnabled !== false);
      const cohostChance = Number(settings.get('dj.cohostChance') ?? config.dj.cohostChance ?? 0.4);

      if (topic || request || isFirst || newsItems || wantChatter) {
        let nextTrack = null;
        let breakKind = 'chatter';

        if (topic) {
          breakKind = (cohostEnabled && Math.random() < cohostChance) ? 'duo' : 'topic';
          nextTrack = this._ensureNextTrack();
        } else if (request) {
          breakKind = 'request';
          nextTrack = {
            id: request.track_id,
            title: request.title,
            artist: request.artist,
            path: request.path,
            duration: request.duration,
            category: 'music',
          };
          this.plannedNextTrack = nextTrack;
        } else if (isFirst) {
          breakKind = 'greeting';
          nextTrack = this._ensureNextTrack();
        } else if (newsItems) {
          breakKind = 'news';
          nextTrack = this._ensureNextTrack();
        } else {
          breakKind = (cohostEnabled && Math.random() < cohostChance) ? 'duo' : 'chatter';
          nextTrack = this._ensureNextTrack();
        }

        insert = await dj.prepareBreak({
          kind: breakKind,
          topic,
          newsItems,
          request: request ? {
            id: request.id,
            userName: request.user_name,
            message: request.message,
            title: request.title,
            artist: request.artist,
          } : null,
          prevTrack: track,
          nextTrack,
        });

        if (insert && request) {
          db.prepare("UPDATE requests SET status = 'played', played_at = ? WHERE id = ?").run(Date.now(), request.id);
        }
      }
      if (insert && insert.path && fs.existsSync(insert.path)) {
        // джингл перед голосом, если есть
        const jingle = library.nextTrack({ category: 'jingle' });
        if (jingle) {
          const dec = await this._decodeJingle(jingle);
          if (dec && dec.path && fs.existsSync(dec.path)) {
            this.inserts.push(dec);
          }
        }
        this.inserts.push(insert);
      }
    } finally {
      this.preparingBreak = false;
    }
  }

  /** Джингл декодируем сразу в raw-файл через ffmpeg (быстрее, чем трек в эфире). */
  _decodeJingle(track) {
    if (!track || !track.path || !fs.existsSync(track.path)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const out = `/tmp/jingle-${Math.random().toString(36).slice(2)}.raw`;
      const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', track.path, '-f', 's16le', '-ar', '44100', '-ac', '2', '-y', out]);
      ff.on('close', (code) => {
        if (code !== 0) {
          try { fs.unlinkSync(out); } catch { /* ок */ }
          return resolve(null);
        }
        try {
          const bytes = fs.statSync(out).size;
          if (bytes === 0) {
            try { fs.unlinkSync(out); } catch { /* ок */ }
            return resolve(null);
          }
          resolve({ path: out, bytes, kind: 'jingle', text: track.title, speaker: 'jingle', temp: true });
        } catch {
          resolve(null);
        }
      });
      ff.on('error', () => {
        try { fs.unlinkSync(out); } catch { /* ок */ }
        resolve(null);
      });
    });
  }

  // ---------------- вставки ----------------

  /** Вставка из веба (звонок). priority=true — в начало очереди. */
  enqueueInsert(insert, { priority = false } = {}) {
    if (!insert || !insert.path || !insert.kind || !fs.existsSync(insert.path)) return;
    if (priority) this.inserts.unshift(insert);
    else this.inserts.push(insert);
    // если музыка стоит и ждём (и не звучит оверлей) — ткнём; в спич-режиме вставка идёт сразу в эфир
    if (!this.player && !this.currentInsert && !this.overlay) {
      if (config.music.enabled) this._startMusic();
      else this._playNextInsertOrMusic();
    }
  }

  _playNextInsertOrMusic(finishedTrack) {
    while (this.inserts.length > 0) {
      const insert = this.inserts.shift();
      if (!insert || !insert.path || !fs.existsSync(insert.path)) {
        if (insert && insert.temp && insert.path) {
          try { fs.unlinkSync(insert.path); } catch { /* ок */ }
        }
        continue;
      }
      const fifo = new PcmFifo();
      const stream = fs.createReadStream(insert.path, { highWaterMark: BYTES_PER_SEC });
      const state = { stream, fifo, ended: false };
      this.currentInsert = { ...insert, state };
      const meta = formatInsertMeta(insert);
      this.nowPlaying = {
        title: meta.title,
        artist: meta.artist,
        duration: insert.bytes / BYTES_PER_SEC,
        isInsert: true,
        insertText: insert.text,
      };
      log.info(`program: вставка ${insert.kind} в эфир`);
      stream.on('data', (d) => fifo.push(d));
      stream.on('end', () => { state.ended = true; });
      stream.on('error', () => { state.ended = true; });
      this._insertDone = () => {
        if (insert.temp && insert.path) { try { fs.unlinkSync(insert.path); } catch { /* ок */ } }
        this.currentInsert = null;
        if (this.bedTrack && this.player && !this.inserts.length) {
          const t = this.bedTrack;
          this.bedTrack = null;
          this.nowPlaying = { title: t.title, artist: t.artist, duration: t.duration || null };
          // Плавный возврат громкости музыки на 100% после того, как ведущий замолчал
          this.duckRelease = { consumed: 0, total: RELEASE_RAMP_SEC * BYTES_PER_SEC, from: MUSIC_DUCK_LEVEL };
          return; // трек уже звучит, не стартуем второй
        }
        this._playNextInsertOrMusic(finishedTrack); // цепочкой до конца очереди
      };
      return;
    }
    this._startMusic();
  }

  /** За LEAD секунд до конца речи поднимаем следующий трек, чтобы хвост ушёл в музыку. */
  _maybeBedMusic() {
    const ci = this.currentInsert;
    if (!ci || !ci.state || !ci.bytes || ci.kind === 'jingle' || !config.music.enabled) return;
    if (this.player || this.inserts.length) return;
    const remain = ci.bytes - (ci.state.served || 0);
    if (remain > SPEECH_BED_LEAD_SEC * BYTES_PER_SEC) return;
    log.info(`program: музыка под хвостом спича (осталось ${(remain / BYTES_PER_SEC).toFixed(1)}с)`);
    this._startMusic({ underSpeech: true });
  }

  _mixSpeechTail(speech) {
    const ci = this.currentInsert;
    if (!ci || !ci.state || !ci.bytes || !this.player || ci.kind === 'jingle') return speech;
    const start = ci.state.served || 0;
    const fadeBytes = SPEECH_FADE_SEC * BYTES_PER_SEC;
    const fadeFrom = ci.bytes - fadeBytes;
    if (start + speech.length <= fadeFrom) return speech;
    const music = this.player.readExact(speech.length);
    if (!music) return speech;
    for (let i = 0; i < speech.length; i += 2) {
      // Плавное нарастание музыки под речью только до MUSIC_DUCK_LEVEL (0.18..0.25),
      // чтобы трек НИКОГДА не глушил последние слова и финальную мысль ведущего!
      const t = Math.max(0, Math.min(1, (start + i - fadeFrom) / fadeBytes));
      const musicGain = t * MUSIC_DUCK_LEVEL;
      let v = Math.round(speech.readInt16LE(i) + music.readInt16LE(i) * musicGain);
      if (v > 32767) v = 32767;
      else if (v < -32768) v = -32768;
      speech.writeInt16LE(v, i);
    }
    return speech;
  }

  _readInsertChunk() {
    const ci = this.currentInsert;
    if (!ci || !ci.state || !ci.state.fifo) return null;
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
        if (tail) tail.copy(out);
        const mixed = this._mixSpeechTail(out);
        st.served = (st.served || 0) + (tail ? tail.length : 0);
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
    // Очистим невалидные элементы из очереди вставок
    this.inserts = (this.inserts || []).filter((i) => i && i.path && fs.existsSync(i.path));
    // оверлей — только голосовые вставки; джинглы играют между треками как обычно
    const idx = this.inserts.findIndex((i) => i && i.kind && i.kind !== 'jingle');
    if (idx === -1) return;
    const insert = this.inserts[idx];
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
    const meta = formatInsertMeta(insert);
    this.nowPlaying = {
      title: meta.title,
      artist: meta.artist,
      duration: insert.bytes / BYTES_PER_SEC,
      isInsert: true,
      insertText: insert.text,
    };
    log.info(`program: ${insert.kind} поверх затухающего финала трека`);
  }

  _readOverlayChunk() {
    const st = this.overlay;
    if (!st || !st.buf) return null;
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
      if (st.insert && st.insert.temp && st.insert.path) {
        try { fs.unlinkSync(st.insert.path); } catch { /* ок */ }
      }
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
    try {
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
    } catch (err) {
      log.error('program: непредвиденная ошибка в readChunk:', err);
      if (this.overlay) {
        if (this.overlay.insert && this.overlay.insert.temp && this.overlay.insert.path) {
          try { fs.unlinkSync(this.overlay.insert.path); } catch { /* ок */ }
        }
        this.overlay = null;
      }
      if (this.currentInsert) {
        if (this.currentInsert.temp && this.currentInsert.path) {
          try { fs.unlinkSync(this.currentInsert.path); } catch { /* ок */ }
        }
        this.currentInsert = null;
      }
      this.inserts = (this.inserts || []).filter((i) => i && i.path && fs.existsSync(i.path));
      return null;
    }
  }

  /** Принудительная подготовка звонка (вызывает web.js). */
  async makeCall({ name, text, gender = 'auto', mood = null }) {
    const who = name || 'аноним';
    const insert = await dj.prepareBreak({
      kind: 'call',
      topic: `Звонок слушателя ${who}: «${text}»`,
      call: { name: who, text, gender, mood },
    });
    if (insert && insert.path && fs.existsSync(insert.path)) {
      this.enqueueInsert(insert, { priority: true });
      return true;
    }
    return false;
  }

  /** Приём заявки на трек в Стол заказов (вызывает web.js). */
  makeRequest({ trackId, userName, message }) {
    const track = library.getTrackById(Number(trackId));
    if (!track) return { ok: false, error: 'Трек не найден' };
    const res = db.prepare('INSERT INTO requests(track_id, user_name, message, status, created_at) VALUES(?,?,?,?,?)')
      .run(track.id, String(userName || 'Слушатель').slice(0, 40), String(message || '').slice(0, 250), 'pending', Date.now());
    log.info(`program: принят заказ трека #${res.lastInsertRowid} от ${userName || 'анонима'}: «${track.artist} — ${track.title}»`);
    if (!this.plannedNextTrack || !this.plannedNextTrack.requestId) {
      this.plannedNextTrack = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        path: track.path,
        duration: track.duration,
        category: 'music',
        requestId: res.lastInsertRowid,
        requestUser: userName,
        requestMessage: message,
      };
    }
    return { ok: true, id: res.lastInsertRowid, track };
  }

  /** Экстренный / ручной выход ведущего в эфир по требованию админа. */
  async triggerBreakNow({ topic = null, kind = null } = {}) {
    if (this.preparingBreak) return { ok: false, error: 'Ведущий уже готовит реплику' };
    const breakKind = kind || (topic ? 'topic' : 'chatter');
    log.info(`program: ручной вызов ведущего в эфир из админки (${breakKind})`);
    this.preparingBreak = true;
    try {
      const track = this.player ? this.player.track : null;
      const nextTrack = this._ensureNextTrack();
      const insert = await dj.prepareBreak({
        kind: breakKind,
        topic,
        prevTrack: track,
        nextTrack,
      });
      if (!insert || !insert.path || !fs.existsSync(insert.path)) {
        return { ok: false, error: 'генерация речи ведущего не удалась' };
      }

      // Если музыка играет и нет оверлея — выходим прямо сейчас поверх музыки!
      if (this.player && !this.overlay) {
        try {
          const buf = fs.readFileSync(insert.path);
          this.overlay = {
            insert,
            buf,
            pos: 0,
            musicConsumed: 0,
            savedNowPlaying: this.nowPlaying,
          };
          const meta = formatInsertMeta(insert);
          this.nowPlaying = {
            title: meta.title,
            artist: meta.artist,
            duration: insert.bytes / BYTES_PER_SEC,
            isInsert: true,
            insertText: insert.text,
          };
          log.info(`program: экстренный выход ${insert.kind} поверх музыки`);
          return { ok: true, text: insert.text };
        } catch (e) {
          log.warn(`program: не удалось наложить оверлей: ${e.message}`);
        }
      }

      // Иначе ставим в начало очереди вставок
      this.enqueueInsert(insert, { priority: true });
      return { ok: true, text: insert.text };
    } finally {
      this.preparingBreak = false;
    }
  }

  /** Экстренный или ручной выпуск новостей в эфир из админки. */
  async triggerNewsBreakNow({ newsId = null } = {}) {
    if (this.preparingBreak) return { ok: false, error: 'Ведущий уже готовит реплику' };
    log.info('program: ручной вызов выпуска новостей в эфир');
    this.preparingBreak = true;
    try {
      let newsItems = [];
      if (newsId) {
        const item = db.prepare('SELECT n.*, f.name as feed_name FROM news n LEFT JOIN rss_feeds f ON n.feed_id = f.id WHERE n.id = ?').get(newsId);
        if (item) {
          db.prepare("UPDATE news SET status = 'used' WHERE id = ?").run(item.id);
          newsItems = [item];
        }
      }
      if (!newsItems.length) {
        const count = Number(settings.get('news.itemsPerBreak')) || 2;
        newsItems = rss.takePendingNews(count);
      }
      if (!newsItems.length) {
        newsItems = db.prepare('SELECT n.*, f.name as feed_name FROM news n LEFT JOIN rss_feeds f ON n.feed_id = f.id ORDER BY n.pub_date DESC, n.id DESC LIMIT 2').all();
      }
      if (!newsItems.length) {
        return { ok: false, error: 'В базе нет новостей. Обновите RSS-источники.' };
      }

      this.tracksSinceNews = 0;
      const track = this.player ? this.player.track : null;
      const nextTrack = this._ensureNextTrack();
      const insert = await dj.prepareBreak({
        kind: 'news',
        newsItems,
        prevTrack: track,
        nextTrack,
      });
      if (!insert || !insert.path || !fs.existsSync(insert.path)) {
        return { ok: false, error: 'Не удалось сгенерировать выпуск новостей' };
      }

      if (this.player && !this.overlay) {
        try {
          const buf = fs.readFileSync(insert.path);
          this.overlay = {
            insert,
            buf,
            pos: 0,
            musicConsumed: 0,
            savedNowPlaying: this.nowPlaying,
          };
          this.nowPlaying = {
            title: `выпуск новостей (${config.dj.name})`,
            artist: null,
            duration: insert.bytes / BYTES_PER_SEC,
            isInsert: true,
            insertText: insert.text,
          };
          log.info('program: экстренный выпуск новостей поверх музыки');
          return { ok: true, text: insert.text, count: newsItems.length };
        } catch (e) {
          log.warn(`program: не удалось наложить оверлей: ${e.message}`);
        }
      }

      this.enqueueInsert(insert, { priority: true });
      return { ok: true, text: insert.text, count: newsItems.length };
    } finally {
      this.preparingBreak = false;
    }
  }

  setDjEnabled(v) {
    settings.set({ 'dj.enabled': !!v }); // пишем через общие настройки — GUI подхватит
    return config.dj.enabled;
  }

  /** Включили музыку, а эфир молчит — стартуем сразу. */
  kickMusic() {
    if (config.music.enabled && !this.player && !this.currentInsert) this._startMusic();
  }

  /** Ручной пропуск текущего трека / вставки из админки. */
  skip() {
    log.info('program: ручной пропуск трека из админки');
    if (this.player) {
      this.player.stop();
      this.player = null;
    }
    if (this.overlay) {
      if (this.overlay.insert && this.overlay.insert.temp && this.overlay.insert.path) {
        try { fs.unlinkSync(this.overlay.insert.path); } catch { /* ок */ }
      }
      this.overlay = null;
    }
    if (this.currentInsert) {
      if (this.currentInsert.temp && this.currentInsert.path) {
        try { fs.unlinkSync(this.currentInsert.path); } catch { /* ок */ }
      }
      this.currentInsert = null;
    }
    this.bedTrack = null;
    this.pendingAfterOverlay = null;
    this.duckRelease = null;
    if (config.music.enabled) {
      this._startMusic();
    } else {
      this._playNextInsertOrMusic();
    }
    return this.nowPlaying;
  }
}

module.exports = { Program, CHUNK_BYTES, BYTES_PER_SEC };
