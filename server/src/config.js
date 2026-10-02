// Konfigurasi runtime + pemuat .env tanpa dependency.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..'); // folder server/

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
parseEnvFile(path.join(ROOT, '.env'));

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Keyring lokal: dibuat otomatis saat pertama jalan bila env tidak diisi.
const KEYRING = path.join(DATA_DIR, 'keyring.json');
let keyring = {};
if (fs.existsSync(KEYRING)) {
  try {
    keyring = JSON.parse(fs.readFileSync(KEYRING, 'utf8'));
  } catch {
    keyring = {};
  }
}
function ensureKey(name, bytes = 32) {
  if (!keyring[name]) {
    keyring[name] = crypto.randomBytes(bytes).toString('base64');
    fs.writeFileSync(KEYRING, JSON.stringify(keyring, null, 2), { mode: 0o600 });
  }
  return Buffer.from(keyring[name], 'base64');
}
const dataKey = env.DATA_KEY
  ? Buffer.from(env.DATA_KEY, 'base64')
  : ensureKey('dataKey');
if (dataKey.length !== 32) {
  throw new Error('DATA_KEY harus base64 dari tepat 32 byte (AES-256)');
}
const pepper = env.PEPPER ? Buffer.from(env.PEPPER, 'base64') : ensureKey('pepper');

export const config = {
  env: env.NODE_ENV || 'development',
  serverName: env.SERVER_NAME || 'fleet-guard',
  httpPort: num(env.HTTP_PORT, 8787),
  publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${num(env.HTTP_PORT, 8787)}`).replace(/\/+$/, ''),

  telegram: {
    token: env.TELEGRAM_BOT_TOKEN || '',
    adminChatIds: list(env.ADMIN_CHAT_IDS).map(Number).filter(Number.isFinite),
    alertGroupChatId: env.ALERT_GROUP_CHAT_ID ? Number(env.ALERT_GROUP_CHAT_ID) : 0,
  },

  security: {
    dataKey,
    pepper,
    keyringPath: KEYRING,
    sessionTtlMs: num(env.SESSION_TTL_MS, 12 * 3600 * 1000),
    adminPassword: env.ADMIN_PASSWORD || '',
  },

  db: {
    url: env.DATABASE_URL || `sqlite:${path.join(DATA_DIR, 'fleetguard.db')}`,
  },

  runtime: {
    dataDir: DATA_DIR,
    mediaDir: path.resolve(ROOT, env.MEDIA_DIR || path.join('data', 'media')),
    logDir: path.resolve(ROOT, env.LOG_DIR || 'logs'),
    heartbeatIntervalMs: num(env.HEARTBEAT_INTERVAL_MS, 30_000),
    offlineAfterMs: num(env.OFFLINE_AFTER_MS, 90_000),
    queueMaxDepth: num(env.QUEUE_MAX_DEPTH, 40),
    commandDefaultTtlMs: num(env.COMMAND_DEFAULT_TTL_MS, 60_000),
    locationRetentionDays: num(env.LOCATION_RETENTION_DAYS, 180),
    maxWsPayloadBytes: num(env.MAX_WS_PAYLOAD_BYTES, 6 * 1024 * 1024),
    trustProxy: bool(env.TRUST_PROXY, true),
  },

  enrollment: {
    policyName: env.AMAPI_POLICY_NAME || '',
    enrollmentToken: env.AMAPI_ENROLLMENT_TOKEN || '',
    dpcComponent: env.GUARD_DPC_COMPONENT || 'id.acefleet.guard/id.acefleet.guard.GuardDeviceAdminReceiver',
    dpcSignatureSha1: env.GUARD_DPC_SIGNATURE_SHA1 || '',
  },
};

// GUARD_DPC_SIGNATURE_SHA1 masuk ke intent provisioning sebagai
// PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM, yang dibandingkan sebagai hex.
// Format base64 (yang pernah ditulis di dokumen lama) akan ditolak Android
// tanpa pesan yang berguna, jadi format salah dicegat lebih awal di sini.
{
  const raw = String(config.enrollment.dpcSignatureSha1 || '').trim();
  const clean = raw.replace(/[\s:]/g, '');
  const looksHex = /^[0-9a-fA-F]{40}$/.test(clean);
  if (raw && !looksHex) {
    console.warn(
      `[config] GUARD_DPC_SIGNATURE_SHA1 tidak terlihat seperti SHA-1 hex 40 karakter ` +
        `(panjang saat ini ${clean.length}). Nilai yang diberikan: "${raw}". ` +
        `Provisioning device owner akan DITOLAK. Format yang benar: 40 karakter ` +
        `hex tanpa titik, contoh 97157955ba3f3e152f3c936a555f52066d89929b.`,
    );
  }
  config.enrollment.dpcSignatureSha1 = clean.toLowerCase();
}

fs.mkdirSync(config.runtime.mediaDir, { recursive: true });
fs.mkdirSync(config.runtime.logDir, { recursive: true });

export const isProd = config.env === 'production';
