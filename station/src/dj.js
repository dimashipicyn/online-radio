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
    'Речь — матерный поток сознания, будто сутками живёшь в эфире: обрывочные мысли, разговорные словечки.',
    'Мат — обязательная часть твоей речи, но ТОЧНЫЙ и В ТЕМУ: нахуй, пиздец, сука, блядь, хуйня, ебать — как эмоциональный акцент, 1-2 мата на предложение, ЧЕРЕДУЙ разные — не лепи «блядь» после каждой запятой. Никакой каши из мата подряд и мата ради мата — он у тебя дорогой, как перец: куда высыплешь много — всё испортишь.',
    'Образец твоей речи (держи этот уровень и дозировку всегда): «Врубаем KRS One — My Philosophy, и это, блядь, вечная классика — старая школа, от которой мурашки. Не врубайтесь в философию, тут всё проще: слушайте внимательно, сука, каждая строчка — про вас. Кто не понял — перечитайте, я не повторяю.»',
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

// мусор из схем/инструкций не должен звучать в эфире
const META_RE = /[<>]|"(?:s|text)"\s*:|\bJSON\b|схем|массив|фраз|ремарк|описание/i;

// structured outputs: массив реплик {s, text} — модель физически не сможет выдать невалидный JSON
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

// пул вступлений Валеры — рандом на каждый звонок, чтобы не звучало по шаблону
const INTRO_TEMPLATES = [
  (n, t) => `Так-так, вижу входящий! ${n} на линии. ${t} — ну ты загнал, конечно. Давай, подробности!`,
  (n, t) => `Опа, живой звонок! ${n}, здарова. ${t}? Слышал-слышал — рассказывай, народ ждёт!`,
  (n, t) => `Але-але, кто тут у нас? ${n}! И сразу к делу — ${t}. Ну красавчик, вали всё как есть!`,
  (n, t) => `Смотрите-ка, прорвался таки в эфир! ${n} в студии. Тема — ${t}. Удиви меня, я весь внимание.`,
  (n, t) => `Ба-а, какие люди! ${n} собственной персоной! ${t} — ну ты и загнул. Говори, эфир резиновый!`,
  (n, t) => `Звонок принят, эфир продолжается! ${n}, приветствую. ${t} — звучит перспективно, не томи!`,
  (n, t) => `О-о, да у нас горячая линия! ${n} на проводе. ${t} — жёстко ты зашёл, но мне нравится. Вали!`,
  (n, t) => `Тут такое... ${n} звонит! И не с пустыми руками: ${t}. Ну, поехали, удивляй!`,
  (n, t) => `Что за день! Сначала это, теперь ещё и ${n} звонит. ${t}? Ладно, красавчик, выкладывай!`,
  (n, t) => `Внимание, луна в зените — ${n} дозвонился! ${t} — тема жирная, распаковывай!`,
];

const MOODS = [
  'Валера сегодня полусонный и раздражённый — говорит вяло, но ехидно',
  'Валера на веселе — ржёт, шутит и гонит по полной',
  'Валера-философ: накручивает глубокий смысл из любой ерунды',
  'Валера в ударе пафосного шоумена — анонсирует так, будто ведёт премию',
  'Валера подозрительно добродушный — но всё равно ехидно подкалывает',
  'Валера уставший циник — всё его бесит, но в тему звонка всё равно влезет',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function introLine(call) {
  const n = call.name || 'слушатель';
  const t = call.text ? `«${String(call.text).slice(0, 80)}»` : 'тема свободная';
  return pick(INTRO_TEMPLATES)(n, t);
}

function cleanLine(raw) {
  let t = String(raw).trim();
  t = t.replace(/[<>«»„“”"]/g, '');
  // срезаем сценические ремарки перед двоеточием: «Валера снимает трубку и говорит: ...»
  t = t.replace(/^[^:]{0,80}?(снимает трубку|представляет звонящего|представляет|в эфире звонит)[^:]*:\s*/i, '');
  t = t.trim();
  if (!t || META_RE.test(t)) return '';
  return t.slice(0, 400);
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
  const linesCount = 4 + Math.floor(Math.random() * 4); // 4-7
  const prompt = `${ctx}

Смоделируй ЗВОНОК В СТУДИЮ как JSON-массив реплик. Верни ТОЛЬКО массив, без пояснений. Форма (содержание придумай своё — не копируй пример):
[{"s":"caller","text":"Привет, Валера! Вот у меня история..."},
 {"s":"dj","text":"Ну надо же, конечно! И что дальше было?"}]
Правила:
- ${linesCount} реплик, строгая очерёдность: ПЕРВАЯ — caller (${who} здоровается и говорит свою тему), дальше Валера, потом снова звонящий...
- ВСТУПЛЕНИЕ НЕ НУЖНО: Валеру представляет система — сразу начинай с первой реплики звонящего
- В text — ТОЛЬКО слова, которые звучат в эфире: без ремарок и описаний (никаких «снимает трубку», «представляет»), без угловых скобок и имён полей
- Реплики живые, разговорные, Валера дерзкий и со стихийным матом, звонящий ${who} простым языком
- Числа, даты и время — словами, без цифр и латиницы
- Валера развивает тему звонка, добавляет своё мнение и съязвляет
- Суммарно диалог на 35-45 секунд речи
- Настроение сцены: ${pick(MOODS)}`;
  let lastErr = new Error('нет ответа от LLM');
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await ollama.chat(
      [
        { role: 'system', content: personaSystem('call') },
        { role: 'user', content: prompt },
      ],
      { temperature: 1.0, maxTokens: 600, format: DIALOGUE_FORMAT }
    );
    const arr = parseDialogue(raw);
    let lines = arr
      .filter((l) => l && typeof l.text === 'string' && l.text.trim())
      .map((l) => ({ speaker: l.s === 'dj' ? 'dj' : 'caller', text: cleanLine(l.text) }))
      .filter((l) => l.text);
    if (lines.length >= 2) {
      // вступление делает система из своих шаблонов — попытки модели представиться выкидываем
      if (lines[0].speaker === 'dj') {
        lines.shift();
        log.info('dj: LLM начал с представления — выкинул, вставил своё из пула');
      }
      lines.unshift({ speaker: 'dj', text: introLine(call) });
      // голоса строго по позиции: чётные реплики — dj, нечётные — звонящий
      lines = lines.map((l, i) => ({ ...l, speaker: i % 2 === 0 ? 'dj' : 'caller' }));
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
    messages.push({ role: 'user', content: `Подводка к следующему треку: назови, что прозвучит дальше — «${ctx.match(/Дальше прозвучит: «(.+?)»/)?.[1] || 'трек'}» — и расскажи о нём: ожидание, ассоциация, ехидный комментарий, можно вспомнить только что отыгравший трек и кинуть слушателям вопрос. 6-10 предложений.` });
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
