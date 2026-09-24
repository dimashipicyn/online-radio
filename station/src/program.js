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
    this.preparingBreak = false;
    this.breakCounter = 0;
    this.nowPlaying = null;           // {title, artist, duration}
    this.startedAt = Date.now();
  }

  start() {
    this._startMusic();
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

  _startMusic() {
    if (!config.music.enabled) return; // спич-режим: музыки нет, микшер льёт тишину
    if (this.player) return;
    let track = library.nextTrack({ category: 'music' });
    if (!track) {
      log.warn('program: в /music нет треков — молчим. Закиньте файлы в ./music');
      this._retryMusic(15000);
      return;
    }
    const p = new TrackPlayer(track, { sampleRate, channels, bytesPerSec: BYTES_PER_SEC });
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
    // вставки (джингл/DJ/звонки) играем после трека
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
    // если музыка стоит и ждём — ткнём; в спич-режиме вставка идёт сразу в эфир
    if (!this.player && !this.currentInsert) {
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
      this._playNextInsertOrMusic(finishedTrack); // цепочкой до конца очереди
    };
  }

  _readInsertChunk() {
    const ci = this.currentInsert;
    if (!ci) return null;
    const st = ci.state;
    const buf = st.fifo.readExact(CHUNK_BYTES);
    if (buf) return buf;
    if (st.ended && st.fifo.length < CHUNK_BYTES) {
      // хвост вставки — добьём тишиной и переключимся
      if (st.fifo.length > 0) st.fifo.drain(st.fifo.length);
      const done = this._insertDone;
      this._insertDone = null;
      if (done) done();
      return null;
    }
    return null;
  }

  // ---------------- контракт микшера ----------------

  readChunk() {
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
    settings.set({ 'dj.enabled': !!v }); // пишем через общие настройки — GUI подхватит
    return config.dj.enabled;
  }
}

module.exports = { Program, CHUNK_BYTES, BYTES_PER_SEC };
