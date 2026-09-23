'use strict';

const config = require('./config');
const ollama = require('./ollama');
const kb = require('./kb');
const { prepareInsert } = require('./tts-client');
const { db } = require('./db');
const log = require('./logger');

const DJ = config.dj;

function timeOfDay() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'утро';
  if (h >= 12 && h < 18) return 'день';
  if (h >= 18 && h < 23) return 'вечер';
  return 'ночь';
}

function personaSystem(kind) {
  const base = [
    `Ты — ${DJ.name}, ведущий «${DJ.radioName}»: дерзкий, неряшливый, чёрный юмор, споришь с слушателями.`,
    'Говоришь живой устной речью, можно крепко выражаться, но не через слово.',
    'СТИЛЬ: 2–4 коротких предложения, без списков, без эмодзи, без кавычек-цитат, без ремарок вроде «(смех)».',
    'Никогда не пиши название радио в каждом выходе в эфир. Не здоровайся, если не попросили.',
    'Ты в эфире между песнями. Отвечай ТОЛЬКО текстом для озвучки, ничего больше.',
  ];
  if (kind === 'call') {
    base.push('Сейчас ты оформляешь звонок слушателя в студию: передай суть звонка живой речью от лица звонящего, 1–2 предложения, без приветствий и вежливых оборотов.');
  }
  return base.join(' ');
}

async function buildContext({ topic, nextTrack, prevTrack } = {}) {
  const parts = [`Время суток: ${timeOfDay()}.`];
  if (prevTrack) parts.push(`Только что играло: «${prevTrack.artist || 'неизвестный'} — ${prevTrack.title}».`);
  if (nextTrack) parts.push(`Дальше прозвучит: «${nextTrack.artist || 'неизвестный'} — ${nextTrack.title}».`);
  if (topic) parts.push(`Тема от слушателя: «${topic}» — вплети её в реплику.`);
  const cue = topic || (nextTrack ? `${nextTrack.title} ${nextTrack.artist || ''}` : '');
  if (cue) {
    try {
      const hits = await kb.search(cue);
      if (hits.length) parts.push('Из базы знаний студии (можешь использовать, если в кассу):');
      for (const h of hits) parts.push(`- ${h.title}: ${h.chunk}`);
    } catch { /* kb — не критично */ }
  }
  return parts.join(' ');
}

async function generateText(kind, ctx) {
  const messages = [
    { role: 'system', content: personaSystem(kind) },
    { role: 'user', content: ctx },
  ];
  if (kind === 'greeting') {
    messages.push({ role: 'user', content: `Поприветствуй слушателей «${DJ.radioName}». В эфире ты первый раз за сегодня.` });
  } else if (kind === 'chatter') {
    messages.push({ role: 'user', content: 'Перекинь пару слов в эфир: что-нибудь циничное про жизнь, музыку или текущее время суток.' });
  }
  return ollama.chat(messages, { temperature: 1.0, maxTokens: DJ.maxTokens });
}

/**
 * Готовит голосовую вставку. Возвращает insert | null.
 * kind: greeting | topic | chatter | call
 */
async function prepareBreak({ kind, topic, nextTrack, prevTrack, callerSpeaker } = {}) {
  if (!(await ollama.healthy())) {
    log.warn('dj: ollama недоступна, реплика отменена');
    return null;
  }
  try {
    let text;
    if (kind === 'call') {
      // LLM оформляет текст звонка как живую реплику звонящего
      text = await ollama.chat(
        [
          { role: 'system', content: personaSystem('call') },
          {
            role: 'user',
            content: `Звонок в студию: ${topic}. Передай суть одной-двумя фразами живой устной речью от лица звонящего. Без «алло», без приветствий.`,
          },
        ],
        { temperature: 1.0, maxTokens: 120 }
      );
    } else {
      const ctx = await buildContext({ topic, nextTrack, prevTrack });
      text = await generateText(kind, ctx);
    }
    // страховка от разросшихся монологов
    if (text.length > 600) text = text.slice(0, 600).replace(/\s+\S*$/, '') + '...';
    const speaker = kind === 'call' ? callerSpeaker || DJ.callerSpeaker : DJ.speaker;
    return prepareInsert({ text, speaker, kind });
  } catch (e) {
    log.error(`dj: генерация ${kind} упала: ${e.message}`);
    return null;
  }
}

/** Взять тему из очереди и пометить использованной. */
function takeTopic() {
  const row = db
    .prepare(`SELECT id, text FROM topics WHERE status='pending' ORDER BY id ASC LIMIT 1`)
    .get();
  if (!row) return null;
  db.prepare(`UPDATE topics SET status='used' WHERE id=?`).run(row.id);
  return row.text;
}

module.exports = { prepareBreak, takeTopic, timeOfDay };
