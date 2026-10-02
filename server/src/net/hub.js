// Device Hub: satu-satunya pintu masuk device Guard (WebSocket).
//
// Protokol (sub-protokol WSS: "fleetguard.v1"):
//   S->D  {t:'challenge', nonce, serverTime}          (segera setelah connect)
//   D->S  {t:'auth', deviceId, tag}                    tag = hex(HMAC-SHA256(token, nonce+"."+deviceId))
//   S->D  {t:'welcome', deviceId, nama, config}        (auth OK)
//   D->S  {t:'hello', status:{...}}                   laporan lengkap saat connect
//   D->S  {t:'hb', status:{...}}                      heartbeat periodik
//   D->S  {t:'loc', location:{...}}                   update lokasi
//   D->S  {t:'event', event, severity, detail}        tamper / boot / battery / policy drift
//   D->S  {t:'result', cmdId, ok, data|error}         hasil eksekusi command
//   D->S  {t:'media', cmdId, kind, mime, b64, lat?, lng?}  hasil kamera (base64 JPEG)
//   S->D  {t:'cmd', cmdId, type, payload}             perintah (HANYA lewat frame ini)
//   S->D  {t:'ping'} / D->S {t:'pong'}
//
// Token device TIDAK pernah dikirim lewat jaringan; hanya HMAC challenge.
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { logger } from '../util/logger.js';
import { devicesRepo, locationsRepo, mediaRepo, auditRepo, logEvent } from '../db/repos.js';
import { encryptBuffer, distanceMeters } from '../crypto/box.js';
import { bus } from '../eventbus.js';
import { nowIso } from '../db/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const log = logger('hub');
const AUTH_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 20_000;
const PROTOCOL = 'fleetguard.v1';

export class DeviceHub {
  constructor(dispatcher) {
    this.dispatcher = dispatcher;
    /** @type {Map<string, object>} deviceId -> session */
    this.sessions = new Map();
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: config.runtime.maxWsPayloadBytes,
      perMessageDeflate: false, // foto besar; kompresi eats CPU. Keep it simple.
      // Sub-protokol wajib: device yang salah versi langsung ditolak di handshake.
      handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
    });
  }

  attach(httpServer) {
    httpServer.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try {
        pathname = new URL(req.url, 'http://x').pathname;
      } catch {
        socket.destroy();
        return;
      }
      const protos = String(req.headers['sec-websocket-protocol'] || '')
        .split(',')
        .map((s) => s.trim());
      if (pathname !== '/ws/v1/device' || !protos.includes(PROTOCOL)) {
        log.warn('upgrade ditolak', { pathname, protos });
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, req);
      });
    });

    this.pingTimer = setInterval(() => this.sweep(), PING_INTERVAL_MS);
    this.pingTimer.unref?.();

    this.offlineTimer = setInterval(async () => {
      const cutoff = new Date(Date.now() - config.runtime.offlineAfterMs).toISOString();
      const stale = await devicesRepo.onlineStale(cutoff).catch(() => []);
      for (const d of stale) {
        await this.markOffline(d.device_id, 'heartbeat hilang');
      }
    }, 30_000);
    this.offlineTimer.unref?.();
  }

  onConnection(ws, req) {
    const ip =
      (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
      req.socket.remoteAddress ||
      '-';
    const session = {
      ws,
      ip,
      deviceId: null,
      nonce: null,
      authed: false,
      alive: true,
      connectedAt: Date.now(),
    };
    log.info('_ws masuk', { ip });

    const authTimer = setTimeout(() => {
      if (!session.authed) ws.close(4001, 'auth timeout');
    }, AUTH_TIMEOUT_MS);
    session.authTimer = authTimer;

    const nonce = crypto.randomBytes(24).toString('base64url');
    session.nonce = nonce;
    this.send(ws, { t: 'challenge', nonce, serverTime: nowIso() });

    ws.on('pong', () => {
      session.alive = true;
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        log.warn('frame binary unexpected', { deviceId: session.deviceId });
        return;
      }
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        log.warn('json rusak', { deviceId: session.deviceId });
        return;
      }
      // Pesan diproses BERURUTAN per koneksi (rantai promise). Tanpa ini, frame
      // 'auth' yang masih di-await DB bisa membuat frame berikutnya ('hello')
      // dianggap belum terautentikasi.
      session.chain = (session.chain || Promise.resolve())
        .then(() => this.onMessage(session, msg))
        .catch((e) => {
          log.error('onMessage error', { deviceId: session.deviceId, err: e.message });
          this.send(ws, { t: 'error', message: 'server error' });
        });
    });

    ws.on('close', async (code, reason) => {
      clearTimeout(session.authTimer);
      log.info('ws tutup', { deviceId: session.deviceId, code, reason: reason?.toString() });
      if (session.deviceId) {
        if (this.sessions.get(session.deviceId) === session) {
          this.sessions.delete(session.deviceId);
          this.dispatcher.detach(session.deviceId);
          await this.markOffline(session.deviceId, `ws close ${code}`);
        }
      }
    });

    ws.on('error', (e) => log.warn('ws error', { deviceId: session.deviceId, err: e.message }));
  }

  async onMessage(session, msg) {
    if (!session.authed) return this.handleAuth(session, msg);

    switch (msg.t) {
      case 'pong':
        session.alive = true;
        return;
      case 'hello':
        return this.handleHello(session, msg);
      case 'hb':
        return this.handleHeartbeat(session, msg);
      case 'loc':
        return this.handleLocation(session, msg);
      case 'event':
        return this.handleEvent(session, msg);
      case 'result':
        return this.dispatcher.onResult(session.deviceId, msg);
      case 'media':
        return this.handleMedia(session, msg);
      case 'log':
        log.info('device log', { deviceId: session.deviceId, msg: msg.text });
        return;
      default:
        log.warn('tipe pesan tidak dikenal', { t: msg.t, deviceId: session.deviceId });
    }
  }

  async handleAuth(session, msg) {
    if (msg.t !== 'auth') return session.ws.close(4003, 'auth required');
    const { deviceId, tag } = msg;
    if (!deviceId || !tag) return session.ws.close(4003, 'auth kurang');
    if (session.nonce && msg.nonce && msg.nonce !== session.nonce)
      return session.ws.close(4003, 'nonce salah');

    const device = await devicesRepo.verifyAuth(deviceId, String(tag), session.nonce);
    if (!device) {
      await auditRepo.write({
        actor: `device:${deviceId}`,
        actorKind: 'device',
        action: 'auth.failed',
        target: deviceId,
        ip: session.ip,
        ok: false,
      });
      log.warn('auth gagal', { deviceId, ip: session.ip });
      return session.ws.close(4004, 'auth ditolak');
    }

    // Takeover: koneksi lama dicabut supaya tidak ada dua soket untuk 1 device.
    const prev = this.sessions.get(deviceId);
    if (prev && prev !== session) {
      log.info('takeover koneksi lama', { deviceId });
      try {
        prev.ws.close(4001, 'koneksi baru');
      } catch {}
      this.dispatcher.detach(deviceId);
    }

    session.authed = true;
    session.deviceId = deviceId;
    clearTimeout(session.authTimer);
    this.sessions.set(deviceId, session);

    await devicesRepo.update(deviceId, {
      is_online: 1,
      last_seen_at: nowIso(),
      enrolled_at: device.enrolled_at || nowIso(),
    });
    await logEvent(deviceId, 'online', 'info', { ip: session.ip });
    bus.emitSafe('device-online', { deviceId, nama: device.nama_device, at: nowIso() });

    const conn = {
      send: (frame) => this.send(session.ws, frame),
      isOpen: () => session.ws.readyState === 1,
    };
    this.dispatcher.attach(deviceId, conn);

    this.send(session.ws, {
      t: 'welcome',
      deviceId,
      nama: device.nama_device,
      serverTime: nowIso(),
      heartbeatIntervalMs: config.runtime.heartbeatIntervalMs,
      config: await this.deviceConfig(device),
    });
    log.info('auth ok', { deviceId, nama: device.nama_device, ip: session.ip });
  }

  async deviceConfig(device) {
    const rows = await mediaRepo.latest(device.device_id, 1);
    return {
      radiusM: device.radius_meter,
      geofenceArmed: !!device.geofence_armed,
      policyState: device.policy_state,
      statusSewa: device.status_sewa,
      namaDevice: device.nama_device,
      // Watchdog app: 0.5s saat terbuka, 5s saat terkunci (hemat baterai)
      watchdogMsUnlocked: 500,
      watchdogMsLocked: 5000,
      mediaUrl: config.publicBaseUrl,
      latestMediaId: rows[0]?.id || null,
    };
  }

  async handleHello(session, msg) {
    const id = session.deviceId;
    await devicesRepo.heartbeat(id, msg.status || {});
    if (msg.status?.androidId) await devicesRepo.update(id, { android_id: String(msg.status.androidId) });
    if (msg.status?.serial) await devicesRepo.update(id, { serial_number: String(msg.status.serial) });
    if (msg.status?.imei) await devicesRepo.update(id, { imei: String(msg.status.imei) });
    bus.emitSafe('device-status', { deviceId: id });
    this.send(session.ws, {
      t: 'sync',
      config: await this.deviceConfig(await devicesRepo.byId(id)),
    });
  }

  async handleHeartbeat(session, msg) {
    const id = session.deviceId;
    await devicesRepo.heartbeat(id, msg.status || {});
    bus.emitSafe('device-status', { deviceId: id });
    if (msg.pong !== undefined) this.send(session.ws, { t: 'ack', for: 'ping', v: msg.pong });
  }

  async handleLocation(session, msg) {
    const id = session.deviceId;
    const loc = msg.location || {};
    if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return;
    loc.ts = loc.ts || nowIso();
    await devicesRepo.setLocation(id, loc);
    const { breach, distanceFromLast } = await locationsRepo.insert(id, loc);
    bus.emitSafe('device-location', { deviceId: id, lat: loc.lat, lng: loc.lng, breach, distanceFromLast });
    bus.emitSafe('device-status', { deviceId: id });

    if (breach) {
      await logEvent(id, 'geofence_breach', 'critical', { lat: loc.lat, lng: loc.lng, distanceFromLast });
      const dev = await devicesRepo.byId(id);
      await this.dispatcher
        .dispatch({
          deviceId: id,
          type: 'sync_now',
          payload: {},
          issuedBy: 'system:geofence',
        })
        .catch(() => {});
      bus.emitSafe('alert', {
        level: 'critical',
        deviceId: id,
        nama: dev?.nama_device,
        text: `${dev?.nama_device} KELUAR geofence (${distanceFromLast} m dari titik acuan, radius ${dev?.radius_meter} m)`,
      });
    }
  }

  async handleEvent(session, msg) {
    const id = session.deviceId;
    const dev = await devicesRepo.byId(id);
    const severity = ['info', 'warn', 'critical'].includes(msg.severity) ? msg.severity : 'info';
    await logEvent(id, String(msg.event || 'unknown').slice(0, 60), severity, msg.detail || null);
    bus.emitSafe('device-event', {
      deviceId: id,
      nama: dev?.nama_device,
      event: msg.event,
      severity,
      detail: msg.detail,
    });
    if (severity !== 'info') {
      await auditRepo.write({
        actor: `device:${id}`,
        actorKind: 'device',
        action: `device.${msg.event}`,
        target: id,
        detail: msg.detail,
      });
      bus.emitSafe('alert', {
        level: severity,
        deviceId: id,
        nama: dev?.nama_device,
        text: `${dev?.nama_device}: ${msg.event}${
          msg.detail?.note ? ` - ${msg.detail.note}` : ''
        }`,
      });
    }
  }

  async handleMedia(session, msg) {
    const id = session.deviceId;
    const cmdId = Number(msg.cmdId || 0);
    try {
      const buf = Buffer.from(String(msg.b64 || ''), 'base64');
      if (!buf.length) throw new Error('b64 kosong');
      if (buf.length > 5 * 1024 * 1024) throw new Error('foto > 5MB');
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const kind = ['front', 'rear'].includes(msg.kind) ? msg.kind : 'rear';
      const fname = `${id.replace(/[^\w.-]/g, '_')}-${Date.now()}-${kind}.enc`;
      await fs.writeFile(
        path.join(config.runtime.mediaDir, fname),
        encryptBuffer(buf),
        { mode: 0o600 },
      );
      const mediaId = await mediaRepo.insert({
        deviceId: id,
        commandId: cmdId || null,
        kind,
        file: fname,
        bytes: buf.length,
        sha256: sha,
        lat: Number.isFinite(msg.lat) ? msg.lat : null,
        lng: Number.isFinite(msg.lng) ? msg.lng : null,
        ts: msg.ts || nowIso(),
      });
      bus.emitSafe('media', { id: mediaId, deviceId: id, kind });
      this.send(session.ws, { t: 'ack', for: 'media', mediaId, bytes: buf.length });
      if (cmdId) {
        // Sinkronkan hasil command kamera supaya bot langsung bisa kirim foto.
        await this.dispatcher.onResult(id, {
          cmdId,
          ok: true,
          data: { mediaId, kind, bytes: buf.length, sha256: sha },
        });
      }
    } catch (e) {
      log.error('media gagal', { deviceId: id, err: e.message });
      if (cmdId) await this.dispatcher.onResult(id, { cmdId, ok: false, error: e.message });
    }
  }

  async markOffline(deviceId, reason) {
    await devicesRepo.setOnline(deviceId, false);
    bus.emitSafe('device-offline', { deviceId, reason, at: nowIso() });
    const dev = await devicesRepo.byId(deviceId);
    if (dev?.status_sewa === 'disewa') {
      bus.emitSafe('alert', {
        level: 'warn',
        deviceId,
        nama: dev.nama_device,
        text: `${dev.nama_device} OFFLINE sejak ${dev.last_seen_at} (${reason})`,
      });
    }
  }

  send(ws, frame) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  sweep() {
    for (const [deviceId, s] of this.sessions) {
      if (!s.alive) {
        log.warn('terminate zombie', { deviceId });
        try {
          s.ws.terminate();
        } catch {}
        this.sessions.delete(deviceId);
        this.dispatcher.detach(deviceId);
        continue;
      }
      s.alive = false;
      const ok = this.send(s.ws, { t: 'ping', ts: Date.now() });
      if (!ok) this.sessions.delete(deviceId);
    }
  }

  isOnline(deviceId) {
    const s = this.sessions.get(deviceId);
    return !!(s && s.ws.readyState === 1);
  }

  onlineIds() {
    return [...this.sessions.keys()].filter((id) => this.isOnline(id));
  }

  stats() {
    return {
      sessions: this.sessions.size,
      byDevice: [...this.sessions.entries()].map(([id, s]) => ({
        deviceId: id,
        ip: s.ip,
        since: new Date(s.connectedAt).toISOString(),
        alive: s.alive,
      })),
    };
  }
}

export { distanceMeters };
