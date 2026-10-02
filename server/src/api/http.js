// HTTP API + dashboard (tanpa framework, tanpa dependency).
// Dipakai untuk: dashboard web, streaming media terenkripsi, health check,
// dan (opsional) enrollment API untuk Guard.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../util/logger.js';
import {
  devicesRepo,
  locationsRepo,
  commandsRepo,
  mediaRepo,
  sessionsRepo,
  adminsRepo,
  auditRepo,
  eventsRepo,
} from '../db/repos.js';
import { verifyPassword } from '../crypto/box.js';
import { decryptBuffer } from '../crypto/box.js';
import { bus } from '../eventbus.js';
import { CATALOG } from '../commands/catalog.js';

const log = logger('http');
// File ini berada di server/src/api/, jadi harus naik DUA level untuk mencapai
// server/public. Naik satu level saja menunjuk server/src/public yang tidak ada,
// dan gejalanya redirect berulang ke "/" tanpa explanation.
const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'public',
);
const COOKIE = 'fg_session';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createHttpServer({ dispatcher, hub }) {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const ip = clientIp(req);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');

    try {
      const handled = await route({ req, res, url, ip, dispatcher, hub });
      if (!handled) send(res, 404, { error: 'not found' });
    } catch (e) {
      log.error('request gagal', { url: url.pathname, err: e.message });
      if (!res.headersSent) send(res, 500, { error: 'server error' });
    } finally {
      if (url.pathname.startsWith('/api/')) {
        log.debug('http', {
          m: req.method,
          p: url.pathname,
          st: res.statusCode,
          ms: Date.now() - started,
        });
      }
    }
  });
  return server;
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || '-';
}

/** Token bucket sederhana per IP. */
function rateLimit(limiter, key, max, windowMs) {
  const now = Date.now();
  const e = limiter.get(key);
  if (!e || now > e.reset) {
    limiter.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  e.n++;
  return e.n <= max;
}
const pairLimiter = new Map();
const loginLimiter = new Map();
setInterval(() => {
  const now = Date.now();
  for (const m of [pairLimiter, loginLimiter])
    for (const [k, v] of m) if (now > v.reset) m.delete(k);
}, 60_000).unref?.();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function send(res, code, json, headers = {}) {
  const body = JSON.stringify(json);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
  return true; // penanda "sudah ditangani"
}

async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('payload terlalu besar');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('JSON tidak valid');
  }
}

async function requireSession(req, res) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  const s = await sessionsRepo.get(raw);
  if (!s) {
    send(res, 401, { error: 'unauthorized' });
    return null;
  }
  const admin = await adminsRepo.byId(s.admin_id);
  if (!admin || !admin.is_active) {
    send(res, 401, { error: 'unauthorized' });
    return null;
  }
  return { admin, raw };
}

// --------------------------------------------------------------------------
async function route(ctx) {
  const { req, res, url, ip, dispatcher, hub } = ctx;
  const p = url.pathname;

  // ---- publik: health check (tanpa data sensitif) -----------------------
  if (p === '/healthz') {
    return send(res, 200, {
      ok: true,
      server: config.serverName,
      uptimeSec: Math.round(process.uptime()),
      sessions: hub.stats().sessions,
    });
  }

  // ---- publik: pairing Guard saat pertama kali jalan ---------------------
  // Dipakai setelah Guard ter-install sebagai Device Owner: staff mengetik kode
  // 8 karakter dari kartu onboarding, server membalas device_id + token device.
  if (p === '/api/enroll/pair' && req.method === 'POST') {
    if (!(await rateLimit(pairLimiter, ip, 20, 60_000)))
      return send(res, 429, { error: 'terlalu banyak percobaan pairing dari IP ini' });
    const body = await readJson(req, 2048);
    const code = String(body.code || '');
    const out = await devicesRepo.claimPairCode(code);
    if (!out) {
      await auditRepo.write({
        actor: `pair:${ip}`,
        actorKind: 'device',
        action: 'pair.failed',
        ip,
        ok: false,
      });
      return send(res, 404, { error: 'kode pairing tidak valid atau sudah dipakai' });
    }
    await auditRepo.write({
      actor: `pair:${ip}`,
      actorKind: 'device',
      action: 'pair.ok',
      target: out.deviceId,
      ip,
    });
    return send(res, 200, {
      deviceId: out.deviceId,
      nama: out.nama,
      token: out.token,
      wsUrl: `${config.publicBaseUrl.replace(/^http/, 'ws')}/ws/v1/device`,
      protocol: 'fleetguard.v1',
      heartbeatIntervalMs: config.runtime.heartbeatIntervalMs,
    });
  }

  // ---- login ------------------------------------------------------------
  if (p === '/api/login' && req.method === 'POST') {
    if (!(await rateLimit(loginLimiter, ip, 10, 5 * 60_000)))
      return send(res, 429, { error: 'terlalu banyak percobaan login dari IP ini' });
    const body = await readJson(req, 4096);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const a = await adminsRepo.byUsername(username);
    if (!a || !a.is_active || !verifyPassword(password, a.password_hash)) {
      if (a) await adminsRepo.registerFailedLogin(username);
      await auditRepo.write({
        actor: `dash:${username}`,
        actorKind: 'dashboard',
        action: 'login.failed',
        ip,
        ok: false,
      });
      return send(res, 401, { error: 'kredensial salah' });
    }
    if (a.locked_until && new Date(a.locked_until) > new Date()) {
      return send(res, 429, { error: 'akun terkunci sementara (percobaan terlalu banyak)' });
    }
    const token = await sessionsRepo.create({
      adminId: a.id,
      ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
    });
    await adminsRepo.touchLogin(a.id, ip);
    await auditRepo.write({
      actor: `dash:${username}`,
      actorKind: 'dashboard',
      action: 'login.ok',
      ip,
    });
    return send(res, 200, { ok: true, user: { username: a.username, role: a.role } }, {
      'set-cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${
        config.security.sessionTtlMs / 1000
      }`,
    });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    const s = await requireSession(req, res);
    if (s) await sessionsRepo.destroy(s.raw);
    return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0` });
  }

  if (p === '/api/session' && req.method === 'GET') {
    const s = await requireSession(req, res);
    if (!s) return;
    return send(res, 200, { user: { username: s.admin.username, role: s.admin.role } });
  }

  // ---- API terproteksi ---------------------------------------------------
  if (p.startsWith('/api/')) {
    const s = await requireSession(req, res);
    if (!s) return true;

    if (p === '/api/devices' && req.method === 'GET') {
      const devices = await devicesRepo.all();
      const stat = await devicesRepo.countByStatus();
      const rows = [];
      for (const d of devices) {
        rows.push({
          deviceId: d.device_id,
          nama: d.nama_device,
          statusSewa: d.status_sewa,
          penyewa: d.nama_penyewa,
          policyState: d.policy_state,
          isLocked: !!d.is_locked,
          online: !!d.is_online,
          battery: d.battery_level,
          radius: d.radius_meter,
          geofenceArmed: !!d.geofence_armed,
          lastSeenAt: d.last_seen_at,
          lastLocationTime: d.last_location_time,
          model: d.model,
          androidVersion: d.android_version,
        });
      }
      return send(res, 200, { stat, devices: rows, server: config.serverName });
    }

    const devMatch = p.match(/^\/api\/devices\/([\w.\-]+)$/);
    if (devMatch && req.method === 'GET') {
      const d = await devicesRepo.byId(devMatch[1]);
      if (!d) return send(res, 404, { error: 'device tidak ada' });
      return send(res, 200, {
        device: { ...d, auth_secret_enc: undefined, auth_secret_hash: undefined },
        location: await devicesRepo.lastLocation(d.device_id),
        commands: await commandsRepo.listByDevice(d.device_id, 20),
        events: await eventsRepo.recent(d.device_id, 20),
        media: await mediaRepo.latest(d.device_id, 10),
      });
    }

    const cmdMatch = p.match(/^\/api\/devices\/([\w.\-]+)\/command$/);
    if (cmdMatch && req.method === 'POST') {
      const body = await readJson(req, 8192);
      try {
        const out = await dispatcher.dispatch({
          deviceId: cmdMatch[1],
          type: String(body.type || ''),
          payload: body.payload || {},
          issuedBy: `dash:${s.admin.username}`,
          actorKind: 'dashboard',
        });
        await auditRepo.write({
          actor: `dash:${s.admin.username}`,
          actorKind: 'dashboard',
          action: 'command.issue',
          target: cmdMatch[1],
          detail: { type: body.type },
          ip,
        });
        return send(res, 200, out);
      } catch (e) {
        return send(res, 400, { error: e.message, code: e.code });
      }
    }

    const mediaMatch = p.match(/^\/api\/media\/(\d+)$/);
    if (mediaMatch && req.method === 'GET') {
      const m = await mediaRepo.byId(Number(mediaMatch[1]));
      if (!m) return send(res, 404, { error: 'media tidak ada' });
      try {
        const enc = await fsp.readFile(path.join(config.runtime.mediaDir, m.file));
        const buf = decryptBuffer(enc);
        if (!buf) return send(res, 500, { error: 'gagal dekripsi' });
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': buf.length,
          'cache-control': 'private, max-age=3600',
        });
        return res.end(buf);
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    if (p === '/api/location' && req.method === 'GET') {
      const id = url.searchParams.get('device_id');
      const hours = Math.min(720, Number(url.searchParams.get('hours')) || 24);
      if (!id) return send(res, 400, { error: 'device_id wajib' });
      return send(res, 200, { points: await locationsRepo.recent(id, hours, 1000) });
    }

    if (p === '/api/audit' && req.method === 'GET') {
      return send(res, 200, { rows: await auditRepo.recent(Number(url.searchParams.get('limit')) || 100) });
    }

    if (p === '/api/catalog' && req.method === 'GET') {
      return send(res, 200, { catalog: Object.keys(CATALOG) });
    }

    if (p === '/api/sessions' && req.method === 'GET') {
      if (s.admin.role !== 'superadmin') return send(res, 403, { error: 'butuh superadmin' });
      return send(res, 200, { stats: hub.stats() });
    }

    if (p === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write(':ok\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return true;
    }

    return send(res, 404, { error: 'not found' });
  }

  // ---- statis -----------------------------------------------------------
  if (req.method === 'GET') {
    const rel = p === '/' || p === '/index.html' ? '/dashboard.html' : p;
    const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const body = await fsp.readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(body);
      return true;
    }
    if (rel === '/dashboard.html') {
      res.writeHead(302, { location: '/' });
      return res.end();
    }
  }
  return false;
}

// SSE: dorong perubahan ke dashboard.
const sseClients = new Set();
bus.on('device-status', () => push('status'));
bus.on('device-online', (d) => push('online', d));
bus.on('device-offline', (d) => push('offline', d));
bus.on('device-event', (d) => push('event', d));
bus.on('device-location', (d) => push('location', d));
bus.on('command-update', (d) => push('command', d));
bus.on('media', (d) => push('media', d));
function push(type, data = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}
