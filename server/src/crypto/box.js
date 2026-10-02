// Kriptografi: enkripsi at-rest (AES-256-GCM), hashing token, HMAC, scrypt.
import crypto from 'node:crypto';
import { config } from '../config.js';

const { dataKey, pepper } = config.security;
const VERSION = 'v1';

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

/** Seal string -> "v1:<iv>:<ct>:<tag>" (base64url), dipakai untuk kolom TEXT. */
export function seal(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${b64u(iv)}:${b64u(ct)}:${b64u(tag)}`;
}

/** Inverse dari seal(). Return null bila gagal (data rusak / key beda). */
export function open(sealed) {
  if (!sealed) return null;
  const parts = String(sealed).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const [iv, ct, tag] = parts.slice(1).map(unb64u);
    const d = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function sealJson(obj) {
  return obj === null || obj === undefined ? null : seal(JSON.stringify(obj));
}
export function openJson(sealed, fallback = null) {
  const s = open(sealed);
  if (s === null) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** Media (foto) dienkripsi ke disk: [magic 8 byte][iv][ct][tag] */
export function encryptBuffer(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([Buffer.from('FGENC001', 'ascii'), iv, ct, cipher.getAuthTag()]);
}
export function decryptBuffer(buf) {
  if (!buf || buf.length < 30 || buf.subarray(0, 8).toString('ascii') !== 'FGENC001') return null;
  try {
    const iv = buf.subarray(8, 20);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(20, buf.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    return null;
  }
}

// ---- token & perbandingan aman -------------------------------------------
export function randomToken(bytes = 24) {
  return 'fg_' + crypto.randomBytes(bytes).toString('base64url');
}
export function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
export function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}
/** HMAC dengan pepper server (mencegah token offline-guess dari hash bocor). */
export function peppered(token) {
  return hmacHex(pepper, token);
}
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Challenge-response untuk handshake WebSocket:
 *  deviceTag = hex(hmac_sha256(token, `${nonce}.${deviceId}`))  */
export function deviceTag(token, nonce, deviceId) {
  return hmacHex(Buffer.from(token, 'utf8'), `${nonce}.${deviceId}`);
}

// ---- password admin (scrypt, tanpa dependency native) ---------------------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), dk.toString('base64')].join('$');
}
export function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, saltB64, dkB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(dkB64, 'base64');
    const dk = crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(N) * Number(r) * 2,
    });
    return crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

/** Biru noise untuk membandingkan radius / koordinat terenkripsi tanpa
 *  membocorkan nilai asli ke side-channel query log. */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
