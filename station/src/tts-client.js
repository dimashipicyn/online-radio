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
function wavToRaw(wavPath, rawPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', wavPath,
      '-f', 's16le', '-ar', '44100', '-ac', '2',
      '-y', rawPath,
    ]);
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg wav->raw exit ${code}`))));
  });
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
    const bytes = fs.statSync(rawPath).size;
    log.info(`tts: вставка ${kind} готова (${(bytes / 176400).toFixed(1)}s): «${text.slice(0, 60)}...»`);
    return { id, kind, text, speaker, path: rawPath, bytes };
  } catch (e) {
    log.error(`tts: вставка ${kind} не удалась: ${e.message}`);
    return null;
  }
}

/** WAV-файл -> сырой PCM-буфер s16le 44.1k stereo. */
function wavFileToRawBuffer(wavPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', wavPath,
      '-f', 's16le', '-ar', '44100', '-ac', '2',
      '-y', 'pipe:1',
    ]);
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.on('error', reject);
    ff.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg wav->raw exit ${code}`))
    );
  });
}

const LINE_GAP_BYTES = Math.round(176400 * 0.45); // пауза 450мс между репликами

/**
 * Диалоговая вставка: каждая реплика озвучивается своим голосом,
 * между репликами пауза, всё склеивается в один raw-файл.
 * lines: [{speaker: 'dj'|'caller', text}]
 */
async function prepareDialogueInsert(lines) {
  const id = crypto.randomBytes(5).toString('hex');
  const rawPath = path.join(INSERT_DIR, `${id}.raw`);
  const parts = [];
  const gap = Buffer.alloc(LINE_GAP_BYTES);
  try {
    for (let i = 0; i < lines.length; i++) {
      const speaker = lines[i].speaker === 'dj' ? config.dj.speaker : config.dj.callerSpeaker;
      const wav = await synthesize(lines[i].text, speaker);
      const tmp = path.join(INSERT_DIR, `${id}_${i}.wav`);
      fs.writeFileSync(tmp, wav);
      const pcm = await wavFileToRawBuffer(tmp);
      fs.unlinkSync(tmp);
      parts.push(pcm, gap);
    }
    const raw = Buffer.concat(parts);
    fs.writeFileSync(rawPath, raw);
    const text = lines.map((l) => `${l.speaker === 'dj' ? 'DJ' : 'Звонящий'}: ${l.text}`).join(' | ');
    log.info(`tts: диалоговая вставка готова (${(raw.length / 176400).toFixed(1)}s, реплик ${lines.length})`);
    return { id, kind: 'call', text, speaker: 'dialogue', path: rawPath, bytes: raw.length };
  } catch (e) {
    log.error(`tts: диалог не удался: ${e.message}`);
    try { fs.existsSync(rawPath) && fs.unlinkSync(rawPath); } catch { /* ок */ }
    throw e;
  }
}

module.exports = { prepareInsert, prepareDialogueInsert };
