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
        const category =
          file.toLowerCase().includes(`${path.sep}jingle`) || meta.duration <= JINGLE_MAX_SEC
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
      `SELECT * FROM tracks WHERE category=? ORDER BY (last_played IS NULL) DESC, last_played ASC LIMIT 50`
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

module.exports = { scan, nextTrack, peekTrack, markPlayed, history, logHistory };
