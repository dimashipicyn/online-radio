'use strict';

const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { listAudio, probe } = require('./player');
const log = require('./logger');

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.ogg', '.oga', '.m4a', '.wav', '.opus', '.aac']);
const JINGLE_MAX_SEC = 25;

let scanning = false;

/** Скан /music: новые/изменённые файлы — ffprobe, пропавшие — из базы. */
async function scan(musicDir) {
  if (scanning) return;
  scanning = true;
  try {
    const files = listAudio(musicDir, AUDIO_EXTS);
    const seen = new Set();
    const getStmt = db.prepare('SELECT id, mtime, duration FROM tracks WHERE path=?');
    const insStmt = db.prepare(
      `INSERT INTO tracks(path,title,artist,album,duration,category,mtime) VALUES(?,?,?,?,?,?,?)`
    );
    const updStmt = db.prepare(
      `UPDATE tracks SET title=?,artist=?,album=?,duration=?,category=?,mtime=? WHERE id=?`
    );

    let added = 0, updated = 0;
    for (const file of files) {
      seen.add(file);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const mtime = Math.floor(st.mtimeMs);
      const row = getStmt.get(file);
      if (row && row.mtime === mtime && row.duration > 0) continue;
      try {
        const meta = await probe(file);
        if (!meta.duration || meta.duration <= 0) {
          log.warn(`library: пропуск невалидного файла (duration=0): ${file}`);
          if (row) {
            db.prepare('DELETE FROM tracks WHERE id=?').run(row.id);
          }
          continue;
        }
        const category =
          file.toLowerCase().includes(`${path.sep}jingle`) ||
          (meta.duration > 0 && meta.duration <= JINGLE_MAX_SEC)
            ? 'jingle'
            : 'music';
        if (!row) {
          insStmt.run(file, meta.title || prettify(file), meta.artist, meta.album, meta.duration, category, mtime);
          added++;
        } else {
          updStmt.run(meta.title || prettify(file), meta.artist, meta.album, meta.duration, category, mtime, row.id);
          updated++;
        }
      } catch (e) {
        log.warn(`library: ffprobe не осилил ${file}: ${e.message}`);
      }
    }

    const del = db.prepare('DELETE FROM tracks WHERE path NOT IN (' + files.map(() => '?').join(',') + ') OR path NOT LIKE ?');
    if (files.length) del.run(...files, `${musicDir}%`);
    else db.prepare('DELETE FROM tracks').run();

    const total = db.prepare('SELECT COUNT(*) c FROM tracks').get().c;
    if (added || updated) log.info(`library: скан готов — всего ${total} (новых ${added}, обновлено ${updated})`);
    else log.info(`library: скан готов — ${total} треков, без изменений`);
  } finally {
    scanning = false;
  }
}

function prettify(file) {
  return path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').trim();
}

/**
 * Честная ротация: случайно из 30% наименее недавно игравших.
 * jingles=false — только музыка.
 */
function nextTrack({ category = 'music' } = {}) {
  const track = peekTrack({ category });
  if (!track) return null;
  db.prepare('UPDATE tracks SET play_count=play_count+1 WHERE id=?').run(track.id);
  return track;
}

/** Посмотреть следующий трек, не трогая статистику ротации. */
function peekTrack({ category = 'music' } = {}) {
  const rows = db
    .prepare(
      `SELECT * FROM tracks 
        WHERE category=? AND duration > 0
        ORDER BY (last_played IS NULL) DESC, RANDOM() 
        LIMIT 50`
    )
    .all(category);
  if (!rows.length) return null;
  const pool = rows.slice(0, Math.max(1, Math.ceil(rows.length * 0.3)));
  return { ...pool[Math.floor(Math.random() * pool.length)] };
}

function markPlayed(trackId) {
  db.prepare('UPDATE tracks SET last_played=? WHERE id=?').run(Date.now(), trackId);
}

function history(limit = 10) {
  return db
    .prepare(
      `SELECT h.title, h.artist, h.played_at FROM history h ORDER BY h.id DESC LIMIT ?`
    )
    .all(limit);
}

function logHistory(track) {
  db.prepare('INSERT INTO history(track_id,title,artist,played_at) VALUES(?,?,?,?)').run(
    track.id,
    track.title,
    track.artist,
    Date.now()
  );
  markPlayed(track.id);
}

const EN_TO_RU = {
  q:'й', w:'ц', e:'у', r:'к', t:'е', y:'н', u:'г', i:'ш', o:'щ', p:'з', '[':'х', ']':'ъ',
  a:'ф', s:'ы', d:'в', f:'а', g:'п', h:'р', j:'о', k:'л', l:'д', ';':'ж', "'":'э',
  z:'я', x:'ч', c:'с', v:'м', b:'и', n:'т', m:'ь', ',':'б', '.':'ю'
};
const RU_TO_EN = Object.fromEntries(Object.entries(EN_TO_RU).map(([k, v]) => [v, k]));

const LAT_TO_CYR = [
  ['shch', 'щ'], ['yo', 'ё'], ['zh', 'ж'], ['ch', 'ч'], ['sh', 'ш'],
  ['yu', 'ю'], ['ya', 'я'], ['ts', 'ц'], ['kh', 'х'],
  ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'],
  ['z', 'з'], ['i', 'и'], ['j', 'й'], ['k', 'к'], ['l', 'л'], ['m', 'м'],
  ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'],
  ['u', 'у'], ['f', 'ф'], ['y', 'ы']
];

const CYR_TO_LAT = [
  ['щ', 'shch'], ['ё', 'yo'], ['ж', 'zh'], ['ч', 'ch'], ['ш', 'sh'],
  ['ю', 'yu'], ['я', 'ya'], ['ц', 'ts'], ['х', 'kh'],
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['д', 'd'], ['е', 'e'],
  ['з', 'z'], ['и', 'i'], ['й', 'y'], ['к', 'k'], ['л', 'l'], ['м', 'm'],
  ['н', 'n'], ['о', 'o'], ['п', 'p'], ['р', 'r'], ['с', 's'], ['т', 't'],
  ['у', 'u'], ['ф', 'f'], ['ы', 'y'], ['э', 'e'], ['ь', ''], ['ъ', '']
];

function alternateQueries(query) {
  const s = String(query || '').trim().toLowerCase();
  if (!s) return [];
  const set = new Set();

  // 1. Ошибочная раскладка клавиатуры
  const toRu = s.split('').map((c) => EN_TO_RU[c] || c).join('');
  if (toRu !== s) set.add(toRu);
  const toEn = s.split('').map((c) => RU_TO_EN[c] || c).join('');
  if (toEn !== s) set.add(toEn);

  // 2. Транслитерация
  let cyr = s;
  for (const [lat, c] of LAT_TO_CYR) cyr = cyr.replaceAll(lat, c);
  if (cyr !== s) set.add(cyr);
  let lat = s;
  for (const [c, l] of CYR_TO_LAT) lat = lat.replaceAll(c, l);
  if (lat !== s) set.add(lat);

  return [...set];
}

function searchByTokens(q, limit) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const clauses = words.map(() => "(ru_lower(title) LIKE ? OR ru_lower(artist) LIKE ? OR ru_lower(album) LIKE ?)");
  const params = [];
  for (const w of words) {
    const p = `%${w}%`;
    params.push(p, p, p);
  }
  const sql = `
    SELECT id, title, artist, album, duration
    FROM tracks
    WHERE category='music' AND duration > 0 AND ${clauses.join(' AND ')}
    ORDER BY play_count ASC, title ASC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, limit);
}

function search(query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];
  const max = Math.min(50, Math.max(1, Number(limit) || 20));

  const seen = new Set();
  const results = [];

  // Прямой поиск
  const primary = searchByTokens(q, max);
  for (const t of primary) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      results.push(t);
    }
  }

  // Если мало результатов — проверяем альтернативные варианты (раскладка и транслит)
  if (results.length < max) {
    const alts = alternateQueries(q);
    for (const alt of alts) {
      if (results.length >= max) break;
      const extra = searchByTokens(alt, max - results.length);
      for (const t of extra) {
        if (!seen.has(t.id)) {
          seen.add(t.id);
          results.push(t);
          if (results.length >= max) break;
        }
      }
    }
  }

  return results;
}

function getTrackById(id) {
  return db.prepare('SELECT * FROM tracks WHERE id=?').get(id);
}

module.exports = { scan, nextTrack, peekTrack, markPlayed, history, logHistory, search, getTrackById };
