'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const level = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function line(lvl, msg, ...rest) {
  if (LEVELS[lvl] < level) return;
  const ts = new Date().toISOString().slice(11, 19);
  const extra = rest.length ? ' ' + rest.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join(' ') : '';
  console[lvl === 'debug' ? 'log' : lvl](`[${ts}] [${lvl}] ${msg}${extra}`);
}

module.exports = {
  debug: (...a) => line('debug', ...a),
  info: (...a) => line('info', ...a),
  warn: (...a) => line('warn', ...a),
  error: (...a) => line('error', ...a),
};
