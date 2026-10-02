// Klien Telegram Bot API tanpa dependency (global fetch).
// Hanya long-polling getUpdates: tidak perlu domain/port untuk bot.
import { config } from '../config.js';
import { logger } from '../util/logger.js';

const log = logger('tg');

const API = (m) => `https://api.telegram.org/bot${config.telegram.token}/${m}`;

export async function tg(method, body = {}, { timeoutMs = 30_000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const isFile = body && typeof body === 'object' && body.__file;
    const res = await fetch(API(method), {
      method: 'POST',
      signal: ac.signal,
      headers: isFile ? {} : { 'content-type': 'application/json' },
      body: isFile ? body.__file : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({ ok: false, description: 'bad json' }));
    if (!json.ok) {
      const err = new Error(`${method}: ${json.description || res.status}`);
      err.tg = json;
      err.retryAfter = json.parameters?.retry_after;
      throw err;
    }
    return json.result;
  } catch (e) {
    log.debug('tg call gagal', { method, err: e.message });
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const chatId = (id) => (typeof id === 'number' ? id : Number(id));

export const send = (chatIdOrId, text, extra = {}) =>
  tg('sendMessage', {
    chat_id: chatId(chatIdOrId),
    text: String(text).slice(0, 3900),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });

export const reply = (msg, text, extra = {}) =>
  send(msg.chat.id, text, { reply_to_message_id: msg.message_id, ...extra });

export const edit = (chatIdOrId, messageId, text, extra = {}) =>
  tg('editMessageText', {
    chat_id: chatId(chatIdOrId),
    message_id: messageId,
    text: String(text).slice(0, 3900),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  }).catch((e) => {
    if (/message is not modified/i.test(e.message)) return null;
    throw e;
  });

export const photo = (chatIdOrId, buffer, extra = {}) =>
  tg(
    'sendPhoto',
    {
      chat_id: chatId(chatIdOrId),
      photo: { __file: toForm(buffer, 'photo.jpg') },
      ...extra,
    },
    { timeoutMs: 120_000 },
  );

export const sendLocation = (chatIdOrId, lat, lng, extra = {}) =>
  tg('sendLocation', { chat_id: chatId(chatIdOrId), latitude: lat, longitude: lng, ...extra });

export const document = (chatIdOrId, buffer, filename, extra = {}) =>
  tg(
    'sendDocument',
    {
      chat_id: chatId(chatIdOrId),
      document: { __file: toForm(buffer, filename) },
      ...extra,
    },
    { timeoutMs: 180_000 },
  );

export const answerCb = (cbId, text = '', alert = false) =>
  tg('answerCallbackQuery', { callback_query_id: cbId, text, show_alert: alert }).catch(() => {});

export const deleteMsg = (chatIdOrId, messageId) =>
  tg('deleteMessage', { chat_id: chatId(chatIdOrId), message_id: messageId }).catch(() => {});

export const getMe = () => tg('getMe');
export const setCommands = (commands) => tg('setMyCommands', { commands });
export const getUpdates = (offset, timeoutSec = 40, allowedUpdates = ['message', 'callback_query']) =>
  tg('getUpdates', { offset, timeout: timeoutSec, allowed_updates: allowedUpdates }, { timeoutMs: (timeoutSec + 20) * 1000 });

function toForm(buffer, filename, contentType = 'image/jpeg') {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(buffer)], { type: contentType }), filename);
  return fd;
}

/** Backoff sederhana untuk Telegram API (429 / 5xx). */
export async function withRetry(fn, tries = 4) {
  let delay = 800;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e.retryAfter) {
        await sleep(Math.min(e.retryAfter, 30) * 1000);
        continue;
      }
      if (i === tries - 1) throw e;
      await sleep(delay);
      delay *= 2;
    }
  }
  throw new Error('withRetry gagal');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Potong teks Telegram &cape dari HTML error. */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
