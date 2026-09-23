'use strict';

const { db } = require('./db');
const config = require('./config');
const ollama = require('./ollama');
const log = require('./logger');

function chunkText(text, maxLen = config.kb.chunkChars) {
  const paras = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if ((cur + '\n\n' + p).length <= maxLen) {
      cur = cur ? cur + '\n\n' + p : p;
    } else {
      if (cur) chunks.push(cur);
      // очень длинный абзац режем по предложениям
      if (p.length <= maxLen) cur = p;
      else {
        const sentences = p.split(/(?<=[.!?…])\s+/);
        cur = '';
        for (const s of sentences) {
          if ((cur + ' ' + s).length > maxLen) {
            if (cur) chunks.push(cur);
            cur = s;
          } else cur = cur ? cur + ' ' + s : s;
        }
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [text.slice(0, maxLen)];
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Добавить заметку: чанкуем и эмбеддим. Если ollama спит — вектор NULL, дообучим позже. */
async function add(title, text) {
  const chunks = chunkText(text);
  const ins = db.prepare('INSERT INTO kb(title,chunk,vec,created_at) VALUES(?,?,?,?)');
  let withVec = 0;
  for (const chunk of chunks) {
    let vec = null;
    try {
      const e = await ollama.embed(`${title}\n${chunk}`);
      vec = JSON.stringify(e);
      withVec++;
    } catch { /* оллама недоступна — положим без вектора */ }
    ins.run(title, chunk, vec, Date.now());
  }
  log.info(`kb: «${title}» — ${chunks.length} чанков (векторов ${withVec})`);
  return chunks.length;
}

function getVec(row) {
  try { return JSON.parse(row.vec); } catch { return null; }
}

/** Топ-k релевантных чанков под запрос. Без ollama — пусто. */
async function search(query, k = config.kb.topK) {
  const rows = db.prepare('SELECT id,title,chunk,vec FROM kb WHERE vec IS NOT NULL').all();
  if (!rows.length) return [];
  let qvec;
  try { qvec = await ollama.embed(query); } catch { return []; }
  return rows
    .map((r) => ({ row: r, score: cosine(qvec, getVec(r)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => ({ id: x.row.id, title: x.row.title, chunk: x.row.chunk, score: +x.score.toFixed(3) }));
}

/** Дозабивка векторов для записей, добавленных без ollama. */
async function backfill() {
  const rows = db.prepare('SELECT id,title,chunk FROM kb WHERE vec IS NULL').all();
  if (!rows.length) return 0;
  let done = 0;
  const upd = db.prepare('UPDATE kb SET vec=? WHERE id=?');
  for (const r of rows) {
    try {
      const e = await ollama.embed(`${r.title}\n${r.chunk}`);
      upd.run(JSON.stringify(e), r.id);
      done++;
    } catch { return done; }
  }
  if (done) log.info(`kb: дозабито векторов: ${done}`);
  return done;
}

function list() {
  return db
    .prepare('SELECT id, title, COUNT(*) OVER (PARTITION BY title) chunks, MIN(id) OVER (PARTITION BY title) min_id FROM kb')
    .all();
}

function entries() {
  const titles = db.prepare('SELECT DISTINCT title FROM kb ORDER BY created_at DESC').all();
  return titles.map((t) => {
    const row = db.prepare('SELECT COUNT(*) c, SUM(vec IS NOT NULL) v FROM kb WHERE title=?').get(t.title);
    return { title: t.title, chunks: row.c, embedded: row.v === row.c };
  });
}

function remove(title) {
  const r = db.prepare('DELETE FROM kb WHERE title=?').run(title);
  log.info(`kb: удалено «${title}» (${r.changes} чанков)`);
  return r.changes;
}

function count() {
  return db.prepare('SELECT COUNT(*) c FROM kb').get().c;
}

module.exports = { add, search, backfill, entries, remove, count };
