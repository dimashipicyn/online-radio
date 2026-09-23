'use strict';

const { spawn } = require('child_process');
const config = require('./config');
const log = require('./logger');

const { sampleRate, channels, bitrate } = config.icecast;
const BYTES_PER_SEC = sampleRate * channels * 2; // s16le
const TICK_MS = 100;
const CHUNK_BYTES = (BYTES_PER_SEC * TICK_MS) / 1000;

const MIN_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 15000;

/**
 * Мастер-цепочка эфира: PCM (s16le 44.1k stereo) -> ffmpeg -> mp3 -> icecast.
 * Пока программа не готова, в эфир идёт тишина (realtime pacing).
 * В следующих этапах feederProgram отдаёт реальные аудиочанки.
 */
class Mixer {
  constructor(cfg = config.icecast) {
    this.cfg = cfg;
    this.ffmpeg = null;
    this.pacer = null;
    this.online = false;
    this.startedAt = null;
    this.attempts = 0;
    this.reconnectTimer = null;
    this.stopped = false;
    // точка расширения: источник программы эфира (этап 2+).
    // Контракт: readChunk() -> Buffer размером CHUNK_BYTES | null (нет данных -> тишина)
    this.feederProgram = null;
  }

  status() {
    return {
      online: this.online,
      streamingSince: this.startedAt,
      icecast: `${this.cfg.host}:${this.cfg.port}/${this.cfg.mount}`,
      format: `mp3 ${this.cfg.bitrate}k / ${sampleRate}Hz / ${channels}ch`,
      source: this.feederProgram ? 'program' : 'SILENCE',
    };
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this._teardown();
  }

  _connect() {
    if (this.stopped) return;
    const { host, port, mount, password } = this.cfg;
    const url = `icecast://source:${encodeURIComponent(password)}@${host}:${port}/${mount}`;

    const args = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-f', 's16le',
      '-ar', String(sampleRate),
      '-ac', String(channels),
      '-i', 'pipe:0',
      '-c:a', 'libmp3lame',
      '-b:a', `${bitrate}k`,
      '-content_type', 'audio/mpeg',
      '-f', 'mp3',
      url,
    ];

    log.info(`mixer: подключаюсь к icecast ${host}:${port}/${mount}`);
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.ffmpeg = ff;
    this.startedAt = this.startedAt || new Date().toISOString();

    let errBuf = '';
    ff.stderr.on('data', (d) => {
      errBuf = (errBuf + d.toString()).slice(-2000);
      for (const line of d.toString().split('\n')) if (line.trim()) log.warn('ffmpeg:', line.trim());
    });

    ff.on('spawn', () => {
      this.online = true;
      this.attempts = 0;
      log.info('mixer: поток идёт в icecast');
      this._startPacer();
    });

    ff.on('error', (err) => {
      log.error('mixer: ffmpeg spawn failed:', err.message);
    });

    ff.on('exit', (code, signal) => {
      const wasOnline = this.online;
      this.online = false;
      this._stopPacer();
      this.ffmpeg = null;
      if (this.stopped) return;
      log.error(`mixer: ffmpeg умер (code=${code} signal=${signal})${errBuf ? ' | ' + errBuf.split('\n').pop() : ''}`);
      if (wasOnline) this.startedAt = null;
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    const delay = Math.min(MIN_BACKOFF_MS * 2 ** this.attempts, MAX_BACKOFF_MS);
    this.attempts += 1;
    log.info(`mixer: переподключение через ${delay / 1000}s`);
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _startPacer() {
    const silence = Buffer.alloc(CHUNK_BYTES);
    this.pacer = setInterval(() => {
      const ff = this.ffmpeg;
      if (!ff || ff.stdin.destroyed) return;
      let chunk = null;
      try {
        chunk = this.feederProgram ? this.feederProgram.readChunk() : null;
      } catch (err) {
        log.error('mixer: ошибка feeder, перехожу на тишину:', err.message);
        chunk = null;
      }
      const buf = chunk && chunk.length === CHUNK_BYTES ? chunk : silence;
      ff.stdin.write(buf);
    }, TICK_MS);
    this.pacer.unref?.();
  }

  _stopPacer() {
    if (this.pacer) {
      clearInterval(this.pacer);
      this.pacer = null;
    }
  }

  _teardown() {
    this._stopPacer();
    if (this.ffmpeg) {
      try {
        this.ffmpeg.stdin.end();
        this.ffmpeg.kill('SIGKILL');
      } catch { /* уже мёртв */ }
      this.ffmpeg = null;
    }
    this.online = false;
  }
}

module.exports = { Mixer, CHUNK_BYTES, BYTES_PER_SEC };
