'use strict';

const config = require('./config');
const log = require('./logger');

const OLLAMA = config.ollama;
const CHAT_TIMEOUT = 90_000;

async function healthy() {
  try {
    const r = await fetch(`${OLLAMA.host}/api/tags`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function chat(messages, { temperature = 0.9, maxTokens = 300, format } = {}) {
  const r = await fetch(`${OLLAMA.host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA.model,
      messages,
      stream: false,
      // format: JSON-схема (structured outputs) — модель физически не сможет выдать невалидный JSON
      ...(format ? { format } : {}),
      options: { temperature, num_predict: maxTokens },
    }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT),
  });
  if (!r.ok) throw new Error(`ollama chat ${r.status}`);
  const j = await r.json();
  const text = j.message && j.message.content;
  if (!text) throw new Error('ollama: пустой ответ');
  return text.trim();
}

async function embed(text) {
  const r = await fetch(`${OLLAMA.host}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA.embedModel, prompt: text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`ollama embed ${r.status}`);
  const j = await r.json();
  if (!j.embedding) throw new Error('ollama: нет embedding');
  return j.embedding;
}

module.exports = { healthy, chat, embed, log };
