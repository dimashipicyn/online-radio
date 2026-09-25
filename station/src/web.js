'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./logger');
const settings = require('./settings');

const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));

const COOKIE = 'sid';
const AUTH_TOKEN = crypto.createHmac('sha256', String(config.adminPassword || '')).update('admin-ok').digest('hex');
const LOGIN_WINDOW = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const CALL_GAP = 45 * 1000;
const fails = new Map(); // ip -> {count, until}
const callHits = new Map(); // ip -> last timestamp

function makeRoutes({ getStatus, program, kb, library, db }) {
  const topics = {
    list: () => db.prepare(`SELECT id,text,status,created_at FROM topics ORDER BY id DESC LIMIT 50`).all(),
    add: (text) => db.prepare(`INSERT INTO topics(text,created_at) VALUES(?,?)`).run(text, Date.now()),
    remove: (id) => db.prepare(`DELETE FROM topics WHERE id=?`).run(id),
  };

  const api = {
    // --- публичное ---
    'POST /api/login': (req, res, body) => {
      const ip = req.socket.remoteAddress || '?';
      const rec = fails.get(ip) || { count: 0, until: 0 };
      if (Date.now() < rec.until) return send(res, 429, { error: 'слишком много попыток, подождите' });
      if (body.password === config.adminPassword) {
        fails.delete(ip);
        res.setHeader('Set-Cookie', `${COOKIE}=${AUTH_TOKEN}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
        return send(res, 200, { ok: true });
      }
      rec.count++;
      if (rec.count >= LOGIN_MAX_FAILS) rec.until = Date.now() + LOGIN_WINDOW;
      fails.set(ip, rec);
      send(res, 403, { error: 'неверный пароль' });
    },

    'GET /api/now': (_req, res) => {
      const st = getStatus();
      const np = program.nowPlaying;
      send(res, 200, {
        radioName: config.dj.radioName,
        live: Boolean(st.mixer && st.mixer.online),
        nowPlaying: np ? { title: np.title || '', artist: np.artist || '' } : null,
      });
    },

    'GET /api/state': (req, res) => {
      const st = getStatus();
      send(res, 200, {
        radioName: config.dj.radioName,
        djName: config.dj.name,
        mixer: st.mixer,
        program: program.status(),
        nowPlaying: program.nowPlaying,
        history: library.history(8),
        tracks: db.prepare(`SELECT COUNT(*) c FROM tracks`).get().c,
      });
    },

    // --- защищённое ---
    'POST /api/topics': (_req, res, body) => {
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'пусто' });
      topics.add(text.slice(0, 500));
      send(res, 200, { ok: true });
    },
    'GET /api/topics': (_req, res) => send(res, 200, { items: topics.list() }),
    'DELETE /api/topics/:id': (_req, res, _body, params) => {
      topics.remove(Number(params.id));
      send(res, 200, { ok: true });
    },

    'POST /api/calls': async (req, res, body) => {
      const ip = req.socket.remoteAddress || '?';
      const last = callHits.get(ip) || 0;
      if (Date.now() - last < CALL_GAP) return send(res, 429, { error: 'подождите немного перед следующим звонком' });
      const text = String(body.text || '').trim();
      if (!text) return send(res, 400, { error: 'пусто' });
      callHits.set(ip, Date.now());
      const ok = await program.makeCall({ name: String(body.name || '').slice(0, 40), text: text.slice(0, 500) });
      if (!ok) callHits.delete(ip);
      send(res, ok ? 200 : 503, { ok, error: ok ? undefined : 'dj/tts недоступен' });
    },

    'GET /api/kb': (_req, res) => send(res, 200, { items: kb.entries() }),
    'POST /api/kb': async (_req, res, body) => {
      const title = String(body.title || '').trim().slice(0, 100);
      const text = String(body.text || '').trim();
      if (!title || !text) return send(res, 400, { error: 'нужны title и text' });
      const chunks = await kb.add(title, text.slice(0, 20000));
      send(res, 200, { ok: true, chunks });
    },
    'DELETE /api/kb/:title': (_req, res, _body, params) => {
      kb.remove(decodeURIComponent(params.title));
      send(res, 200, { ok: true });
    },

    'POST /api/dj': (_req, res, body) => {
      const v = program.setDjEnabled(body.enabled);
      send(res, 200, { enabled: v });
    },

    'GET /api/settings': async (_req, res) => {
      const all = settings.getAll();
      const entry = all.schema.find((s) => s.key === 'ollama.model');
      if (entry) {
        const names = await listOllamaModels().catch(() => null);
        if (names && names.length) {
          entry.type = 'select';
          entry.options = names;
          // если текущая модель недоступна — показываем первую скачанную
          if (!names.includes(all.values['ollama.model'])) all.values['ollama.model'] = names[0];
        }
      }
      send(res, 200, all);
    },
    'POST /api/settings': async (_req, res, body) => {
      try {
        if (body && typeof body['ollama.model'] === 'string') {
          const names = await listOllamaModels().catch(() => null);
          if (names && !names.includes(body['ollama.model'])) {
            return send(res, 400, { error: `такой модели нет в ollama. Доступны: ${names.join(', ')}` });
          }
        }
        const applied = settings.set(body);
        if (applied['music.enabled'] === true) program.kickMusic(); // включили музыку — эфир сразу зазвучит
        send(res, 200, { ok: true, applied });
      } catch (e) { send(res, 400, { error: e.message }); }
    },
    'POST /api/settings/reset': (_req, res) => {
      settings.reset();
      send(res, 200, { ok: true, ...settings.getAll() });
    },
  };

  return { api, topics };
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** Список скачанных моделей ollama; null если недоступен. */
async function listOllamaModels() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${config.ollama.host}/api/tags`, { signal: ctrl.signal });
    const j = await r.json();
    return (j.models || []).map((m) => m.name).filter(Boolean);
  } finally { clearTimeout(t); }
}

function createWeb({ getStatus, program, kb, library, db }) {
  const { api } = makeRoutes({ getStatus, program, kb, library, db });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');

    // --- стрим-прокси на icecast (плеер в UI ест относительный путь) ---
    if (url.pathname === '/radio.mp3') return proxyStream(res);

    if (url.pathname === '/health') {
      const st = getStatus();
      const ok = st.mixer.online;
      return send(res, ok ? 200 : 503, { status: ok ? 'ok' : 'degraded', ...st });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(INDEX_HTML);
    }

    // --- API ---
    if (url.pathname.startsWith('/api/')) {
      const method = req.method.toUpperCase();
      let handler = api[`${method} ${url.pathname}`];
      let params = {};
      if (!handler) {
        for (const key of Object.keys(api)) {
          const [m, pathKey] = key.split(' ');
          if (m !== method || !pathKey.includes(':')) continue;
          const pattern = new RegExp('^' + pathKey.replace(/:[^/]+/g, '([^/]+)') + '$');
          const match = url.pathname.match(pattern);
          if (match) {
            handler = api[key];
            const names = [...pathKey.matchAll(/:([^/]+)/g)].map((x) => x[1]);
            params = Object.fromEntries(names.map((n, i) => [n, match[i + 1]]));
            break;
          }
        }
      }
      if (!handler) return send(res, 404, { error: 'not found' });

      const isPublic = url.pathname === '/api/login'
        || url.pathname === '/api/now'
        || (method === 'POST' && url.pathname === '/api/calls');
      if (!isPublic && req.headers.cookie !== `${COOKIE}=${AUTH_TOKEN}`) {
        return send(res, 401, { error: 'неавторизован' });
      }

      let raw = '';
      req.on('data', (d) => { raw += d; if (raw.length > 1e6) req.destroy(); });
      req.on('end', async () => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { /* ок */ }
        try {
          await handler(req, res, body, params);
        } catch (e) {
          log.error(`web: ${method} ${url.pathname}: ${e.message}`);
          send(res, 500, { error: 'internal' });
        }
      });
      return;
    }

    send(res, 404, { error: 'not found' });
  });

  return server;
}

/** Труба mp3-потока с icecast в клиента. */
function proxyStream(res) {
  const upstream = http.request(
    { host: config.icecast.host, port: config.icecast.port, path: `/${config.icecast.mount}`, method: 'GET' },
    (ur) => {
      res.writeHead(ur.statusCode || 502, {
        'Content-Type': ur.headers['content-type'] || 'audio/mpeg',
        'Cache-Control': 'no-store',
      });
      ur.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) send(res, 502, { error: 'stream unavailable' });
  });
  upstream.end();
}

module.exports = { createWeb };
