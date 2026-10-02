// Katalog command: satu sumber kebenaran untuk server, bot, dashboard, dan app Guard.
// validate(payload) wajib mengembalikan payload final atau lempar {code, message}.
import { seal, openJson } from '../crypto/box.js';

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const num = (v, { min = -Infinity, max = Infinity, def } = {}) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CommandError('bad_arg', `nilai bukan angka: ${v}`);
  if (n < min || n > max)
    throw new CommandError('bad_arg', `nilai harus ${min}..${max} (dapat ${n})`);
  return n;
};
const str = (v, { maxLen = 500, def = undefined } = {}) => {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v);
  if (s.length > maxLen) throw new CommandError('bad_arg', `teks terlalu panjang (maks ${maxLen})`);
  return s;
};
const bool = (v, def = false) => (v === undefined || v === null ? def : !!v);

/**
 * type            -> definisi perintah
 * ttlMs           -> batas tunggu device meresult
 * requiresOnline  -> kalau device offline, antre (tidak langsung gagal)
 * cooldownSec     -> anti-spam per device
 * destructive     -> butuh konfirmasi 2 langkah di bot
 */
export const CATALOG = {
  // ---- kontrol akses ----------------------------------------------------
  lock: {
    ttlMs: 30_000,
    requiresOnline: true,
    cooldownSec: 3,
    describe: () => 'Kunci layar + suspend semua app selain Guard + matikan kamera',
    validate: (p = {}) => ({ reason: str(p.reason, { maxLen: 120, def: 'perintah admin' }) }),
  },
  unlock: {
    ttlMs: 60_000,
    requiresOnline: true,
    cooldownSec: 3,
    describe: () => 'Buka kunci, PIN baru dikirim ke admin',
    validate: (p = {}) => ({ pinLength: num(p.pinLength, { min: 6, max: 16, def: 8 }) }),
  },
  pin: {
    ttlMs: 30_000,
    requiresOnline: true,
    describe: () => 'Ambil PIN layar kunci saat ini (rahasia, dikirim 1x)',
    validate: () => ({}),
  },
  set_kiosk: {
    ttlMs: 30_000,
    requiresOnline: true,
    describe: () => 'Mode kiosk: hanya app Guard yang bisa dibuka',
    validate: (p = {}) => ({ enabled: bool(p.enabled, true) }),
  },

  // ----sensor -----------------------------------------------------------
  locate: {
    ttlMs: 45_000,
    requiresOnline: true,
    cooldownSec: 2,
    describe: () => 'Ambil lokasi sekali, akurasi tinggi',
    validate: (p = {}) => ({ accuracy: str(p.accuracy, { def: 'high' }) }),
  },
  track_start: {
    ttlMs: 30_000,
    requiresOnline: true,
    describe: () => 'Kirim lokasi terus-menerus (interval dipercepat)',
    validate: (p = {}) => ({
      intervalSec: num(p.intervalSec, { min: 10, max: 3600, def: 60 }),
      untilSec: num(p.untilSec, { min: 60, max: 86400, def: 3600 }),
    }),
  },
  track_stop: { ttlMs: 20_000, requiresOnline: true, describe: () => 'Stop pengiriman lokasi berkala', validate: () => ({}) },
  camera_front: {
    ttlMs: 60_000,
    requiresOnline: true,
    cooldownSec: 5,
    describe: () => 'Foto kamera depan',
    validate: () => ({}),
  },
  camera_rear: {
    ttlMs: 60_000,
    requiresOnline: true,
    cooldownSec: 5,
    describe: () => 'Foto kamera belakang',
    validate: () => ({}),
  },
  ring: {
    ttlMs: 30_000,
    requiresOnline: true,
    cooldownSec: 5,
    describe: () => 'Bunyikan alarmkeras + getarkan',
    validate: (p = {}) => ({ seconds: num(p.seconds, { min: 1, max: 120, def: 20 }) }),
  },
  toast: {
    ttlMs: 20_000,
    requiresOnline: true,
    describe: () => 'Tampilkan pesan di layar penyewa',
    validate: (p = {}) => ({ text: str(p.text, { maxLen: 300, def: 'Hubungi admin' }) }),
  },

  // ---- kebijakan --------------------------------------------------------
  set_geofence: {
    ttlMs: 30_000,
    requiresOnline: false,
    describe: () => 'Set radius geofence (meter), 0 = matikan',
    validate: (p = {}) => ({
      radiusM: num(p.radiusM, { min: 0, max: 100000, def: 150 }),
      armed: bool(p.armed, true),
      anchor: str(p.anchor, { maxLen: 16, def: 'server' }),
    }),
  },
  apply_policy: {
    ttlMs: 45_000,
    requiresOnline: true,
    describe: () => 'Terapkan ulang seluruh DevicePolicyManager (anti-tamper)',
    validate: (p = {}) => ({ full: bool(p.full, true) }),
  },
  restart_app: {
    ttlMs: 45_000,
    requiresOnline: true,
    describe: () => 'Mbunuh & restart proses Guard (self-heal dari server)',
    validate: () => ({}),
  },
  reboot: {
    ttlMs: 30_000,
    requiresOnline: true,
    destructive: true,
    describe: () => 'Reboot perangkat',
    validate: () => ({}),
  },
  wipe: {
    ttlMs: 60_000,
    requiresOnline: true,
    destructive: true,
    describe: () => 'Hapus data aplikasi Guard & kunci total (permanen)',
    validate: (p = {}) => ({ keepEnrollment: bool(p.keepEnrollment, true) }),
  },

  // ---- sinkronisasi konfigurasi (dikirim server otomatis) ---------------
  sync_config: {
    ttlMs: 30_000,
    requiresOnline: true,
    describe: () => 'Kirim konfigurasi terbaru ke device',
    validate: () => ({}),
  },
  sync_now: {
    ttlMs: 45_000,
    requiresOnline: true,
    describe: () => 'Paksa device kirim stokol + lokasi sekarang',
    validate: () => ({}),
  },
};

export function catalogEntry(type) {
  return Object.prototype.hasOwnProperty.call(CATALOG, type) ? CATALOG[type] : null;
}

export function validateCommand(type, payload) {
  const def = catalogEntry(type);
  if (!def) throw new CommandError('unknown_command', `command tidak dikenal: ${type}`);
  return def.validate(payload || {});
}

export function listCatalog() {
  return Object.entries(CATALOG).map(([type, def]) => ({
    type,
    ttlMs: def.ttlMs ?? 60_000,
    requiresOnline: !!def.requiresOnline,
    destructive: !!def.destructive,
    describe: def.describe(),
  }));
}

// Helper dipanggil hub saat memproses hasil device (payload bisa terenkripsi).
export function decodeResult(row) {
  return openJson(row?.result_enc, null);
}
export { seal };
