'use strict';

const config = require('./config');
const log = require('./logger');
const { Mixer } = require('./mixer');
const { createWeb } = require('./web');

const mixer = new Mixer();
mixer.start();

const web = createWeb(() => ({
  mixer: mixer.status(),
  uptimeSec: Math.round(process.uptime()),
  version: '0.1.0-phase1',
}));

web.listen(config.web.port, () => {
  log.info(`web: слушаю :${config.web.port} (GET /health)`);
});

process.on('SIGTERM', () => {
  log.info('SIGTERM — глушу эфир');
  mixer.stop();
  web.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});
process.on('SIGINT', () => {
  mixer.stop();
  process.exit(0);
});
