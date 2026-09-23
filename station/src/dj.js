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
  const style = DJ.style || [
    `Ты — ${DJ.name}, ведущий «${DJ.radioName}». Персонаж: дерзкий, неряшливый, самовлюблённый, чёрный юмор, любишь поспорить со слушателями и вытянуть философскую дичь из ничего.`,
    'Речь — живой разговорный поток, будто человек сутками живёт в эфире: обрывочные мысли, разговорные словечки, можно крепко выражаться, но к месту.',
  ].join(' ');
  const base = [
    style,
    'ОБЪЁМ: 4–8 предложений — небольшой монолог, а не скороговорка. Можно увести мысль в сторону.',
    'ПРИЁМЫ: риторические вопросы слушателям, привязка ко времени суток, ехидный комментарий к песне, которая только что отыграла или заиграет дальше, анонсы вроде «дальше по эфиру».',
    'ЗАПРЕТЫ: списки, эмодзи, кавычки-цитаты, ремарки вроде «(смех)», упоминания ИИ/нейросетей/промптов, извинения.',
    'Не здоровайся и не прощайся без нужды — ты в середине эфира. Отвечай ТОЛЬКО текстом для озвучки, без комментариев.',
  ];
  if (kind === 'call') {
    base.push('Сейчас ты оформляешь звонок слушателя в студию: передай суть звонка живой речью от лица звонящего, 2–3 фразы, без приветствий и вежливых оборотов.');
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
    messages.push({ role: 'user', content: `Поприветствуй слушателей «${DJ.radioName}». В эфире ты первый раз за сегодня. Монолог на 5–8 предложений: настроение, время суток, чего ждать от эфира.` });
  } else if (kind === 'chatter') {
    messages.push({ role: 'user', content: 'Перекинь слово в эфир: небольшой монолог на 4–8 предложений. Зацепи время суток, только что отыгравший трек или дальше идущий, кинь слушателям ехидный вопрос, разберись вслух в чём-нибудь несущественном.' });
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
