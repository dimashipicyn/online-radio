'use strict';

/**
 * Живые настройки эфира.
 * Дефолты приходят из config (env), переопределения лежат в sqlite (kv 'settings')
 * и применяются прямо в конфиг на лету, без рестарта. GUI крутит их через /api/settings.
 */

const { kvGet, kvSet } = require('./db');
const config = require('./config');

const VOICES = ['aidar', 'baya', 'kseniya', 'eugene', 'xenia'];

const SCHEMA = [
  { key: 'dj.name',          type: 'text',     group: 'Голос и DJ', label: 'Имя DJ' },
  { key: 'dj.radioName',     type: 'text',     group: 'Голос и DJ', label: 'Название радио' },
  { key: 'dj.style',         type: 'textarea', group: 'Голос и DJ', label: 'Стиль персонажа (пусто — стандартный Валера)' },
  { key: 'dj.speaker',       type: 'select',   group: 'Голос и DJ', label: 'Голос DJ', options: VOICES },
  { key: 'dj.rate',          type: 'number',   group: 'Голос и DJ', label: 'Темп речи DJ (1 = норма)', min: 0.5, max: 2, step: 0.05 },
  { key: 'dj.enabled',       type: 'bool',     group: 'Голос и DJ', label: 'Вставки DJ включены' },
  { key: 'dj.chatterChance', type: 'number',   group: 'Голос и DJ', label: 'Шанс болтовни между треками', min: 0, max: 1, step: 0.05 },
  { key: 'dj.leadSec',       type: 'number',   group: 'Голос и DJ', label: 'Готовить реплику за N сек до конца трека', min: 5, max: 120, step: 1 },
  { key: 'dj.maxTokens',     type: 'number',   group: 'Голос и DJ', label: 'Потолок токенов на монолог', min: 100, max: 2000, step: 50 },

  { key: 'dj.callerSpeaker', type: 'select',   group: 'Звонящие',   label: 'Голос звонящего', options: VOICES },
  { key: 'dj.callerRate',    type: 'number',   group: 'Звонящие',   label: 'Темп речи звонящего (1 = норма)', min: 0.5, max: 2, step: 0.05 },

  { key: 'music.enabled',    type: 'bool',     group: 'Музыка',     label: 'Музыка в эфире' },
  { key: 'audio.musicVolume', type: 'number',  group: 'Музыка',     label: 'Громкость музыки (1 = норма)', min: 0, max: 1.5, step: 0.05 },

  { key: 'audio.loudnessTarget', type: 'number', group: 'Звук',     label: 'Громкость голоса, LUFS', min: -30, max: -10, step: 1 },
  { key: 'audio.maxGainDb',      type: 'number', group: 'Звук',     label: 'Предел нормализации, дБ', min: 2, max: 15, step: 1 },
  { key: 'audio.highpass',       type: 'number', group: 'Звук',     label: 'Highpass, Гц (0 — выкл)', min: 0, max: 200, step: 10 },
  { key: 'audio.lowpass',        type: 'number', group: 'Звук',     label: 'Lowpass, Гц (20000 — выкл)', min: 4000, max: 20000, step: 500 },
  { key: 'audio.deesser',        type: 'number', group: 'Звук',     label: 'Деэссер (0 — выкл)', min: 0, max: 1, step: 0.05 },
  { key: 'audio.gapMinMs',       type: 'number', group: 'Звук',     label: 'Пауза в диалогах, мин (мс)', min: 100, max: 1500, step: 25 },
  { key: 'audio.gapMaxMs',       type: 'number', group: 'Звук',     label: 'Пауза в диалогах, макс (мс)', min: 100, max: 1500, step: 25 },

  { key: 'ollama.model',     type: 'text',     group: 'Система',    label: 'Модель Ollama' },
];

// путь 'dj.speaker' -> {obj, prop} внутри config
function resolve(key) {
  const parts = key.split('.');
  const obj = parts.slice(0, -1).reduce((o, p) => (o ? o[p] : undefined), config);
  const prop = parts[parts.length - 1];
  return obj && typeof obj === 'object' && prop in obj ? { obj, prop } : null;
}

function get(key) {
  const r = resolve(key);
  return r ? r.obj[r.prop] : undefined;
}

function values() {
  const out = {};
  for (const s of SCHEMA) out[s.key] = get(s.key);
  return out;
}

function coerce(s, v) {
  if (s.type === 'bool') return v === true || /^(1|true|yes|on)$/i.test(String(v));
  if (s.type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`«${s.label}»: не число`);
    return Math.min(s.max, Math.max(s.min, n));
  }
  const str = String(v ?? '');
  if (s.type === 'select' && !s.options.includes(str)) {
    throw new Error(`«${s.label}»: допустимо ${s.options.join(', ')}`);
  }
  return str;
}

function applyOverride(key, value) {
  const r = resolve(key);
  if (r) r.obj[r.prop] = value;
}

let defaults = null; // снимок env-дефолтов для сброса

function savedMap() {
  try { return JSON.parse(kvGet('settings', '{}')) || {}; } catch { return {}; }
}

function init() {
  defaults = values();
  const saved = savedMap();
  let n = 0;
  for (const [k, v] of Object.entries(saved)) {
    const s = SCHEMA.find((x) => x.key === k);
    if (!s) continue;
    try { applyOverride(k, coerce(s, v)); n++; } catch { /* битое значение — игнор */ }
  }
  if (n) console.log(`[settings] применено переопределений из БД: ${n}`);
}

function set(patch) {
  const applied = {};
  const saved = savedMap();
  for (const [key, value] of Object.entries(patch || {})) {
    const s = SCHEMA.find((x) => x.key === key);
    if (!s) throw new Error(`неизвестная настройка: ${key}`);
    const v = coerce(s, value);
    applyOverride(key, v);
    saved[key] = v;
    applied[key] = v;
  }
  kvSet('settings', JSON.stringify(saved));
  return applied;
}

function reset() {
  kvSet('settings', '{}');
  for (const s of SCHEMA) {
    if (defaults && s.key in defaults) applyOverride(s.key, defaults[s.key]);
  }
}

function getAll() {
  return { schema: SCHEMA, values: values() };
}

module.exports = { init, get, set, reset, getAll, values };
