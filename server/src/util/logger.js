// Logger JSON-lines ke stdout + file harian. Redaksi secret otomatis.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 20;

// Di mana log ditulis ke console, selain file harian yang selalu jadi catatan
// resmi. Default: semua ke stdout.
//
// Kenapa bukan pemisahan stdout/stderr Unix? Karena deployment utama ini
// Windows. Di PowerShell apa pun yang ditulis ke stderr akan:
//   1. tampil merah dan dianggap error padahal cuma peringatan biasa,
//   2. HILANG dari `node src/index.js > log.txt` karena hanya stdout yang
//      dialihkan - jadi log error tidak ikut ter-backup.
// Set LOG_CONSOLE_DEST=stderr kalau memang butuh pemisahan Unix.
const consoleMode = (process.env.LOG_CONSOLE_DEST || 'stdout').toLowerCase();
const consoleEnabled = String(process.env.LOG_CONSOLE ?? 'true') !== 'false';

function writeConsole(line, level) {
  if (!consoleEnabled) return;
  const toStderr = consoleMode === 'stderr' && (level === 'error' || level === 'warn');
  try {
    (toStderr ? process.stderr : process.stdout).write(line + '\n');
  } catch {
    /* console penuh / stream ditutup: jangan sampai logger mematikan proses */
  }
}

const SECRET_KEYS = /^(.*)(token|secret|password|pepper|key|authorization|cookie|signature|pin)(.*)$/i;
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEYS.test(k)) out[k] = '***';
    else if (v && typeof v === 'object') out[k] = redact(v);
    else if (typeof v === 'string' && v.length > 512) out[k] = v.slice(0, 512) + '…';
    else out[k] = v;
  }
  return out;
}

let stream = null;
let streamDay = '';
function fileStream() {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== streamDay) {
    stream?.end();
    stream = fs.createWriteStream(path.join(config.runtime.logDir, `${day}.log`), { flags: 'a' });
    streamDay = day;
  }
  return stream;
}

function emit(level, scope, msg, data) {
  if (LEVELS[level] < threshold) return;
  const rec = {
    ts: new Date().toISOString(),
    lvl: level.toUpperCase(),
    scope,
    msg,
    ...(data ? { data: redact(data) } : {}),
  };
  const line = JSON.stringify(rec);
  writeConsole(line, level);
  try {
    fileStream().write(line + '\n');
  } catch {
    /* logger tidak boleh mematikan proses */
  }
}

export function logger(scope) {
  return {
    debug: (msg, data) => emit('debug', scope, msg, data),
    info: (msg, data) => emit('info', scope, msg, data),
    warn: (msg, data) => emit('warn', scope, msg, data),
    error: (msg, data) => emit('error', scope, msg, data),
    child: (sub) => logger(`${scope}.${sub}`),
  };
}

export const log = logger('app');
