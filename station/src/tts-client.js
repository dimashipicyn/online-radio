'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const config = require('./config');
const log = require('./logger');

const INSERT_DIR = path.join(config.paths.data, 'inserts');
fs.mkdirSync(INSERT_DIR, { recursive: true });

const TTS = config.tts;

const BYTES_PER_SEC = 44100 * 2 * 2; // s16le stereo 44.1k

/** Один прогон ffmpeg: resolve({stdout, stderr}) или reject. */
function ffRun(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    const out = [];
    const err = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', reject);
    ff.on('close', (code) =>
      code === 0
        ? resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() })
        : reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(err).toString().slice(-200)}`))
    );
  });
}

/** Статичная обработка голоса: обрезка тишины по краям, срез гула, страховочный срез ВЧ-звона вокодера, деэссер. */
const VOICE_AF = [
  'silenceremove=start_periods=1:start_threshold=-45dB',
  'highpass=f=70',
  'lowpass=f=9000',
  'deesser=i=0.3',
  'equalizer=f=3500:t=q:w=1.2:g=-1',
  'areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse',
].join(',');

/** POST /tts у сайдкара -> WAV (48k mono). */
async function synthesize(text, speaker) {
  const r = await fetch(`${TTS.host}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, speaker }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return Buffer.from(await r.arrayBuffer());
}

/** WAV -> сырой PCM s16le 44.1k stereo (то, что ест микшер). */
async function wavToRaw(wavPath, rawPath) {
  await ffRun([
    '-hide_banner', '-loglevel', 'error',
    '-i', wavPath,
    '-af', VOICE_AF,
    '-f', 's16le', '-ar', '44100', '-ac', '2',
    '-y', rawPath,
  ]);
}

/** Измеряет интегрированную громкость сырого PCM-файла (s16le 44.1k stereo), LUFS. */
async function measureRawLoudness(rawPath) {
  try {
    const { stderr } = await ffRun([
      '-hide_banner', '-nostats', '-f', 's16le', '-ar', '44100', '-ac', '2',
      '-i', rawPath,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null', '-',
    ]);
    const m = stderr.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const i = Number(JSON.parse(m[0]).input_i);
    return Number.isFinite(i) && i > -70 ? i : null;
  } catch {
    return null;
  }
}

/**
 * Выравнивает громкость ГОТОВОЙ вставки одним линейным гейном до -16 LUFS.
 * Никакой динамики: динамический loudnorm на коротких вставках «дышит» — это и есть шипение.
 */
async function normalizeRaw(rawPath) {
  const inputI = await measureRawLoudness(rawPath);
  if (inputI == null) return;
  const gain = Math.max(-8, Math.min(8, -16 - inputI));
  if (Math.abs(gain) < 0.5) return;
  const tmp = `${rawPath}.norm`;
  await ffRun([
    '-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '44100', '-ac', '2',
    '-i', rawPath,
    '-af', `volume=${gain.toFixed(2)}dB`,
    '-f', 's16le', '-y', tmp,
  ]);
  fs.renameSync(tmp, rawPath);
  log.info(`tts: нормализация вставки ${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`);
}

/**
 * Готовит вставку: текст -> TTS -> raw PCM файл.
 * Возвращает { id, path, text, bytes, speaker } | null (TTS недоступен).
 */
async function prepareInsert({ text, speaker, kind }) {
  const id = crypto.randomBytes(5).toString('hex');
  try {
    const wav = await synthesize(text, speaker);
    const wavPath = path.join(INSERT_DIR, `${id}.wav`);
    const rawPath = path.join(INSERT_DIR, `${id}.raw`);
    fs.writeFileSync(wavPath, wav);
    await wavToRaw(wavPath, rawPath);
    fs.unlinkSync(wavPath);
    await normalizeRaw(rawPath);
    const bytes = fs.statSync(rawPath).size;
    log.info(`tts: вставка ${kind} готова (${(bytes / BYTES_PER_SEC).toFixed(1)}s): «${text.slice(0, 60)}...»`);
    return { id, kind, text, speaker, path: rawPath, bytes };
  } catch (e) {
    log.error(`tts: вставка ${kind} не удалась: ${e.message}`);
    return null;
  }
}

/** WAV-файл -> сырой PCM-буфер s16le 44.1k stereo. */
async function wavFileToRawBuffer(wavPath) {
  const { stdout } = await ffRun([
    '-hide_banner', '-loglevel', 'error',
    '-i', wavPath,
    '-af', VOICE_AF,
    '-f', 's16le', '-ar', '44100', '-ac', '2',
    '-y', 'pipe:1',
  ]);
  return stdout;
}

/** Пауза между репликами диалога: рандом 250–500мс вместо фиксированной — звучит живее. */
function dialogueGapBytes() {
  const ms = 250 + Math.floor(Math.random() * 251);
  const bytes = Math.round((BYTES_PER_SEC * ms) / 1000);
  // ОБЯЗАТЕЛЬНО кратно 4 байтам (сэмпл s16le stereo): нечётный размер сдвигает
  // выравнивание всего последующего PCM и превращает эфир в белый шум
  return Buffer.alloc(bytes - (bytes % 4));
}

/**
 * Диалоговая вставка: каждая реплика озвучивается своим голосом,
 * между репликами пауза, всё склеивается в один raw-файл.
 * lines: [{speaker: 'dj'|'caller', text}]
 */
async function prepareDialogueInsert(lines) {
  const id = crypto.randomBytes(5).toString('hex');
  const rawPath = path.join(INSERT_DIR, `${id}.raw`);
  const parts = [];
  try {
    for (let i = 0; i < lines.length; i++) {
      const speaker = lines[i].speaker === 'dj' ? config.dj.speaker : config.dj.callerSpeaker;
      const wav = await synthesize(lines[i].text, speaker);
      const tmp = path.join(INSERT_DIR, `${id}_${i}.wav`);
      fs.writeFileSync(tmp, wav);
      const pcm = await wavFileToRawBuffer(tmp);
      fs.unlinkSync(tmp);
      parts.push(pcm);
      if (i < lines.length - 1) parts.push(dialogueGapBytes());
    }
    const raw = Buffer.concat(parts);
    fs.writeFileSync(rawPath, raw);
    await normalizeRaw(rawPath);
    const text = lines.map((l) => `${l.speaker === 'dj' ? 'DJ' : 'Звонящий'}: ${l.text}`).join(' | ');
    log.info(`tts: диалоговая вставка готова (${(raw.length / BYTES_PER_SEC).toFixed(1)}s, реплик ${lines.length})`);
    return { id, kind: 'call', text, speaker: 'dialogue', path: rawPath, bytes: raw.length };
  } catch (e) {
    log.error(`tts: диалог не удался: ${e.message}`);
    try { fs.existsSync(rawPath) && fs.unlinkSync(rawPath); } catch { /* ок */ }
    throw e;
  }
}

module.exports = { prepareInsert, prepareDialogueInsert };
