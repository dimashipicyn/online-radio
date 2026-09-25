'use strict';

const config = require('./config');
require('./settings').init(); // env-дефолты + переопределения из БД, до старта эфира
const log = require('./logger');
const { Mixer } = require('./mixer');
const { createWeb } = require('./web');
const library = require('./library');
const kb = require('./kb');
const { Program } = require('./program');

if (!config.adminPassword) {
  log.error('ADMIN_PASSWORD не задан — веб-UI будет недоступен');
}

// --- скан библиотеки: при старте и потом раз в 5 минут ---
library.scan(config.paths.music).catch((e) => log.error('library: ' + e.message));
setInterval(() => library.scan(config.paths.music).catch(() => {}), 5 * 60 * 1000);

// --- kb: дозабивка векторов, если при добавлении ollama спала ---
setInterval(() => kb.backfill().catch(() => {}), 5 * 60 * 1000);

// --- эфир ---
const program = new Program();
const mixer = new Mixer();
mixer.feederProgram = program; // микшер берёт чанки из программы эфира
mixer.start();
program.start();

// --- веб ---
const web = createWeb({
  getStatus: () => ({
    mixer: mixer.status(),
    uptimeSec: Math.round(process.uptime()),
    version: '0.2.0',
  }),
  program,
  kb,
  library,
  db: require('./db').db,
});

web.listen(config.web.port, () => {
  log.info(`web: слушаю :${config.web.port} (UI, /api, /radio.mp3, /health)`);
});

process.on('SIGTERM', () => {
  log.info('SIGTERM — глушу эфир');
  mixer.stop();
  if (program.player) program.player.stop();
  web.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
process.on('SIGINT', () => {
  mixer.stop();
  process.exit(0);
});
