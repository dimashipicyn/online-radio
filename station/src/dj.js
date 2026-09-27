'use strict';

const config = require('./config');
const settings = require('./settings');
const ollama = require('./ollama');
const kb = require('./kb');
const { prepareInsert, prepareDialogueInsert, prepareCoHostDialogueInsert } = require('./tts-client');
const { db } = require('./db');
const log = require('./logger');
const weather = require('./weather');

const DJ = config.dj;

const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

async function broadcastTimeContext() {
  const now = new Date();
  const day = DAYS[now.getDay()];
  const h = now.getHours();
  const m = String(now.getMinutes()).padStart(2, '0');
  let period = 'ночь';
  if (h >= 5 && h < 12) period = 'утро';
  else if (h >= 12 && h < 18) period = 'день';
  else if (h >= 18 && h < 23) period = 'вечер';

  let vibe = '';
  if (now.getDay() === 5 && h >= 16) vibe = 'Конец рабочей недели, вечер пятницы — время расслабиться и слушать музыку.';
  else if (now.getDay() === 6) vibe = 'Суббота — главный выходной недели, полный отрыв.';
  else if (now.getDay() === 0 && h >= 17) vibe = 'Воскресный вечер — завершение выходных, завтра понедельник.';
  else if (now.getDay() === 1 && h < 13) vibe = 'Утро понедельника — все сонные и раскачиваются.';

  let weatherText = '';
  try {
    const w = await weather.getWeather();
    if (w && w.text) weatherText = w.text;
  } catch { /* игнорируем ошибку погоды */ }

  return `День недели: ${day}. Время суток: ${period} (${h}:${m}). ${vibe} ${weatherText}`.trim();
}

function timeOfDay() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'утро';
  if (h >= 12 && h < 18) return 'день';
  if (h >= 18 && h < 23) return 'вечер';
  return 'ночь';
}

const recentSpeeches = [];
const MAX_RECENT_SPEECHES = 4;

function recordSpeech(text) {
  if (!text) return;
  const snippet = text.slice(0, 150).replace(/\s+/g, ' ').trim();
  recentSpeeches.push(snippet);
  if (recentSpeeches.length > MAX_RECENT_SPEECHES) recentSpeeches.shift();
}

const FEMALE_NAMES = new Set([
  'анна', 'аня', 'алена', 'алёна', 'алина', 'алиса', 'анастасия', 'настя', 'ангелина',
  'валентина', 'валя', 'валерия', 'лера', 'василиса', 'вера', 'вероника', 'виктория', 'вика',
  'галина', 'галя', 'дарья', 'даша', 'диана', 'евгения', 'женя', 'екатерина', 'катя', 'елена', 'лена',
  'елизавета', 'лиза', 'жанна', 'инна', 'ирина', 'ира', 'кристина', 'ксения', 'ксюша', 'лариса',
  'любовь', 'люба', 'людмила', 'люда', 'маргарита', 'рита', 'марина', 'мария', 'маша', 'милана',
  'надежда', 'надя', 'наталья', 'наташа', 'нелли', 'нина', 'оксана', 'ольга', 'оля', 'полина',
  'светлана', 'света', 'софия', 'соня', 'тамара', 'тома', 'татьяна', 'таня', 'ульяна', 'юлия', 'юля', 'яна'
]);

const MALE_NAMES_WITH_A = new Set([
  'саша', 'женя', 'ваня', 'дима', 'коля', 'миша', 'паша', 'вова', 'лёша', 'леша', 'илья', 'никита', 'данила', 'серёжа', 'сережа'
]);

function pickCallerVoice(name, genderHint, djSpeaker) {
  const norm = String(name || '').trim().toLowerCase().split(/\s+/)[0];
  let isFemale = false;

  if (genderHint === 'female') isFemale = true;
  else if (genderHint === 'male') isFemale = false;
  else {
    if (FEMALE_NAMES.has(norm)) isFemale = true;
    else if (MALE_NAMES_WITH_A.has(norm)) isFemale = false;
    else if (norm.endsWith('а') || norm.endsWith('я')) isFemale = true;
    else isFemale = false;
  }

  if (isFemale) {
    const femaleVoices = ['kseniya', 'baya', 'xenia'];
    return femaleVoices[Math.floor(Math.random() * femaleVoices.length)];
  } else {
    if (djSpeaker === 'eugene') return 'aidar';
    if (djSpeaker === 'aidar') return 'eugene';
    return Math.random() < 0.5 ? 'aidar' : 'eugene';
  }
}

/**
 * Гарантирует, что текст завершается законченным предложением с точкой/знаком,
 * а не обрывается на полуслове (например, если модель упёрлась в лимит токенов).
 */
function ensureCompletedThought(raw) {
  if (!raw) return '';
  let t = String(raw).trim();
  t = t.replace(/[:;,—–-]+$/, '').trim();

  // Если заканчивается точкой, восклицательным или вопросительным знаком:
  if (/[.!?…]$/.test(t)) {
    return t;
  }

  // Ищем последнее законченное предложение
  const match = t.match(/^(.*[.!?…])\s+[^.!?…]*$/s);
  if (match && match[1] && match[1].length >= 25) {
    return match[1].trim();
  }

  // Если завершающего знака не было, аккуратно закрываем точкой
  return t + '.';
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
    'ОБЪЁМ: 5–8 законченных предложений — бодрый цельный радио-выход на 30–45 секунд. Развивай мысль, но держи плотный темп.',
    'ЗАВЕРШЁННОСТЬ: ВСЕГДА договаривай каждую мысль до конца! Последнее предложение обязано иметь логический финал и заканчиваться точкой, восклицательным или вопросительным знаком. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО обрывать фразу на полуслове.',
    'ПРИЁМЫ: риторические вопросы слушателям («А вы как думали?», «Серьёзно?»), привязка ко времени суток, ехидный комментарий к песне, которая только что отыграла или заиграет дальше, анонсы вроде «дальше по эфиру», внутренние мини-истории.',
    'ЖИВАЯ РЕЧЬ И ИНТОНАЦИИ: Пиши живым разговорным языком! Чередуй короткие и длинные фразы. Активно используй тире («—») и многоточия («...») для естественных пауз и вздохов, восклицания и вопросы — по ним синтезатор речи меняет высоту голоса и перестаёт звучать как монотонный робот.',
    'ЗАПРЕТЫ: списки, эмодзи, кавычки-цитаты, ремарки вроде «(смех)», упоминания ИИ/нейросетей/промптов, извинения.',
    'ДЛЯ ОЗВУЧКИ СИНТЕЗАТОРОМ: числа, даты и время пиши словами («двадцать три процента», «в две тысячи двадцать третьем»), без цифр, латиницы и ссылок. Короткие предложения, запятые и многоточия — по ним синтезатор расставляет паузы.',
    'Не здоровайся и не прощайся без нужды — ты в середине эфира. Отвечай ТОЛЬКО текстом для озвучки, без комментариев.',
  ];
  if (kind === 'call') {
    base.push('Сейчас ты оформляешь ЗВОНОК СЛУШАТЕЛЯ В СТУДИЮ как ДИАЛОГ.');
  } else if (kind === 'news') {
    base.push('Сейчас ты ведёшь ВЫПУСК НОВОСТЕЙ на радиостанции.');
    base.push('Твоя задача — рассказать главные новости слушателям в своём фирменном стиле: иронично, метко, с сарказмом и подколками, без унылого официоза.');
    base.push('Пересказывай суть своими словами, связывай новости между собой и в конце выпуска бодро перекидывай мостик к музыке.');
  } else if (kind === 'request') {
    base.push('Сейчас ты объявляешь ЗАКАЗ ТРЕКА ОТ СЛУШАТЕЛЯ из «Стола заказов».');
    base.push('Твоя задача — назвать имя слушателя, обыграть или зачитать его пожелание/привет, метко и с юмором прокомментировать заказанную песню и объявить её выход в эфир.');
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

const DUO_DIALOGUE_FORMAT = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      s: { type: 'string', enum: ['dj', 'cohost'] },
      text: { type: 'string' },
    },
    required: ['s', 'text'],
  },
};

const MOODS = [
  'Валера сегодня полусонный и раздражённый — говорит вяло, но ехидно',
  'Валера на веселе — ржёт, шутит и гонит по полной',
  'Валера-философ: накручивает глубокий смысл из любой ерунды',
  'Валера в ударе пафосного шоумена — анонсирует так, будто ведёт премию',
  'Валера подозрительно добродушный — но всё равно ехидно подкалывает',
  'Валера уставший циник — всё его бесит, но в тему звонка всё равно влезет',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Короткое вступление ведущего: имя и намёк на тему, без зачитывания заявки. */
async function generateIntro(call, mood) {
  const who = call.name || 'слушатель';
  const topic = String(call.text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const system = [
    DJ.style || `Ты — ${DJ.name}, ведущий «${DJ.radioName}». Дерзкий, разговорный, в середине эфира.`,
    'Сейчас одна короткая реплика, не монолог. Мат — не больше одного, и только если в тему.',
    'Отвечай ТОЛЬКО текстом для озвучки, без комментариев.',
  ].join(' ');
  const prompt = `Слушатель ${who} дозвонился. Суть заявки (не зачитывай и не пересказывай целиком, только намёк своими словами): ${topic || 'тема свободная'}.

Напиши реплику, которой ${DJ.name} берёт трубку. Одно или два коротких предложения.
- Назови ${who}.
- Намекни на тему, без цитаты заявки.
- Сразу отдай микрофон, чтобы человек сам рассказал.
- Запрещены штампы: «живой звонок», «горячая линия», «на проводе», «луна в зените», «красавчик», «красавица», «парень», «девушка».
- Не угадывай пол. Без ремарок, кавычек и цифр.
- Настроение: ${mood}`;
  try {
    const raw = await ollama.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.9, maxTokens: 120 }
    );
    const text = cleanLine(raw).replace(/\s+/g, ' ');
    if (text.length >= 12 && text.length <= 280) return text;
    log.warn(`dj: вступление мимо формата (${text.length} симв.), беру запасное`);
  } catch (e) {
    log.warn(`dj: вступление не сгенерилось: ${e.message}`);
  }
  return `${who} на линии. Давай, говори.`;
}

function cleanLine(raw) {
  let t = String(raw).trim();
  t = t.replace(/[<>«»„“”"]/g, '');
  // срезаем сценические ремарки перед двоеточием: «Валера снимает трубку и говорит: ...»
  t = t.replace(/^[^:]{0,80}?(снимает трубку|представляет звонящего|представляет|в эфире звонит|говорит)[^:]*:\s*/i, '');
  t = t.trim();
  if (!t || META_RE.test(t)) return '';
  if (t.length > 500) {
    t = ensureCompletedThought(t.slice(0, 500));
  } else {
    t = ensureCompletedThought(t);
  }
  return t;
}

/** Первая реплика звонящего — почти дословно из формы, не пересказ модели. */
function callerOpening(call) {
  const who = String(call.name || '').trim();
  let text = String(call.text || '').replace(/\s+/g, ' ').trim().replace(/[<>]/g, '');
  if (!text) return who ? `Привет, это ${who}.` : 'Привет, я на линии.';
  const hasName = who && text.toLowerCase().includes(who.toLowerCase());
  if (!hasName && who) text = `Привет, это ${who}. ${text}`;
  return ensureCompletedThought(text.slice(0, 500));
}

/** Короткая отбивка: закрыть звонок и вернуть эфир, без пересказа темы. */
async function generateOutro(call, mood) {
  const who = call.name || 'слушатель';
  const system = [
    DJ.style || `Ты — ${DJ.name}, ведущий «${DJ.radioName}».`,
    'Одна короткая реплика в эфир. Отвечай только текстом для озвучки.',
  ].join(' ');
  const prompt = `Звонок ${who} уже закончился. Одно короткое предложение: попрощайся и вернись к музыке.
Не пересказывай тему. Без штампов «живой звонок» и «горячая линия». Не угадывай пол. Настроение: ${mood}`;
  try {
    const raw = await ollama.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.8, maxTokens: 80 }
    );
    const text = cleanLine(raw).replace(/\s+/g, ' ');
    if (text.length >= 8 && text.length <= 180) return text;
  } catch (e) {
    log.warn(`dj: отбивка не сгенерилась: ${e.message}`);
  }
  return `Ладно, ${who}, бывай. Дальше музыка.`;
}

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
  const said = callerOpening(call);
  const mood = pick(MOODS);
  const moodPrompt = call.mood ? `Характер звонящего: ${call.mood}. ` : '';
  const linesCount = 3 + Math.floor(Math.random() * 3); // 3-5, первая реплика звонящего уже есть
  const prompt = `${ctx}

Слушатель ${who} УЖЕ сказал в трубку дословно: «${said}»
Смоделируй продолжение звонка как JSON-массив. Первая реплика — реакция ведущего на эти слова, не повтор заявки.
[{"s":"dj","text":"<реакция>"},{"s":"caller","text":"<уточнение своими словами>"},{"s":"dj","text":"<съязвил и закрыл мысль>"}]
Правила:
- ${linesCount} реплик, первая строго dj, дальше строго по очереди caller, dj, caller...
- Не пиши вступление и не прощайся: это сделает система
- Не повторяй заявку дословно
- В text — только слова в эфир, без ремарок и кавычек
- Числа и даты — словами
- ${moodPrompt}Настроение ведущего: ${mood}`;
  let lastErr = new Error('нет ответа от LLM');
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await ollama.chat(
      [
        { role: 'system', content: personaSystem('call') },
        { role: 'user', content: prompt },
      ],
      { temperature: 1.0, maxTokens: 800, format: DIALOGUE_FORMAT }
    );
    const arr = parseDialogue(raw);
    let lines = arr
      .filter((l) => l && typeof l.text === 'string' && l.text.trim())
      .map((l) => ({ speaker: l.s === 'dj' ? 'dj' : 'caller', text: cleanLine(l.text) }))
      .filter((l) => l.text);
    if (lines.length >= 2) {
      if (lines[0].speaker !== 'dj') lines.shift();
      // реакция ведущего, потом звонящий — без переназначения по индексу всего ролика
      lines = lines.map((l, i) => ({ ...l, speaker: i % 2 === 0 ? 'dj' : 'caller' }));
      const [intro, outro] = await Promise.all([
        generateIntro(call, mood),
        generateOutro(call, mood),
      ]);
      return [
        { speaker: 'dj', text: intro, sfx: 'pickup' },
        { speaker: 'caller', text: said },
        ...lines,
        { speaker: 'dj', text: outro },
      ];
    }
    lastErr = new Error(`пригодных реплик ${lines.length}`);
  }
  throw lastErr;
}

/** Разгон дуэта ведущих (Валера + Ксюша): живой юмористический диалог в студии. */
async function generateDuoDialogue(ctx, { topic, nextTrack, prevTrack, newsItems } = {}) {
  const djName = settings.get('dj.name') || config.dj.name || 'Валера';
  const cohostName = settings.get('dj.cohostName') || config.dj.cohostName || 'Ксюша';
  const radioName = settings.get('dj.radioName') || config.dj.radioName || 'Радио Слом';
  const djStyle = settings.get('dj.style') || config.dj.style ||
    `Ты — ${djName}, ведущий «${radioName}». Персонаж: дерзкий, циничный, самовлюблённый, чёрный юмор, любишь развести философию или поныть. Мат — 1-2 на фразу как эмоциональный перец.`;
  const cohostStyle = settings.get('dj.cohostStyle') || config.dj.cohostStyle ||
    `Ты — ${cohostName}, соведущая «${radioName}», напарница ${djName}. Персонаж: острая на язык, саркастичная, приземляет пафос ${djName}, ехидно подкалывает за лень и бред, смеётся с его закидонов.`;

  const system = [
    `Вы — дуэт ведущих в прямом эфире «${radioName}»: ${djName} (роль "dj") и ${cohostName} (роль "cohost").`,
    `Характер ${djName}: ${djStyle}`,
    `Характер ${cohostName}: ${cohostStyle}`,
    'В эфире вы устраиваете живой разгон (юмористический диалог, пинг-понг репликами): цепляетесь за тему, развиваете абсурд, подкалываете друг друга и в конце перекидываете мостик к следующей песне.',
    'КРИТИЧЕСКИ ВАЖНО: Каждая отдельная реплика ДОЛЖНА быть самостоятельным законченным предложением с точкой или знаком на конце. Запрещено обрывать мысль на полуслове или разрывать одно предложение между ведущими.',
    'ПРАВИЛА ОЗВУЧКИ: Все числа, время и даты пиши СЛОВАМИ. Без цифр, без латиницы (названия артистов и треков транскрибируй по-русски).',
    'БЕЗ РЕМАРОК, без смайлов, без скобок («(смеётся)» запрещено), без кавычек-цитат. Только чистый текст для озвучки.',
    'Отвечай ТОЛЬКО в формате JSON-массива реплик: [{"s":"dj","text":"..."},{"s":"cohost","text":"..."},...]',
  ].join(' ');

  const trackCue = nextTrack ? `Дальше прозвучит: «${nextTrack.artist || ''} — ${nextTrack.title}».` : '';
  const prevCue = prevTrack ? `Только что отыграл: «${prevTrack.artist || ''} — ${prevTrack.title}».` : '';

  const prompt = `${ctx}

${prevCue}
${trackCue}

Задача: Напишите разгон между ${djName} и ${cohostName} на 4–6 реплик.
1. ${djName} («dj») начинает с темы, наблюдения или странной мысли.
2. ${cohostName} («cohost») ехидно подхватывает, подкалывает или развивает разгон.
3. Продолжайте пинг-понг по очереди: dj, cohost, dj, cohost...
4. В последней реплике кто-то из ведущих объявляет следующий трек и запускает музыку.
Каждая реплика — 1–3 живых предложения, без воды, ОБЯЗАТЕЛЬНО с точкой на конце. Формат строго JSON.`;

  let lastErr = new Error('нет ответа от LLM');
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await ollama.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.95, maxTokens: 1200, format: DUO_DIALOGUE_FORMAT }
    );
    const arr = parseDialogue(raw);
    let lines = arr
      .filter((l) => l && typeof l.text === 'string' && l.text.trim())
      .map((l) => ({ speaker: l.s === 'cohost' ? 'cohost' : 'dj', text: cleanLine(l.text) }))
      .filter((l) => l.text);

    if (lines.length >= 3) {
      // убеждаемся, что первая реплика dj, и они строго чередуются
      lines = lines.map((l, i) => ({ ...l, speaker: i % 2 === 0 ? 'dj' : 'cohost' }));
      return lines;
    }
    lastErr = new Error(`пригодных реплик ${lines.length}`);
  }
  throw lastErr;
}

/** Сохранение памятки/саммари звонка в базу знаний RAG. */
async function summarizeAndSaveCall(call, lines) {
  if (settings.get('call.saveToKb') === false) return;
  const who = call?.name || 'Слушатель';
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' +
    now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const title = `Звонок: ${who} (${dateStr})`;

  const dialogText = (lines || [])
    .map((l) => `${l.speaker === 'dj' ? DJ.name : who}: ${l.text}`)
    .join('\n');

  let summary = '';
  try {
    const prompt = `Вот расшифровка звонка слушателя в эфир радиостанции:\n${dialogText}\n\nНапиши краткую памятку для ведущего радио (1–2 предложения) от третьего лица: кто звонил, о чём был разговор, что рассказал или о чём поспорил слушатель, и чем закончился диалог. Только факты для памяти ведущего, чтобы вспомнить в будущих эфирах. Без ремарок и кавычек.`;
    const raw = await ollama.chat(
      [
        { role: 'system', content: 'Ты — редактор радиостанции. Пиши краткие информативные выжимки звонков в эфир.' },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.5, maxTokens: 160 }
    );
    summary = String(raw).replace(/\s+/g, ' ').replace(/[«»"]/g, '').trim();
  } catch (e) {
    log.warn(`dj: не удалось сгенерировать саммари звонка: ${e.message}`);
  }

  if (!summary || summary.length < 15) {
    summary = `${who} дозвонился в студию с заявкой: ${call?.text || 'свободная беседа'}. Ведущий ${DJ.name} обсудил тему в эфире.`;
  }

  try {
    await kb.add(title, summary);
    log.info(`dj: саммари звонка «${title}» добавлено в базу знаний: «${summary.slice(0, 80)}...»`);
  } catch (e) {
    log.error(`dj: ошибка сохранения саммари в kb: ${e.message}`);
  }
}

async function buildContext({ topic, nextTrack, prevTrack, newsItems, request } = {}) {
  const timeCtx = await broadcastTimeContext();
  const parts = [timeCtx];
  if (prevTrack) parts.push(`Только что играло: «${prevTrack.artist || 'неизвестный'} — ${prevTrack.title}».`);
  if (nextTrack) parts.push(`Дальше прозвучит: «${nextTrack.artist || 'неизвестный'} — ${nextTrack.title}».`);
  if (topic) parts.push(`Тема от слушателя: «${topic}» — вплети её в реплику.`);
  if (request) {
    const who = request.userName || 'слушатель';
    const msg = request.message ? `Пожелание/привет: «${request.message}»` : 'без особого текста';
    parts.push(`В стол заказов прилетела заявка от слушателя по имени ${who}. ${msg}.`);
  }
  if (newsItems && newsItems.length) {
    parts.push('Свежие новости из ленты для выпуска:');
    for (const [idx, item] of newsItems.entries()) {
      const src = item.feed_name ? ` [источник: ${item.feed_name}]` : '';
      const sum = item.summary ? ` — ${item.summary}` : '';
      parts.push(`${idx + 1}. «${item.title}»${src}${sum}`);
    }
  }
  if (recentSpeeches.length) {
    parts.push(`В прошлых недавних выходах ты уже говорил: «${recentSpeeches.join('» | «')}». Не повторяй эти темы, слова и шутки, придумывай новое.`);
  }
  parts.push('ВАЖНО ДЛЯ ДИКТОРА: Названия треков и артистов с латиницы пиши русской транскрипцией (например: Spice Girls -> Спайс Гёрлз, The Prodigy -> Зе Продиджи), чтобы синтезатор речи не ломал звуки.');
  const cue = topic || (request ? `${request.artist} ${request.title}` : '') || (newsItems && newsItems[0] ? newsItems[0].title : '') || (nextTrack ? `${nextTrack.title} ${nextTrack.artist || ''}` : '');
  if (cue) {
    try {
      const hits = await kb.search(cue);
      if (hits.length) parts.push('Из базы знаний студии (можешь использовать, если в кассу):');
      for (const h of hits) parts.push(`- ${h.title}: ${h.chunk}`);
    } catch { /* kb — не критично */ }
  }
  return parts.join(' ');
}

async function generateText(kind, ctx, { request, nextTrack } = {}) {
  const maxTokens = Math.max(Number(settings.get('dj.maxTokens') || config.dj.maxTokens || 700), 750);
  const messages = [
    { role: 'system', content: personaSystem(kind) },
    { role: 'user', content: ctx },
  ];
  if (kind === 'greeting') {
    messages.push({ role: 'user', content: `Поприветствуй слушателей «${DJ.radioName}». В эфире ты первый раз за сегодня. Монолог на 5–8 предложений: настроение, время суток, чего ждать от эфира, пара историй. ОБЯЗАТЕЛЬНО завершай каждую мысль до конца, ставь точку.` });
  } else if (kind === 'chatter') {
    messages.push({ role: 'user', content: `Подводка к следующему треку: назови, что прозвучит дальше — «${ctx.match(/Дальше прозвучит: «(.+?)»/)?.[1] || 'трек'}» — и расскажи о нём: ожидание, ассоциация, ехидный комментарий, можно вспомнить только что отыгравший трек и кинуть слушателям вопрос. 4-6 предложений. ОБЯЗАТЕЛЬНО закончи мысль финальной фразой и точкой.` });
  } else if (kind === 'news') {
    messages.push({ role: 'user', content: `Проведи короткий выпуск новостей на 6–8 предложений по предоставленной сводке. Начни с бодрого радио-входа («В эфире новости на «${DJ.radioName}»...»), освети новости живо, ехидно и с юмором, перекинь мостик к следующему треку. Без списков и цифр, все числа пиши прописью. ОБЯЗАТЕЛЬНО доведи до конца финальное предложение.` });
  } else if (kind === 'request') {
    const user = request?.userName || 'слушатель';
    const msg = request?.message ? `Пожелание/привет: «${request.message}».` : 'Без пожелания.';
    const trackName = nextTrack ? `«${nextTrack.artist || ''} — ${nextTrack.title}»` : 'следующий трек';
    messages.push({
      role: 'user',
      content: `В эфир поступил заказ из «Стола заказов»! Назови слушателя (${user}), передай привет или обыграй его сообщение (${msg}), дай короткий комментарий к выбранной песне ${trackName} в своём фирменном стиле (с иронией, но с душой) и объяви запуск трека. 4–6 предложений. Числа и даты пиши словами, названия на латинице транскрибируй по-русски. Обязательно закончи фразу точкой.`
    });
  }
  const raw = await ollama.chat(messages, { temperature: 0.95, maxTokens });
  return ensureCompletedThought(raw);
}

/**
 * Готовит голосовую вставку. Возвращает insert | null.
 * kind: greeting | topic | chatter | call | news | request
 */
async function prepareBreak({ kind, topic, nextTrack, prevTrack, callerSpeaker, call, newsItems, request } = {}) {
  if (!(await ollama.healthy())) {
    log.warn('dj: ollama недоступна, реплика отменена');
    return null;
  }
  try {
    let text = '';
    let insert = null;
    if (kind === 'call') {
      // диалог «звонящий ↔ Валера»: LLM-сценарий -> озвучка каждой реплики своим голосом
      const chosenSpeaker = callerSpeaker || pickCallerVoice(call?.name, call?.gender, DJ.speaker);
      const lines = await generateDialogue(topic, call);
      // Асинхронно сохраняем выжимку звонка в базу знаний RAG
      summarizeAndSaveCall(call, lines).catch((err) => log.warn(`dj: ошибка сохранения саммари звонка: ${err.message}`));
      insert = await prepareDialogueInsert(lines, { callerSpeaker: chosenSpeaker });
      text = lines.map((l) => (l.speaker === 'dj' ? '🔧 ' : '📞 ') + l.text).join('\n');
    } else if (kind === 'duo') {
      // разгон дуэта ведущих «Валера + Ксюша»: сценарий в студии -> озвучка каждого своим студийным голосом
      const ctx = await buildContext({ topic, nextTrack, prevTrack, newsItems, request });
      const lines = await generateDuoDialogue(ctx, { topic, nextTrack, prevTrack, newsItems });
      const cohostSpeaker = settings.get('dj.cohostSpeaker') || config.dj.cohostSpeaker || 'kseniya';
      const cohostRate = Number(settings.get('dj.cohostRate') || config.dj.cohostRate || 1.05);
      insert = await prepareCoHostDialogueInsert(lines, { cohostSpeaker, cohostRate });
      const djName = settings.get('dj.name') || config.dj.name || 'Валера';
      const cohostName = settings.get('dj.cohostName') || config.dj.cohostName || 'Ксюша';
      text = lines.map((l) => (l.speaker === 'dj' ? `🎙️ ${djName}: ` : `📻 ${cohostName}: `) + l.text).join('\n');
    } else {
      const ctx = await buildContext({ topic, nextTrack, prevTrack, newsItems, request });
      text = await generateText(kind, ctx, { request, nextTrack });
    }
    // страховка от разросшихся монологов: аккуратно отсекаем по законченным предложениям
    if (!insert) {
      if (text.length > 1400) text = ensureCompletedThought(text.slice(0, 1400));
      else text = ensureCompletedThought(text);
    }
    if (!insert) {
      const speaker = kind === 'call' ? callerSpeaker || DJ.callerSpeaker : DJ.speaker;
      const rate = kind === 'call' ? Number(DJ.callerRate) || 1 : Number(DJ.rate) || 1;
      insert = await prepareInsert({ text, speaker, kind, rate });
    }
    if (insert) {
      insert.text = text || insert.text;
      recordSpeech(insert.text);
    }
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
