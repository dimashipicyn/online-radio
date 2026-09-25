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
const settings = require('./settings');

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

/** Цепочка обработки голоса, собирается из живых настроек (панель Настройки). */
function voiceAF() {
  const af = ['silenceremove=start_periods=1:start_threshold=-45dB'];
  const hp = Number(settings.get('audio.highpass')) || 0;
  if (hp > 0) af.push(`highpass=f=${hp}`);
  const lp = Number(settings.get('audio.lowpass')) || 0;
  if (lp > 0 && lp < 20000) af.push(`lowpass=f=${lp}`);
  const bass = Number(settings.get('audio.bassWarmth')) || 0;
  if (bass > 0) af.push(`bass=g=${bass}:f=110:w=0.6`);
  const pres = Number(settings.get('audio.presence')) || 0;
  if (pres > 0) af.push(`equalizer=f=2700:t=q:w=1.1:g=${pres}`);
  const de = Number(settings.get('audio.deesser')) || 0;
  if (de > 0) af.push(`deesser=i=${de}`);
  if (settings.get('audio.rnn')) af.push('arnndn=m=/app/bd.rnnn');
  af.push('areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse');
  const room = Number(settings.get('audio.room')) || 0;
  if (room > 0) af.push(`aecho=1:0.9:38|64:${room}|${(room * 0.6).toFixed(2)}`);
  return af.join(',');
}

/** POST /tts у сайдкара -> WAV (48k mono). rate — темп речи (1 = норма). */
async function synthesize(text, speaker, rate = 1.0) {
  const r = await fetch(`${TTS.host}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, speaker, rate: Number(rate) || 1.0 }),
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
    '-af', voiceAF(),
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
 * Выравнивает громкость ГОТОВОЙ вставки одним линейным гейном (без динамики —
 * динамический loudnorm на коротких вставках «дышит» и шипит).
 */
async function normalizeRaw(rawPath) {
  const target = Number(settings.get('audio.loudnessTarget'));
  const maxGain = Number(settings.get('audio.maxGainDb')) || 8;
  const inputI = await measureRawLoudness(rawPath);
  if (inputI == null) return;
  const gain = Math.max(-maxGain, Math.min(maxGain, target - inputI));
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
async function prepareInsert({ text, speaker, kind, rate }) {
  const id = crypto.randomBytes(5).toString('hex');
  try {
    const wav = await synthesize(text, speaker, rate);
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

/** Узкая полоса и лёгкий шум линии — звонящий не должен звучать как второй ведущий. */
function phoneAF() {
  return [
    'silenceremove=start_periods=1:start_threshold=-45dB',
    'highpass=f=300',
    'lowpass=f=3400',
    'acompressor=threshold=-18dB:ratio=3:attack=8:release=80',
    'areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse',
  ].join(',');
}

/** WAV-файл -> сырой PCM-буфер s16le 44.1k stereo. phone — тракт трубки. */
async function wavFileToRawBuffer(wavPath, { phone = false } = {}) {
  const { stdout } = await ffRun([
    '-hide_banner', '-loglevel', 'error',
    '-i', wavPath,
    '-af', phone ? phoneAF() : voiceAF(),
    '-f', 's16le', '-ar', '44100', '-ac', '2',
    '-y', 'pipe:1',
  ]);
  return stdout;
}

function writeStereoSample(buf, i, v) {
  const s = Math.max(-32768, Math.min(32767, v | 0));
  buf.writeInt16LE(s, i * 4);
  buf.writeInt16LE(s, i * 4 + 2);
}

/** Гудок 425 Гц и щелчок снятия трубки, s16le stereo 44.1k. */
function phonePickup() {
  const sr = 44100;
  const tone = (ms, amp) => {
    const n = Math.round(sr * ms / 1000);
    const buf = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 180, (n - i) / 180);
      writeStereoSample(buf, i, Math.sin((2 * Math.PI * 425 * i) / sr) * amp * env * 32767);
    }
    return buf;
  };
  const gap = (ms) => Buffer.alloc(Math.round((BYTES_PER_SEC * ms) / 1000) & ~3);
  const clickN = Math.round(sr * 0.035);
  const click = Buffer.alloc(clickN * 4);
  for (let i = 0; i < clickN; i++) {
    const env = Math.exp(-i / 180);
    writeStereoSample(click, i, (Math.random() * 2 - 1) * env * 9000);
  }
  return {
    ring: Buffer.concat([tone(320, 0.22), gap(160), tone(320, 0.22), gap(90)]),
    open: Buffer.concat([click, gap(160)]),
  };
}

/** Пауза между репликами диалога: рандом в заданных пределах — звучит живее. */
function dialogueGapBytes() {
  let lo = Number(settings.get('audio.gapMinMs')) || 250;
  let hi = Number(settings.get('audio.gapMaxMs')) || 500;
  if (hi < lo) [lo, hi] = [hi, lo];
  const ms = lo + Math.floor(Math.random() * (hi - lo + 1));
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
  const bed = phonePickup();
  const parts = [bed.open];
  try {
    for (let i = 0; i < lines.length; i++) {
      const isDj = lines[i].speaker === 'dj';
      const speaker = isDj ? config.dj.speaker : config.dj.callerSpeaker;
      const rate = isDj ? settings.get('dj.rate') : settings.get('dj.callerRate');
      const wav = await synthesize(lines[i].text, speaker, rate);
      const tmp = path.join(INSERT_DIR, `${id}_${i}.wav`);
      fs.writeFileSync(tmp, wav);
      const pcm = await wavFileToRawBuffer(tmp, { phone: !isDj });
      fs.unlinkSync(tmp);
      parts.push(pcm);
      if (i < lines.length - 1) parts.push(dialogueGapBytes());
    }
    const raw = Buffer.concat([bed.ring, Buffer.concat(parts)]);
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
