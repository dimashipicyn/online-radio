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
    'Речь — живой разговорный поток, будто человек сутками живёт в эфире: обрывочные мысли, разговорные словечки, можно крепко выражаться, но к месту.',
  ].join(' ');
  const base = [
    style,
    'ОБЪЁМ: 8–12 предложений — полноценный монолог минутной давности, а не две фразы. Развивай мысль, уходи в смежные темы, возвращайся.',
    'ПРИЁМЫ: риторические вопросы слушателям, привязка ко времени суток, ехидный комментарий к песне, которая только что отыграла или заиграет дальше, анонсы вроде «дальше по эфиру», внутренние мини-истории.',
    'ЗАПРЕТЫ: списки, эмодзи, кавычки-цитаты, ремарки вроде «(смех)», упоминания ИИ/нейросетей/промптов, извинения.',
    'ДЛЯ ОЗВУЧКИ СИНТЕЗАТОРОМ: числа, даты и время пиши словами («двадцать три процента», «в две тысячи двадцать третьем»), без цифр, латиницы и ссылок. Короткие предложения, запятые и многоточия — по ним синтезатор расставляет паузы.',
    'Не здоровайся и не прощайся без нужды — ты в середине эфира. Отвечай ТОЛЬКО текстом для озвучки, без комментариев.',
  ];
  if (kind === 'call') {
    base.push('Сейчас ты оформляешь ЗВОНОК СЛУШАТЕЛЯ В СТУДИЮ как ДИАЛОГ.');
  }
  return base.join(' ');
}

/** Сценарий диалога «звонящий ↔ Валера» в JSON. Валера начинает и представляет звонящего. ~35–45 секунд эфира. */
/** Достаёт реплики из ответа LLM: сначала целиком, при битом JSON — спасаем отдельные объекты. */
function parseDialogue(raw) {
  const m = raw.match(/\[[\s\S]*\]/);
  const candidate = m ? m[0] : raw;
  try {
    return JSON.parse(candidate);
  } catch { /* хвост обрезан/сломан — спасаем по одной реплике */ }
  const items = [];
  const re = /\{[^{}]*\}/g;
  let mm;
  while ((mm = re.exec(candidate)) !== null) {
    try { items.push(JSON.parse(mm[0])); } catch { /* битую реплику пропускаем */ }
  }
  return items;
}

async function generateDialogue(ctx, call = {}) {
  const who = call.name || 'слушатель';
  const about = call.text ? ` Тема: «${call.text}».` : '';
  const prompt = `${ctx}

Оформи это как ДИАЛОГ звонка в студию. Верни ТОЛЬКО JSON-массив, без markdown и пояснений:
[{"s":"dj","text":"<Валера снимает трубку и представляет звонящего: кто на линии и о чём пойдёт речь, 1-3 фразы>"},{"s":"caller","text":"<реплика звонящего>"},{"s":"dj","text":"<ответ Валеры>"},...]
Правила:
- 5-7 реплик, чередуй dj и caller, ПЕРВЫЙ — dj: Валера представляет звонящего ${who} и тему.${about}
- Реплики живые, разговорные, Валера дерзкий и со стихийным матом, звонящий простым языком
- Числа, даты и время — словами, без цифр и латиницы
- Валера должен развить тему звонка, добавить своё мнение и съязвить
- Суммарно диалог на 35-45 секунд речи`;
  let lastErr = new Error('нет ответа от LLM');
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await ollama.chat(
      [
        { role: 'system', content: personaSystem('call') },
        { role: 'user', content: prompt },
      ],
      { temperature: 1.0, maxTokens: 600 }
    );
    const arr = parseDialogue(raw);
    const lines = arr
      .filter((l) => l && typeof l.text === 'string' && l.text.trim())
      .map((l) => ({ speaker: l.s === 'dj' ? 'dj' : 'caller', text: l.text.trim().slice(0, 400) }))
      .filter((l) => l.text);
    if (lines.length >= 2) {
      // страховка: эфир всегда открывает Валера — представляющий звонящего
      if (lines[0].speaker !== 'dj') {
        const intro = call.text
          ? `На линии ${who}! Про «${call.text}» — давай, выкладывай, слушаю.`
          : `На линии ${who}! Слушаю тебя, давай.`;
        lines.unshift({ speaker: 'dj', text: intro.slice(0, 400) });
        log.info('dj: LLM начал со звонящего — вставил представление от Валеры');
      }
      return lines;
    }
    lastErr = new Error(`пригодных реплик ${lines.length}`);
  }
  throw lastErr;
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
    messages.push({ role: 'user', content: 'Монолог на 8–12 предложений. Зацепи время суток, только что отыгравший трек или дальше идущий, кинь слушателям ехидный вопрос, разберись вслух в чём-нибудь несущественном, расскажи мини-историю.' });
  }
  return ollama.chat(messages, { temperature: 1.0, maxTokens: DJ.maxTokens });
}

/**
 * Готовит голосовую вставку. Возвращает insert | null.
 * kind: greeting | topic | chatter | call
 */
async function prepareBreak({ kind, topic, nextTrack, prevTrack, callerSpeaker, call } = {}) {
  if (!(await ollama.healthy())) {
    log.warn('dj: ollama недоступна, реплика отменена');
    return null;
  }
  try {
    let text = '';
    let insert = null;
    if (kind === 'call') {
      // диалог «звонящий ↔ Валера»: LLM-сценарий -> озвучка каждой реплики своим голосом
      const lines = await generateDialogue(topic, call);
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
      const rate = kind === 'call' ? Number(DJ.callerRate) || 1 : Number(DJ.rate) || 1;
      insert = await prepareInsert({ text, speaker, kind, rate });
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
