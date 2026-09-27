'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || '/data';
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'radio.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  title TEXT,
  artist TEXT,
  album TEXT,
  duration REAL DEFAULT 0,
  category TEXT DEFAULT 'music',
  mtime INTEGER DEFAULT 0,
  play_count INTEGER DEFAULT 0,
  last_played INTEGER
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY,
  track_id INTEGER,
  title TEXT,
  artist TEXT,
  played_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT DEFAULT 'pending',  -- pending | used
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kb (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  chunk TEXT NOT NULL,
  vec TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS rss_feeds (
  id INTEGER PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_fetched_at INTEGER,
  last_status TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY,
  feed_id INTEGER,
  title TEXT NOT NULL,
  link TEXT,
  summary TEXT,
  pub_date INTEGER,
  guid TEXT UNIQUE,
  status TEXT DEFAULT 'pending',  -- pending | queued | used | discarded
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_status ON news(status);
CREATE INDEX IF NOT EXISTS idx_news_created_at ON news(created_at);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL,
  user_name TEXT,
  message TEXT,
  status TEXT DEFAULT 'pending',  -- pending | played | discarded
  created_at INTEGER NOT NULL,
  played_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
`);

const kvGet = (key, def = null) => {
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key);
  return row ? row.value : def;
};
const kvSet = (key, value) =>
  db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));

module.exports = { db, kvGet, kvSet };
