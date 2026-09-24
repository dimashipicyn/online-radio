'use strict';

const config = require('./config');
const ollama = require('./ollama');
const kb = require('./kb');
const { prepareInsert, prepareDialogueInsert } = require('./tts-client');
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
    'Речь — матерный поток сознания: БЛЯДЬ, НАХУЙ, СУКА, ПИЗДЕЦ, ЕБАТЬ, ХУЁВО, БЛЯ — через слово, в каждом предложении, во всех падежах и формах. Без мата ты не строишь ни одной фразы, это твой родной язык и стиль эфира.',
    'Образец твоей речи (держи этот уровень всегда): «Короче, блядь, слушайте сюда, нахуй. Сейчас врубаем сука KRS One — My Philosophy, и это пиздец какой шедевр, а не ваш попсовый мусор, блять. Кто не в теме — иди нахуй, остальным приятного, сука, прослушивания.»',
    'Ритм блатной радиоболтовни: обрывочные мысли, разговорные словечки, будто сутками живёшь в эфире.',
  ].join(' ');
  const base = [
    style,
    'ОБЪЁМ: 8–12 предложений — полноценный монолог минутной давности, а не две фразы. Развивай мысль, уходи в смежные темы, возвращайся.',
    'ПРИЁМЫ: риторические вопросы слушателям, привязка ко времени суток, ехидный комментарий к песне, которая только что отыграла или заиграет дальше, анонсы вроде «дальше по эфиру», внутренние мини-истории.',
    'ЗАПРЕТЫ: списки, эмодзи, кавычки-цитаты, ремарки вроде «(смех)», упоминания ИИ/нейросетей/промптов, извинения.',
    'Не здоровайся и не прощайся без нужды — ты в середине эфира. Отвечай ТОЛЬКО текстом для озвучки, без комментариев.',
  ];
  if (kind === 'call') {
    base.push('Сейчас ты оформляешь ЗВОНОК СЛУШАТЕЛЯ В СТУДИЮ как ДИАЛОГ.');
  }
  return base.join(' ');
}

/** Схема structured outputs: массив реплик диалога, ничего лишнего. */
const DIALOGUE_FORMAT = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      s: { type: 'string', enum: ['caller', 'dj'] },
      text: { type: 'string' },
    },
    required: ['s', 'text'],
  },
};

/** Разбор ответа LLM в массив реплик: schema-режим даёт валидный JSON, но на всякий случай чиним. */
function parseDialogue(raw) {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) return arr;
  } catch { /* ниже — запасной путь */ }
  // достаём реплики по одной: битые пропускаем, целые спасаем
  const out = [];
  for (const m of cleaned.match(/\{[^{}]*\}/g) || []) {
    try {
      const o = JSON.parse(m);
      if (o && typeof o.text === 'string') out.push(o);
    } catch { /* мусор — мимо */ }
  }
  return out;
}

/** Сценарий диалога «звонящий ↔ Валера» в JSON. 4–6 реплик, ~35–45 секунд эфира. */
async function generateDialogue(ctx) {
  const prompt = `${ctx}

Оформи это как ЗВОНОК В СТУДИЮ. Верни ТОЛЬКО JSON-массив, без markdown и пояснений:
[{"s":"dj","text":"<Валера подводит: на линии звонок, интригует темой, но ИМЯ НЕ называет, 1-2 фразы>"},{"s":"caller","text":"<звонящий здоровается и представляется сам, 1-2 фразы>"},{"s":"dj","text":"<ответ Валеры, 1-3 фразы>"}]
Правила:
- 5-7 реплик: ПЕРВАЯ — dj (подводка к звонку), дальше чередуй caller и dj
- Имя звонящего Валера в подводке НЕ говорит — звонящий представится сам
- Реплики живые, разговорные; Валера матерится ЧЕРЕЗ СЛОВО (блядь, нахуй, сука, пиздец, ебать) — в каждой его реплике минимум два мата; звонящий простым языком
- Валера должен развить тему звонка, добавить своё мнение и съязвить
- Суммарно диалог на 35-45 секунд речи`;
  const raw = await ollama.chat(
    [
      { role: 'system', content: personaSystem('call') },
      { role: 'user', content: prompt },
    ],
    { temperature: 1.0, maxTokens: 600, format: DIALOGUE_FORMAT }
  );
  const arr = parseDialogue(raw);
  const lines = arr
    .filter((l) => l && typeof l.text === 'string' && l.text.trim())
    .map((l) => ({ speaker: l.s === 'dj' ? 'dj' : 'caller', text: l.text.trim().slice(0, 400) }))
    .filter((l) => l.text);
  // подводка обязательна: первая реплика — Валера, представляющий звонок
  if (lines.length && lines[0].speaker !== 'dj') {
    lines.unshift({ speaker: 'dj', text: `Так, минутку, тут на линии звонок, ${DJ.radioName} принимает запросы из народа.` });
  }
  if (lines.length < 2) throw new Error('слишком короткий диалог');
  return lines;
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
    messages.push({ role: 'user', content: `Поприветствуй слушателей «${DJ.radioName}». В эфире ты первый раз за сегодня. Монолог на 8–12 предложений: настроение, время суток, чего ждать от эфира, пара историй.` });
  } else if (kind === 'chatter') {
    messages.push({ role: 'user', content: `Подводка к следующему треку: назови, что прозвучит дальше — «${ctx.match(/Дальше прозвучит: «(.+?)»/)?.[1] || 'трек'}» — и расскажи о нём: ожидание, ассоциация, ехидный комментарий, можно вспомнить только что отыгравший трек и кинуть слушателям вопрос. 6-10 предложений.` });
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
    let text = '';
    let insert = null;
    if (kind === 'call') {
      // диалог «звонящий ↔ Валера»: LLM-сценарий -> озвучка каждой реплики своим голосом
      const lines = await generateDialogue(topic);
      insert = await prepareDialogueInsert(lines);
      text = lines.map((l) => (l.speaker === 'dj' ? '🔧 ' : '📞 ') + l.text).join('\n');
    } else {
      const ctx = await buildContext({ topic, nextTrack, prevTrack });
      text = await generateText(kind, ctx);
    }
    // страховка от разросшихся монологов (диалоги уходят своей веткой)
    if (!insert && text.length > 1200) text = text.slice(0, 1200).replace(/\s+\S*$/, '') + '...';
    if (!insert) {
      const speaker = kind === 'call' ? callerSpeaker || DJ.callerSpeaker : DJ.speaker;
      insert = await prepareInsert({ text, speaker, kind });
    }
    if (insert) insert.text = text || insert.text;
    return insert;
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
