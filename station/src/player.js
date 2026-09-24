'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const log = require('./logger');
const settings = require('./settings');

/**
 * Декодирует трек в s16le 44.1k stereo через ffmpeg и отдаёт PCM по требованию.
 * ffmpeg декодирует быстрее реального времени, поэтому stdout притормаживаем
 * по водяным знакам буфера (pipe backpressure).
 */
class TrackPlayer {
  constructor(track, { sampleRate, channels, prebufferSec = 3, maxBufferSec = 10, bytesPerSec }) {
    this.track = track;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bytesPerSec = bytesPerSec;
    this.prebufferBytes = prebufferSec * bytesPerSec;
    this.maxBytes = maxBufferSec * bytesPerSec;

    this.fifo = { parts: [], length: 0 };
    this.decodedBytes = 0;
    this.ff = null;
    this.stopped = false;
    this.leadFired = false;
    this.doneFired = false;
    this.readyFired = false;

    this.onReady = null;      // (player) => {}
    this.onAlmostDone = null; // (player, remainingSec) => {}
    this.onDone = null;       // (player) => {}
    this.onError = null;      // (player, err) => {}
  }

  get buffered() {
    return this.fifo.length;
  }

  /** Сколько уже проиграно реального времени (по съеденному из буфера). */
  get playedSec() {
    const played = this.decodedBytes - this.fifo.length;
    return played / this.bytesPerSec;
  }

  get remainingSec() {
    if (!this.track.duration) return 60;
    return Math.max(0, this.track.duration - this.playedSec);
  }

  /** Жив ли декодер (может ли буфер ещё наполняться). */
  get alive() {
    return !!this.ff;
  }

  start() {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', this.track.path,
      '-vn',
    ];
    const mv = Number(settings.get('audio.musicVolume'));
    if (Number.isFinite(mv) && mv > 0 && mv !== 1) args.push('-af', `volume=${mv}`);
    args.push(
      '-f', 's16le',
      '-ar', String(this.sampleRate),
      '-ac', String(this.channels),
      'pipe:1',
    );
    log.info(`player: играю «${this.track.artist || '?'} — ${this.track.title || path.basename(this.track.path)}»`);
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ff = ff;
    ff.stdout.on('data', (d) => this._push(d));
    ff.stderr.on('data', (d) => log.warn('ffmpeg[dec]:', d.toString().trim().split('\n')[0]));
    ff.on('error', (err) => this._fail(err));
    ff.on('close', () => {
      this.ff = null;
      this._maybeDone();
    });
  }

  _push(d) {
    if (this.stopped) return;
    this.fifo.parts.push(d);
    this.fifo.length += d.length;
    this.decodedBytes += d.length;
    if (!this.readyFired && this.fifo.length >= this.prebufferBytes) {
      this.readyFired = true;
      if (this.onReady) this.onReady(this);
    }
    if (this.fifo.length > this.maxBytes) this.ff && this.ff.stdout.pause();
    if (!this.leadFired && this.remainingSec <= 30) {
      this.leadFired = true;
      if (this.onAlmostDone) this.onAlmostDone(this, this.remainingSec);
    }
  }

  /** Микшер вычитывает ровно n байт; null — пока нет. */
  readExact(n) {
    if (this.fifo.length < n) {
      this._maybeDone(); // важно: конец трека может наступить именно тут
      return null;
    }
    if (this.ff && this.ff.stdout.isPaused() && this.fifo.length < this.maxBytes * 0.5) {
      this.ff.stdout.resume();
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const head = this.fifo.parts[0];
      const take = Math.min(head.length, n - filled);
      head.copy(out, filled, 0, take);
      if (take === head.length) this.fifo.parts.shift();
      else this.fifo.parts[0] = head.subarray(take);
      filled += take;
    }
    this.fifo.length -= n;
    this._maybeDone();
    return out;
  }

  _maybeDone() {
    if (this.doneFired || this.stopped) return;
    if (!this.ff && this.fifo.length < 17640) { // декодер закрыт и буфер почти пуст
      this.doneFired = true;
      log.info('player: трек доиграл');
      if (this.onDone) this.onDone(this);
    }
  }

  _fail(err) {
    if (this.stopped) return;
    log.error('player: ошибка декодирования:', err.message);
    if (this.onError) this.onError(this, err);
  }

  stop() {
    this.stopped = true;
    if (this.ff) {
      try { this.ff.kill('SIGKILL'); } catch { /* уже всё */ }
      this.ff = null;
    }
  }
}

/** Список аудиофайлов в папке (рекурсивно). На 9p-монтах (диски Windows в WSL)
 * dirent может приходить с неизвестным типом — уточняем через stat. */
function listAudio(dir, exts) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      let isDir = e.isDirectory();
      if (!isDir && !e.isFile()) {
        try { isDir = fs.statSync(p).isDirectory(); } catch { continue; }
      }
      if (isDir) walk(p);
      else if (exts.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Длительность+теги через ffprobe. */
function probe(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', file,
    ]);
    let buf = '';
    ff.stdout.on('data', (d) => (buf += d));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}`));
      try {
        const j = JSON.parse(buf);
        const tags = (j.format && j.format.tags) || {};
        resolve({
          duration: parseFloat(j.format && j.format.duration) || 0,
          title: tags.title || tags.TITLE || '',
          artist: tags.artist || tags.ARTIST || tags.album_artist || '',
          album: tags.album || '',
        });
      } catch (e) { reject(e); }
    });
  });
}

module.exports = { TrackPlayer, listAudio, probe };
