// Repositori data. Semua fungsi async (kompatibel SQLite & PostgreSQL).
// Kolom sensitif (lokasi, payload, hasil) selalu lewat seal()/open() dari crypto/box.
import crypto from 'node:crypto';
import { db, nowIso, isoPlus, normalizeName } from '../db/index.js';
import { seal, open, sealJson, openJson, peppered, randomToken, sha256Hex } from '../crypto/box.js';
import { config } from '../config.js';

const D = () => db();

// Alfabet tanpa huruf/angka yang mirip (O/0, I/1, L/1, S/5, B/8) supaya
// kode pairing mudah diketik di tastik HP oleh staff.
const PAIR_ALPHABET = '2345679ACDEFGHJKMNPQRTVWXYZ';
export function randomPairCode(len = 8) {
  const out = [];
  for (let i = 0; i < len; i++)
    out.push(PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)]);
  return out.join('');
}

// ===========================================================================
// DEVICES
// ===========================================================================
export const devicesRepo = {
  async byId(deviceId) {
    return (await D().get('SELECT * FROM devices WHERE device_id = ?', [deviceId])) || null;
  },

  async byNameExact(name) {
    return (
      (await D().get('SELECT * FROM devices WHERE nama_norm = ?', [normalizeName(name)])) || null
    );
  },

  /**
   * Hapus device beserta seluruh riwayatnya. Bergantung pada
   * ON DELETE CASCADE di schema untuk location_history, command_log, media,
   * dan device_events.
   * @returns {boolean} true bila ada baris yang benar-benar dihapus
   */
  async remove(deviceId) {
    const res = await D().run('DELETE FROM devices WHERE device_id = ?', [deviceId]);
    return Number(res?.changes ?? 0) > 0;
  },

  /**
   * Ubah nama device. Dipakai perintah /rename di bot.
   * Normalisasi nama (lowercase + tanpa spasi) dihitung ulang di sini supaya
   * fuzzy matcher di bot tidak perlu tahu aturan maintenansinya.
   */
  async rename(deviceId, namaDevice) {
    return D().run('UPDATE devices SET nama_device = ?, nama_norm = ? WHERE device_id = ?', [
      namaDevice,
      normalizeName(namaDevice),
      deviceId,
    ]);
  },

  /** Semua device (dipakai fuzzy matcher + bot /daftar). */
  async all() {
    return D().all(
      'SELECT device_id, nama_device, nama_norm, status_sewa, is_locked, policy_state, ' +
        'is_online, battery_level, last_seen_at, radius_meter, geofence_armed, model, ' +
        'android_version, last_location_time FROM devices ORDER BY nama_device ASC',
    );
  },

  /**
   * Device yang masih ditandai online tapi sudah terlalu lama diam.
   * Dipanggil sweeper tiap 30 detik, jadi query-nya harus sempit - hanya
   * menyentil baris is_online = 1, bukan seluruh tabel.
   * cutoff: ISO-8601 string.
   */
  async onlineStale(cutoffIso) {
    return D().all(
      'SELECT device_id, nama_device, last_seen_at FROM devices ' +
        'WHERE is_online = 1 AND (last_seen_at IS NULL OR last_seen_at < ?) ' +
        'ORDER BY device_id ASC',
      [cutoffIso],
    );
  },

  /**
   * Paksa semua device jadi offline. Dipanggil SEKALI saat boot.
   * Kalau proses sebelumnya mati mendadak (listrik padam / di-taskkill),
   * shutdown() tidak sempat menjalankan setOnline(false), jadi is_online
   * masih 1 walau jelas tidak ada soket yang hidup. Saat boot kita tahu
   * pasti jumlah koneksi nol, jadi aman untuk dibersihkan total.
   */
  async setAllOffline() {
    return D().run('UPDATE devices SET is_online = 0 WHERE is_online = 1');
  },

  async countByStatus() {
    const rows = await D().all(
      "SELECT status_sewa, COUNT(*) AS n, SUM(is_online) AS online FROM devices GROUP BY status_sewa",
    );
    const out = { total: 0, tersedia: 0, disewa: 0, hilang: 0, maintenance: 0, online: 0 };
    for (const r of rows) {
      out[r.status_sewa] = r.n;
      out.total += r.n;
      out.online += Number(r.online || 0);
    }
    return out;
  },

  /** fields: device_id (PK, tidak di-update), sisanya dari daftar putih. */
  async update(deviceId, patch) {
    const allowed = [
      'nama_device',
      'nama_penyewa',
      'status_sewa',
      'policy_state',
      'is_locked',
      'geofence_armed',
      'radius_meter',
      'battery_level',
      'battery_temp',
      'charging',
      'network_type',
      'signal_dbm',
      'storage_free_mb',
      'ram_free_mb',
      'is_online',
      'last_seen_at',
      'last_boot_at',
      'app_version',
      'android_version',
      'api_level',
      'model',
      'manufacturer',
      'serial_number',
      'android_id',
      'imei',
      'revoked_at',
      'enrolled_at',
      'token_issued_at',
    ];
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'nama_device') {
        sets.push('nama_device = ?', 'nama_norm = ?');
        vals.push(v, normalizeName(v));
        continue;
      }
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = ?`);
      vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
    }
    if (!sets.length) return this.byId(deviceId);
    sets.push('updated_at = ?');
    vals.push(nowIso(), deviceId);
    await D().run(`UPDATE devices SET ${sets.join(', ')} WHERE device_id = ?`, vals);
    return this.byId(deviceId);
  },

  async setLocation(deviceId, loc) {
    await D().run(
      `UPDATE devices SET last_location_lat = ?, last_location_lng = ?, last_location_acc = ?,
         last_location_time = ?, last_location_source = ?, updated_at = ? WHERE device_id = ?`,
      [
        seal(String(loc.lat)),
        seal(String(loc.lng)),
        loc.accuracy ?? null,
        loc.ts || nowIso(),
        loc.source || 'fused',
        nowIso(),
        deviceId,
      ],
    );
  },

  /** Dekripsi lokasi terakhir untuk ditampilkan ke bot/dashboard. */
  async lastLocation(deviceId) {
    const d = await this.byId(deviceId);
    if (!d || !d.last_location_lat) return null;
    const lat = Number(open(d.last_location_lat));
    const lng = Number(open(d.last_location_lng));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      lat,
      lng,
      accuracy: d.last_location_acc,
      ts: d.last_location_time,
      source: d.last_location_source,
    };
  },

  /** Dipakai saat onboarding / rotasi token.
   *  pairCode = kode 8 karakter untuk pairing app Guard saat pertama jalan. */
  async create({ deviceId, namaDevice, token, batchId = null, createdBy = 'system' }) {
    const tokenVal = token || randomToken();
    const pairCode = randomPairCode();
    const now = nowIso();
    await D().run(
      `INSERT INTO devices
        (device_id, nama_device, nama_norm, status_sewa, radius_meter, geofence_armed,
         auth_secret_hash, auth_secret_enc, pair_code_hash, token_issued_at, batch_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        deviceId,
        namaDevice,
        normalizeName(namaDevice),
        'tersedia',
        150,
        0,
        peppered(tokenVal),
        seal(tokenVal),
        peppered(pairCode),
        now,
        batchId,
        now,
        now,
      ],
    );
    logEvent(deviceId, 'enrolled', 'info', { createdBy });
    return { device: await this.byId(deviceId), token: tokenVal, pairCode };
  },

  /** Tukar kode pairing -> device_id + token device (sekali pakai). */
  async claimPairCode(code) {
    const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalized.length !== 8) return null;
    const row = await D().get('SELECT * FROM devices WHERE pair_code_hash = ?', [peppered(normalized)]);
    if (!row) return null;
    await D().run('UPDATE devices SET pair_code_hash = NULL, enrolled_at = ?, updated_at = ? WHERE device_id = ?', [
      nowIso(),
      nowIso(),
      row.device_id,
    ]);
    return { deviceId: row.device_id, nama: row.nama_device, token: open(row.auth_secret_enc) };
  },

  async rotateToken(deviceId) {
    const token = randomToken();
    const pairCode = randomPairCode();
    await D().run(
      `UPDATE devices SET auth_secret_hash = ?, auth_secret_enc = ?, pair_code_hash = ?, token_issued_at = ?,
         updated_at = ? WHERE device_id = ?`,
      [peppered(token), seal(token), peppered(pairCode), nowIso(), nowIso(), deviceId],
    );
    return { token, pairCode };
  },

  async verifyAuth(deviceId, tag, nonce) {
    const d = await this.byId(deviceId);
    if (!d || d.revoked_at) return null;
    const secret = open(d.auth_secret_enc);
    if (!secret) return null;
    const { deviceTag } = await import('../crypto/box.js');
    const expected = deviceTag(secret, nonce, deviceId);
    if (expected.length !== tag.length) return null;
    const { safeEqual } = await import('../crypto/box.js');
    return safeEqual(expected, tag) ? d : null;
  },

  async setOnline(deviceId, online, extra = {}) {
    const now = nowIso();
    await D().run(
      'UPDATE devices SET is_online = ?, last_seen_at = ?, updated_at = ? WHERE device_id = ?',
      [online ? 1 : 0, now, now, deviceId],
    );
    if (Object.keys(extra).length) await this.update(deviceId, extra);
    if (!online) logEvent(deviceId, 'offline', 'warn', {});
  },

  /** Stokol per device: heartbeat dari APK. */
  async heartbeat(deviceId, st) {
    const fields = [];
    const vals = [];
    const map = {
      battery_level: st.battery,
      battery_temp: st.batteryTemp,
      charging: st.charging === undefined ? undefined : st.charging ? 1 : 0,
      network_type: st.network,
      signal_dbm: st.signal,
      storage_free_mb: st.storageFreeMb,
      ram_free_mb: st.ramFreeMb,
      policy_state: st.policyState,
      is_locked: st.locked === undefined ? undefined : st.locked ? 1 : 0,
      last_boot_at: st.bootAt,
      app_version: st.appVersion,
      android_version: st.androidVersion,
      api_level: st.apiLevel,
      model: st.model,
      manufacturer: st.manufacturer,
      geofence_armed: st.geofenceArmed === undefined ? undefined : st.geofenceArmed ? 1 : 0,
      radius_meter: st.radiusM,
    };
    for (const [k, v] of Object.entries(map)) {
      if (v === undefined || v === null) continue;
      fields.push(`${k} = ?`);
      vals.push(v);
    }
    fields.push('is_online = ?', 'last_seen_at = ?', 'updated_at = ?');
    vals.push(1, nowIso(), nowIso(), deviceId);
    await D().run(`UPDATE devices SET ${fields.join(', ')} WHERE device_id = ?`, vals);
    if (st.location && Number.isFinite(st.location.lat)) {
      await this.setLocation(deviceId, st.location);
      await locationsRepo.insert(deviceId, st.location);
    }
  },

  /** Cocokkan device hardware yang baru enroll pertama kali ke device_id terpetakan.
   *  Dipakai setelah factory reset: APK akan device_id lama, tapi Android ID/serial bisa
   *  berubah (atau tidak, tergantung OEM). Kunci utama tetap device_id + token. */
  async findByAndroidId(androidId) {
    if (!androidId) return null;
    return (
      (await D().get('SELECT * FROM devices WHERE android_id = ? ORDER BY updated_at DESC LIMIT 1', [
        androidId,
      ])) || null
    );
  },
};

// ===========================================================================
// LOCATION HISTORY
// ===========================================================================
export const locationsRepo = {
  async insert(deviceId, loc) {
    const dev = await devicesRepo.byId(deviceId);
    let dist = null;
    let breach = 0;
    if (dev && dev.geofence_armed && Number(dev.radius_meter) > 0) {
      const home = await devicesRepo.lastLocation(deviceId);
      if (home) {
        const { distanceMeters } = await import('../crypto/box.js');
        dist = Math.round(distanceMeters(home.lat, home.lng, loc.lat, loc.lng));
        breach = dist > Number(dev.radius_meter) ? 1 : 0;
      }
    }
    await D().run(
      `INSERT INTO location_history
        (device_id, lat, lng, accuracy, speed, altitude, battery, source, geofence_dist, geofence_breach, ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        deviceId,
        seal(String(loc.lat)),
        seal(String(loc.lng)),
        loc.accuracy ?? null,
        loc.speed ?? null,
        loc.altitude ?? null,
        loc.battery ?? null,
        loc.source || 'fused',
        dist,
        breach,
        loc.ts || nowIso(),
      ],
    );
    return { distanceFromLast: dist, breach: !!breach };
  },

  async recent(deviceId, hours = 24, limit = 500) {
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const rows = await D().all(
      'SELECT id, lat, lng, accuracy, battery, source, geofence_dist, geofence_breach, ts FROM location_history WHERE device_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?',
      [deviceId, since, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      lat: Number(open(r.lat)),
      lng: Number(open(r.lng)),
      accuracy: r.accuracy,
      battery: r.battery,
      source: r.source,
      distanceFromPrev: r.geofence_dist,
      breach: !!r.geofence_breach,
      ts: r.ts,
    }));
  },

  async last(deviceId) {
    const rows = await this.recent(deviceId, 24 * 30, 1);
    return rows[0] || null;
  },

  async prune(days) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return (await D().run('DELETE FROM location_history WHERE ts < ?', [cutoff])).changes;
  },
};

// ===========================================================================
// COMMAND LOG + ANTREAN FIFO
// ===========================================================================
export const commandsRepo = {
  async create({ deviceId, type, payload, issuedBy, ttlMs, maxAttempts = 2 }) {
    const now = nowIso();
    const res = await D().run(
      `INSERT INTO command_log
        (device_id, command_type, payload_enc, issued_by, status, attempt, max_attempts, created_at, expires_at)
       VALUES (?,?,?,?,'pending',0,?,?,?)`,
      [deviceId, type, sealJson(payload ?? {}), issuedBy, maxAttempts, now, isoPlus(ttlMs)],
    );
    return this.byId(res.lastId);
  },

  async byId(id) {
    const r = await D().get('SELECT * FROM command_log WHERE id = ?', [id]);
    if (!r) return null;
    return {
      ...r,
      payload: openJson(r.payload_enc, {}),
      result: openJson(r.result_enc, null),
    };
  },

  /**
   * CLAIM = ambil antrean paling depan (FIFO) untuk device, tandai 'sent'.
   * Hanya boleh ada SATU command 'sent' per device (rekomendasi broker), sehingga
   * dua command beruntun tidak pernah dieksekusi paralel / tertukar.
   */
  async claimNext(deviceId) {
    const inflight = await D().get(
      "SELECT id FROM command_log WHERE device_id = ? AND status = 'sent' ORDER BY id ASC LIMIT 1",
      [deviceId],
    );
    if (inflight) return null; // masih ada yang jalan -> tunggu
    const next = await D().get(
      "SELECT id FROM command_log WHERE device_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1",
      [deviceId],
    );
    if (!next) return null;
    await D().run(
      "UPDATE command_log SET status = 'sent', attempt = attempt + 1, sent_at = ? WHERE id = ? AND status = 'pending'",
      [nowIso(), next.id],
    );
    return this.byId(next.id);
  },

  async complete(id, { ok, result = null, error = null }) {
    await D().run(
      `UPDATE command_log SET status = ?, result_enc = ?, error = ?, completed_at = ? WHERE id = ?`,
      [ok ? 'acked' : 'failed', sealJson(result), error ? String(error).slice(0, 500) : null, nowIso(), id],
    );
    return this.byId(id);
  },

  async requeue(id, reason) {
    const row = await this.byId(id);
    if (!row) return null;
    if (row.attempt >= row.max_attempts) {
      return this.complete(id, { ok: false, error: reason || 'max attempts reached' });
    }
    await D().run("UPDATE command_log SET status = 'pending', sent_at = NULL WHERE id = ?", [id]);
    return this.byId(id);
  },

  async markExpiredStale(olderThanIso) {
    return (
      await D().run(
        "UPDATE command_log SET status = 'expired', error = 'TTL habis', completed_at = ? WHERE status IN ('pending','sent') AND expires_at < ?",
        [nowIso(), olderThanIso],
      )
    ).changes;
  },

  async pendingCount(deviceId) {
    const r = await D().get(
      "SELECT COUNT(*) AS n FROM command_log WHERE device_id = ? AND status IN ('pending','sent')",
      [deviceId],
    );
    return Number(r?.n || 0);
  },

  async listByDevice(deviceId, limit = 20) {
    const rows = await D().all(
      'SELECT id, command_type, status, attempt, issued_by, error, created_at, sent_at, completed_at FROM command_log WHERE device_id = ? ORDER BY id DESC LIMIT ?',
      [deviceId, limit],
    );
    return rows;
  },

  async listRecent(limit = 50) {
    return D().all(
      `SELECT c.id, c.device_id, d.nama_device, c.command_type, c.status, c.issued_by, c.created_at, c.completed_at
       FROM command_log c LEFT JOIN devices d ON d.device_id = c.device_id
       ORDER BY c.id DESC LIMIT ?`,
      [limit],
    );
  },

  async cleanupOlderThan(days) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return (
      await D().run(
        "DELETE FROM command_log WHERE completed_at IS NOT NULL AND completed_at < ?",
        [cutoff],
      )
    ).changes;
  },
};

// ===========================================================================
// MEDIA (foto kamera, terenkripsi di disk)
// ===========================================================================
export const mediaRepo = {
  async insert({ deviceId, commandId, kind, file, bytes, sha256, lat, lng, ts }) {
    const res = await D().run(
      `INSERT INTO media (device_id, command_id, kind, file, bytes, sha256, lat, lng, ts, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        deviceId,
        commandId,
        kind,
        file,
        bytes,
        sha256,
        lat ? seal(String(lat)) : null,
        lng ? seal(String(lng)) : null,
        ts,
        nowIso(),
      ],
    );
    return res.lastId;
  },
  async byId(id) {
    return D().get('SELECT * FROM media WHERE id = ?', [id]);
  },
  async byCommand(commandId) {
    return D().get('SELECT * FROM media WHERE command_id = ? ORDER BY id DESC LIMIT 1', [
      commandId,
    ]);
  },
  async latest(deviceId, limit = 10) {
    return D().all(
      'SELECT id, device_id, kind, bytes, ts, created_at FROM media WHERE device_id = ? ORDER BY id DESC LIMIT ?',
      [deviceId, limit],
    );
  },
};

// ===========================================================================
// ADMIN / SESSION / AUDIT / EVENTS
// ===========================================================================
export const adminsRepo = {
  async byUsername(u) {
    return D().get('SELECT * FROM admin_users WHERE username = ?', [u]);
  },
  async byId(id) {
    return D().get('SELECT * FROM admin_users WHERE id = ?', [id]);
  },
  async byTelegramChatId(chatId) {
    return D().get('SELECT * FROM admin_users WHERE telegram_chat_id = ?', [String(chatId)]);
  },
  async list() {
    return D().all(
      'SELECT id, username, role, telegram_chat_id, telegram_username, is_active, last_login_at FROM admin_users ORDER BY id',
    );
  },
  async create({ username, passwordHash, role = 'staff', telegramChatId = null }) {
    const now = nowIso();
    const r = await D().run(
      `INSERT INTO admin_users (username, password_hash, role, telegram_chat_id, is_active, created_at, updated_at)
       VALUES (?,?,?,?,1,?,?)`,
      [username, passwordHash, role, telegramChatId, now, now],
    );
    return this.byId(r.lastId);
  },
  async touchLogin(id, ip) {
    await D().run(
      "UPDATE admin_users SET last_login_at = ?, last_login_ip = ?, failed_logins = 0, locked_until = NULL WHERE id = ?",
      [nowIso(), ip, id],
    );
  },
  async registerFailedLogin(username) {
    const a = await this.byUsername(username);
    if (!a) return;
    const n = Number(a.failed_logins) + 1;
    const lockedUntil = n >= 5 ? isoPlus(15 * 60 * 1000) : null;
    await D().run('UPDATE admin_users SET failed_logins = ?, locked_until = ? WHERE id = ?', [
      n,
      lockedUntil,
      a.id,
    ]);
  },
};

export const sessionsRepo = {
  async create({ adminId, ip, userAgent }) {
    const raw = randomToken(32);
    const t = sha256Hex(raw);
    await D().run(
      'INSERT INTO sessions (token_hash, admin_id, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?)',
      [t, adminId, nowIso(), isoPlus(config.security.sessionTtlMs), ip, userAgent],
    );
    return raw;
  },
  async get(rawToken) {
    if (!rawToken) return null;
    const t = sha256Hex(rawToken);
    const s = await D().get('SELECT * FROM sessions WHERE token_hash = ?', [t]);
    if (!s) return null;
    if (new Date(s.expires_at).getTime() < Date.now()) {
      await D().run('DELETE FROM sessions WHERE token_hash = ?', [t]);
      return null;
    }
    return s;
  },
  async destroy(rawToken) {
    await D().run('DELETE FROM sessions WHERE token_hash = ?', [sha256Hex(rawToken)]);
  },
  async prune() {
    return (await D().run('DELETE FROM sessions WHERE expires_at < ?', [nowIso()])).changes;
  },
};

export const auditRepo = {
  async write({ actor, actorKind = 'telegram', action, target = null, detail = null, ip = null, ok = true }) {
    await D().run(
      'INSERT INTO audit_log (actor, actor_kind, action, target, detail_enc, ip, ok, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [actor, actorKind, action, target, sealJson(detail), ip, ok ? 1 : 0, nowIso()],
    );
  },
  async recent(limit = 100) {
    const rows = await D().all(
      'SELECT id, actor, actor_kind, action, target, ip, ok, created_at FROM audit_log ORDER BY id DESC LIMIT ?',
      [limit],
    );
    return rows.map((r) => ({ ...r, detail: openJson(r.detail_enc, null) }));
  },
};

export async function logEvent(deviceId, event, severity = 'info', detail = null) {
  await D().run(
    'INSERT INTO device_events (device_id, event, severity, detail_enc, created_at) VALUES (?,?,?,?,?)',
    [deviceId, event, severity, sealJson(detail), nowIso()],
  );
  if (severity !== 'info') {
    const { bus } = await import('../eventbus.js');
    bus.emit('device-event', { deviceId, event, severity, detail });
  }
}

export const eventsRepo = {
  async recent(deviceId, limit = 40) {
    const rows = await D().all(
      'SELECT id, event, severity, detail_enc, created_at FROM device_events WHERE device_id = ? ORDER BY id DESC LIMIT ?',
      [deviceId, limit],
    );
    return rows.map((r) => ({ ...r, detail: openJson(r.detail_enc, null) }));
  },
  async recentAll(limit = 40) {
    const rows = await D().all(
      `SELECT e.id, e.device_id, d.nama_device, e.event, e.severity, e.detail_enc, e.created_at
       FROM device_events e LEFT JOIN devices d ON d.device_id = e.device_id
       ORDER BY e.id DESC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => ({ ...r, detail: openJson(r.detail_enc, null) }));
  },
};

export const enrollmentRepo = {
  async create(b) {
    const r = await D().run(
      `INSERT INTO enrollment_batches (batch_name, note, method, qr_payload, qr_file, ndef_file, amapi_token, policy_name, count_devices, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        b.batchName,
        b.note || null,
        b.method || 'qr',
        b.qrPayload || null,
        b.qrFile || null,
        b.ndefFile || null,
        b.amapiToken || null,
        b.policyName || null,
        b.count || 0,
        b.createdBy || 'system',
        nowIso(),
      ],
    );
    return r.lastId;
  },
  async list(limit = 50) {
    return D().all(
      'SELECT id, batch_name, note, method, count_devices, policy_name, created_at FROM enrollment_batches ORDER BY id DESC LIMIT ?',
      [limit],
    );
  },
};
