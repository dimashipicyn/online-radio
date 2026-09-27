'use strict';

const config = require('./config');
const settings = require('./settings');
const log = require('./logger');

let cached = null;
let lastFetch = 0;
const CACHE_MS = 20 * 60 * 1000; // 20 минут

const WEATHER_DESC = {
  0: 'ясно',
  1: 'в основном ясно',
  2: 'переменная облачность',
  3: 'пасмурно',
  45: 'туман',
  48: 'изморозь',
  51: 'лёгкая морось',
  53: 'моросящий дождь',
  55: 'плотная морось',
  61: 'небольшой дождь',
  63: 'дождь',
  65: 'сильный дождь',
  71: 'небольшой снег',
  73: 'снегопад',
  75: 'сильный снегопад',
  77: 'снежная крупа',
  80: 'кратковременный дождь',
  81: 'ливень',
  82: 'шквальный ливень',
  85: 'снегопад с дождём',
  86: 'метель',
  95: 'гроза',
  96: 'гроза с градом',
  99: 'сильная гроза с градом',
};

async function getWeather() {
  if (settings.get('weather.enabled') === false) return null;
  const now = Date.now();
  if (cached && (now - lastFetch < CACHE_MS)) return cached;

  const lat = Number(settings.get('weather.lat')) || config.weather?.lat || 55.7558;
  const lon = Number(settings.get('weather.lon')) || config.weather?.lon || 37.6173;
  const city = settings.get('weather.city') || config.weather?.city || 'Москва';

  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const cur = data.current;
    if (!cur) return cached;

    const temp = Math.round(cur.temperature_2m);
    const code = Number(cur.weather_code);
    const cond = WEATHER_DESC[code] || 'переменчивая погода';
    const tempWord = temp > 0 ? `плюс ${temp}` : temp < 0 ? `минус ${Math.abs(temp)}` : 'ноль';

    cached = {
      city,
      temp,
      tempWord,
      code,
      cond,
      text: `Погода за окном (${city}): ${cond}, ${tempWord} градусов.`,
    };
    lastFetch = now;
    return cached;
  } catch (e) {
    log.warn(`weather: не удалось получить данные (${e.message})`);
    return cached;
  }
}

module.exports = { getWeather };
