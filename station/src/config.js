'use strict';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const numAny = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

const config = {
  icecast: {
    host: process.env.ICECAST_HOST || 'icecast',
    port: num(process.env.ICECAST_PORT, 8000),
    mount: (process.env.ICECAST_MOUNT || 'radio.mp3').replace(/^\//, ''),
    password: process.env.ICECAST_SOURCE_PASSWORD || '',
    bitrate: num(process.env.AUDIO_BITRATE, 192),
    sampleRate: 44100,
    channels: 2,
  },
  web: { port: num(process.env.WEB_PORT, 3000) },
  music: { enabled: bool(process.env.MUSIC_ENABLED, true) }, // false — спич-режим: эфир без музыки
  adminPassword: process.env.ADMIN_PASSWORD || '',
  ollama: {
    host: process.env.OLLAMA_HOST || 'http://ollama:11434',
    model: process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct-q4_K_M',
    embedModel: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
  },
  tts: { host: process.env.TTS_HOST || 'http://tts:8001' },
  dj: {
    name: process.env.DJ_NAME || 'Валера',
    radioName: process.env.RADIO_NAME || 'Радио Слом',
    speaker: process.env.DJ_SPEAKER || 'eugene',
    callerSpeaker: process.env.CALLER_SPEAKER || 'kseniya', // xenia/baya/aidar у v5 звенят на ВЧ
    enabled: bool(process.env.DJ_ENABLED, true),
    style: process.env.DJ_STYLE || '',              // своё описание персоны (перекрывает дефолт)
    leadSec: num(process.env.DJ_LEAD_SEC, 30),      // за сколько до конца трека готовить реплику
    chatterChance: Number(process.env.DJ_CHATTER_CHANCE ?? 0.4), // шанс болтовни без темы
    maxTokens: num(process.env.DJ_MAX_TOKENS, 400),
    rate: numAny(process.env.DJ_RATE, 1.0),           // темп речи DJ (1 = норма)
    callerRate: numAny(process.env.CALLER_RATE, 1.0), // темп речи звонящего
  },
  audio: { // ручки обработки голоса/эфира — крутятся живо из GUI (панель Настройки)
    loudnessTarget: numAny(process.env.LOUDNESS_TARGET, -16), // LUFS
    maxGainDb: 8,      // предел гейна нормализации
    highpass: 70,      // Гц, 0 = выкл
    lowpass: 9000,     // Гц, страховка от ВЧ-звона вокодера
    deesser: 0.3,      // 0 = выкл
    gapMinMs: 250,     // паузы в диалогах
    gapMaxMs: 500,
    musicVolume: 1.0,  // громкость музыки относительно голоса
    bassWarmth: 1.5,   // тёплота голоса (дБ на 110 Гц) — убирает сухость
    presence: 1,       // чёткость (дБ на 2.7 кГц) — разборчивость без жёсти
    room: 0.1,         // лёгкая комната (эхо) — убирает стерильность
    rnn: false,        // нейро-шумодав arnndn (эксперимент)
  },
  kb: { topK: num(process.env.KB_TOP_K, 3), chunkChars: 600 },
  paths: { music: '/music', data: process.env.DATA_DIR || '/data' },
};

if (!config.icecast.password) {
  console.error('[config] ICECAST_SOURCE_PASSWORD не задан — стрим не поднимется');
}

module.exports = config;
