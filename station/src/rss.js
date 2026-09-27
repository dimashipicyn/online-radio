'use strict';

const crypto = require('crypto');
const { db } = require('./db');
const log = require('./logger');
const settings = require('./settings');

const DEFAULT_FEEDS = [
  { name: 'Хабр Новости', url: 'https://habr.com/ru/rss/news/' },
  { name: 'Лента.ру Главное', url: 'https://lenta.ru/rss/news' },
  { name: 'iXBT Новости IT', url: 'https://www.ixbt.com/export/news.rss' },
  { name: 'DTF Новости', url: 'https://dtf.ru/rss/all' },
];

let pollTimer = null;

function decodeHtml(html) {
  if (!html) return '';
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&hellip;/g, '…')
    .replace(/&bull;/g, '•')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code < 65536 ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code < 65536 ? String.fromCharCode(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  let content = m[1].trim();
  const cdata = content.match(/<!\[CDATA\[([\s\S]*?)\]\]>/i);
  return cdata ? cdata[1] : content;
}

function extractLink(xml) {
  const hrefMatch = xml.match(/<link[^>]+href=["']([^"']+)["']/i);
  if (hrefMatch) return hrefMatch[1];
  return extractTag(xml, 'link');
}

/**
 * Парсер RSS 2.0 и Atom фидов.
 * Возвращает { title, items: [{ title, link, summary, guid, pubDate }] }
 */
function parseFeed(xmlText) {
  const channelTitle = decodeHtml(extractTag(xmlText, 'title'));
  const items = [];
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;

  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const rawTitle = extractTag(block, 'title');
    const title = decodeHtml(rawTitle);
    if (!title) continue;

    const link = decodeHtml(extractLink(block));
    const rawDesc =
      extractTag(block, 'description') ||
      extractTag(block, 'summary') ||
      extractTag(block, 'content');
    let summary = decodeHtml(rawDesc);
    if (summary.length > 350) {
      summary = summary.slice(0, 350).replace(/\s+\S*$/, '') + '…';
    }

    const rawGuid = extractTag(block, 'guid') || extractTag(block, 'id');
    let guid = decodeHtml(rawGuid) || link;
    if (!guid) {
      guid = crypto.createHash('md5').update(title + link).digest('hex');
    }

    const rawPub =
      extractTag(block, 'pubDate') ||
      extractTag(block, 'published') ||
      extractTag(block, 'dc:date') ||
      extractTag(block, 'updated');
    let pubDate = Date.now();
    if (rawPub) {
      const parsedTime = new Date(rawPub).getTime();
      if (!isNaN(parsedTime) && parsedTime > 0) pubDate = parsedTime;
    }

    items.push({ title, link, summary, guid, pubDate });
  }

  return { title: channelTitle, items };
}

/**
 * Загрузка и разбор отдельного фида.
 */
async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RadioStationBot/1.0; +https://github.com)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const xml = await res.text();
    const parsed = parseFeed(xml);

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO news (feed_id, title, link, summary, pub_date, guid, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `);

    let newCount = 0;
    const now = Date.now();
    const insertMany = db.transaction((items) => {
      for (const it of items) {
        const r = insertStmt.run(feed.id, it.title, it.link, it.summary, it.pubDate, it.guid, now);
        if (r.changes > 0) newCount++;
      }
    });

    insertMany(parsed.items);

    db.prepare(`
      UPDATE rss_feeds
      SET last_fetched_at = ?, last_status = 'ok', error = NULL
      WHERE id = ?
    `).run(now, feed.id);

    log.debug(`rss: фид «${feed.name}» обновлён: ${parsed.items.length} получено, ${newCount} новых`);
    return { id: feed.id, name: feed.name, fetched: parsed.items.length, newCount, ok: true };
  } catch (e) {
    db.prepare(`
      UPDATE rss_feeds
      SET last_fetched_at = ?, last_status = 'error', error = ?
      WHERE id = ?
    `).run(Date.now(), e.message, feed.id);

    log.warn(`rss: ошибка обновления «${feed.name}»: ${e.message}`);
    return { id: feed.id, name: feed.name, ok: false, error: e.message };
  }
}

/**
 * Опрос всех активных фидов и очистка устаревших записей.
 */
async function fetchAllFeeds() {
  const feeds = db.prepare(`SELECT id, url, name, enabled FROM rss_feeds WHERE enabled = 1`).all();
  if (!feeds.length) return { feeds: 0, newCount: 0, results: [] };

  const results = await Promise.all(feeds.map((f) => fetchFeed(f)));
  const totalNew = results.reduce((acc, r) => acc + (r.newCount || 0), 0);

  // Очистка старых новостей: оставляем свежие 300 штук или не старше 5 дней
  try {
    const keepHorizon = Date.now() - 5 * 24 * 3600 * 1000;
    db.prepare(`
      DELETE FROM news
      WHERE status IN ('used', 'discarded')
        AND created_at < ?
    `).run(keepHorizon);
  } catch { /* ок */ }

  log.info(`rss: опрос завершён (${feeds.length} фидов, +${totalNew} новых новостей)`);
  return { feeds: feeds.length, newCount: totalNew, results };
}

function init() {
  // Проверяем наличие дефолтных фидов
  const count = db.prepare(`SELECT COUNT(*) c FROM rss_feeds`).get().c;
  if (count === 0) {
    const insertFeed = db.prepare(`INSERT OR IGNORE INTO rss_feeds (name, url, enabled) VALUES (?, ?, 1)`);
    for (const f of DEFAULT_FEEDS) {
      insertFeed.run(f.name, f.url);
    }
    log.info(`rss: добавлены стандартные RSS-источники (${DEFAULT_FEEDS.length})`);
  }

  // Первый опрос фидов в фоне через 3 секунды после запуска
  setTimeout(() => fetchAllFeeds().catch(() => {}), 3000);

  // Периодический таймер опроса
  startPolling();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  // Проверяем каждую минуту интервал из настроек
  let lastRun = Date.now();
  pollTimer = setInterval(async () => {
    const intervalMin = Number(settings.get('rss.pollIntervalMin')) || 20;
    const intervalMs = Math.max(5, intervalMin) * 60 * 1000;
    if (Date.now() - lastRun >= intervalMs) {
      lastRun = Date.now();
      await fetchAllFeeds().catch((e) => log.error('rss: фоновый опрос не удался: ' + e.message));
    }
  }, 60 * 1000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ----------------- CRUD для UI и API -----------------

function getFeeds() {
  return db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM news n WHERE n.feed_id = f.id) as total_news,
      (SELECT COUNT(*) FROM news n WHERE n.feed_id = f.id AND n.status = 'pending') as pending_news
    FROM rss_feeds f
    ORDER BY f.id ASC
  `).all();
}

async function addFeed({ name, url }) {
  const cleanUrl = String(url || '').trim();
  const cleanName = String(name || '').trim();
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    throw new Error('URL должен начинаться с http:// или https://');
  }
  const feedName = cleanName || cleanUrl.replace(/^https?:\/\//, '').split('/')[0];
  const r = db.prepare(`INSERT INTO rss_feeds (name, url, enabled) VALUES (?, ?, 1)`).run(feedName, cleanUrl);
  const feed = db.prepare(`SELECT * FROM rss_feeds WHERE id = ?`).get(r.lastInsertRowid);
  // Сразу делаем первичный опрос
  fetchFeed(feed).catch(() => {});
  return feed;
}

function deleteFeed(id) {
  db.prepare(`DELETE FROM news WHERE feed_id = ?`).run(id);
  return db.prepare(`DELETE FROM rss_feeds WHERE id = ?`).run(id);
}

function toggleFeed(id, enabled) {
  return db.prepare(`UPDATE rss_feeds SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

function getNews({ limit = 40, status = null } = {}) {
  let query = `
    SELECT n.*, f.name as feed_name
    FROM news n
    LEFT JOIN rss_feeds f ON n.feed_id = f.id
  `;
  const params = [];
  if (status) {
    query += ` WHERE n.status = ? `;
    params.push(status);
  }
  query += ` ORDER BY n.pub_date DESC, n.id DESC LIMIT ? `;
  params.push(Math.min(100, Math.max(1, limit)));
  return db.prepare(query).all(...params);
}

/**
 * Взять до count свежих новостей со статусом 'pending' для выпуска в эфир
 * и пометить их как 'used'.
 */
function takePendingNews(count = 2) {
  const items = db.prepare(`
    SELECT n.*, f.name as feed_name
    FROM news n
    LEFT JOIN rss_feeds f ON n.feed_id = f.id
    WHERE n.status = 'pending'
    ORDER BY n.pub_date DESC, n.id DESC
    LIMIT ?
  `).all(count);

  if (!items.length) return [];

  const updateStmt = db.prepare(`UPDATE news SET status = 'used' WHERE id = ?`);
  for (const it of items) {
    updateStmt.run(it.id);
  }
  return items;
}

function markDiscarded(id) {
  return db.prepare(`UPDATE news SET status = 'discarded' WHERE id = ?`).run(id);
}

function queueNewsToTopic(id) {
  const item = db.prepare(`SELECT * FROM news WHERE id = ?`).get(id);
  if (!item) throw new Error('Новость не найдена');

  db.prepare(`UPDATE news SET status = 'queued' WHERE id = ?`).run(id);

  const topicText = `Новость: ${item.title}${item.summary ? `. ${item.summary}` : ''}`;
  const res = db.prepare(`
    INSERT INTO topics (text, status, created_at)
    VALUES (?, 'pending', ?)
  `).run(topicText.slice(0, 500), Date.now());

  return { ok: true, topicId: res.lastInsertRowid, title: item.title };
}

module.exports = {
  init,
  parseFeed,
  fetchFeed,
  fetchAllFeeds,
  startPolling,
  stopPolling,
  getFeeds,
  addFeed,
  deleteFeed,
  toggleFeed,
  getNews,
  takePendingNews,
  markDiscarded,
  queueNewsToTopic,
};
