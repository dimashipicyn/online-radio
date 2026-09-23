'use strict';

const http = require('http');

function createWeb(getStatus) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/health') {
      const st = getStatus();
      const ok = st.mixer.online;
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', ...st }));
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>${'Радио'}</title></head>
<body style="font-family:sans-serif;background:#111;color:#eee;text-align:center;padding-top:15vh">
<h1>ðŸ“» Станция работает</h1>
<p>Эфир: этап 1 — тишина. Веб-интерфейс появится на этапе 5.</p>
<p><code>GET /health</code> — статус</p>
</body></html>`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return server;
}

module.exports = { createWeb };
