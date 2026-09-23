'use strict';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

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
  ollama: { host: process.env.OLLAMA_HOST || 'http://ollama:11434', model: process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct-q4_K_M' },
  tts: { host: process.env.TTS_HOST || 'http://tts:8001' },
  dj: {
    name: process.env.DJ_NAME || 'Валера',
    radioName: process.env.RADIO_NAME || 'Радио Слом',
  },
  paths: { music: '/music', data: '/data' },
};

if (!config.icecast.password) {
  console.error('[config] ICECAST_SOURCE_PASSWORD не задан — стрим не поднимется');
}

module.exports = config;
