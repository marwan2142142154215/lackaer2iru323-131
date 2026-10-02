// Antrean command per device_id (FIFO, satu-per-satu).
//
// Aturan main untuk mencegah race condition / salah target:
//   1. HANYA satu command berstatus 'sent' per device pada saat bersamaan
//      (dijamin commandsRepo.claimNext() menolak claim baru).
//   2. Device hanya boleh menjalankan command yang dikasih server pada frame
//      'cmd' - tidak pernah dieksekusi karena aplikasi dalam bentuk lain.
//   3. Setiap command punya cmdId; device wajib balas 'result' dengan cmdId sama.
//      Balasan yang tidak cocok cmdId diabaikan (mencegah reply tertukar).
//   4. Head-of-line: command berikutnya baru dikirim setelah result/perilaku
//      command sebelumnya selesai, sehingga tidak ada tumpang tindih.
import { commandsRepo, devicesRepo, auditRepo } from '../db/repos.js';
import { validateCommand, catalogEntry, CommandError } from './catalog.js';
import { config } from '../config.js';
import { logger } from '../util/logger.js';
import { bus } from '../eventbus.js';

const log = logger('queue');

export class CommandDispatcher {
  constructor() {
    /** @type {Map<string, {send:(frame:any)=>boolean, isOpen:()=>boolean}>} */
    this.conns = new Map();
    /** @type {Map<string, {id:number, timer:NodeJS.Timeout}>} */
    this.inflight = new Map();
    /** @type {Map<number, {resolve:Function, timer:NodeJS.Timeout}>} */
    this.waiters = new Map();
    /** cooldown per device+type: deviceId|type -> epoch ms */
    this.cooldown = new Map();
  }

  attach(deviceId, conn) {
    this.conns.set(deviceId, conn);
    this.pump(deviceId);
  }

  detach(deviceId) {
    this.conns.delete(deviceId);
    const f = this.inflight.get(deviceId);
    if (f) {
      clearTimeout(f.timer);
      this.inflight.delete(deviceId);
      // Kembalikan ke antrean supaya tidak hilang saat koneksi putus.
      commandsRepo.requeue(f.id, 'koneksi terputus').catch(() => {});
    }
  }

  /**
   * @returns {Promise<{id:number, status:string, deviceId:string}>}
   */
  async dispatch({ deviceId, type, payload, issuedBy = 'system', actorKind = 'system' }) {
    const device = await devicesRepo.byId(deviceId);
    if (!device) throw new CommandError('unknown_device', `device ${deviceId} tidak terdaftar`);
    if (device.revoked_at)
      throw new CommandError('revoked', `token device ${deviceId} sudah dicabut`);

    const def = catalogEntry(type);
    if (!def) throw new CommandError('unknown_command', `command tidak dikenal: ${type}`);

    const clean = validateCommand(type, payload);

    const depth = await commandsRepo.pendingCount(deviceId);
    if (depth >= config.runtime.queueMaxDepth)
      throw new CommandError(
        'queue_full',
        `antrean ${deviceId} penuh (${depth}); tunggu command sebelumnya selesai`,
      );

    if (def.cooldownSec) {
      const key = `${deviceId}|${type}`;
      const last = this.cooldown.get(key) || 0;
      const waitMs = def.cooldownSec * 1000 - (Date.now() - last);
      if (waitMs > 0)
        throw new CommandError(
          'cooldown',
          `terlalu cepat: ${type} hanya boleh tiap ${def.cooldownSec} detik (tunggu ${Math.ceil(waitMs / 1000)}s)`,
        );
      this.cooldown.set(key, Date.now());
    }

    const row = await commandsRepo.create({
      deviceId,
      type,
      payload: clean,
      issuedBy,
      ttlMs: def.ttlMs ?? config.runtime.commandDefaultTtlMs,
      maxAttempts: 2,
    });

    await auditRepo.write({
      actor: issuedBy,
      actorKind,
      action: 'command.issue',
      target: deviceId,
      detail: { type, cmdId: row.id, payload: clean },
    });
    bus.emitSafe('command-update', { id: row.id, deviceId, status: 'pending', type });

    this.pump(deviceId);
    return { id: row.id, status: 'pending', deviceId, type };
  }

  /** Tunggu hasil sebuah command (dipakai bot untuk foto/lokasi). */
  awaitResult(cmdId, timeoutMs = 60_000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(cmdId);
        resolve({ ok: false, error: 'timeout menunggu device', status: 'pending' });
      }, timeoutMs);
      this.waiters.set(cmdId, { resolve, timer });
    });
  }

  async pump(deviceId) {
    const conn = this.conns.get(deviceId);
    if (!conn || !conn.isOpen() || this.inflight.has(deviceId)) return;
    let claim;
    try {
      claim = await commandsRepo.claimNext(deviceId);
    } catch (e) {
      log.error('claimNext gagal', { deviceId, err: e.message });
      return;
    }
    if (!claim) return;
    const frame = {
      t: 'cmd',
      cmdId: claim.id,
      deviceId,
      type: claim.command_type,
      payload: claim.payload,
      sentAt: new Date().toISOString(),
      expiresAt: claim.expires_at,
    };
    let ok = false;
    try {
      ok = conn.send(frame);
    } catch (e) {
      log.warn('gagal kirim frame', { deviceId, cmdId: claim.id, err: e.message });
    }
    if (!ok) {
      await commandsRepo.requeue(claim.id, 'tidak bisa kirim');
      this.inflight.delete(deviceId);
      return;
    }
    const ttl = Math.max(5_000, (catalogEntry(claim.command_type)?.ttlMs ?? 60_000));
    const timer = setTimeout(async () => {
      this.inflight.delete(deviceId);
      log.warn('command timeout', { deviceId, cmdId: claim.id, type: claim.command_type });
      const still = await commandsRepo.byId(claim.id);
      if (still && still.status === 'sent') {
        const requeued = await commandsRepo.requeue(claim.id, 'tidak ada respons device');
        bus.emitSafe('command-update', { id: claim.id, deviceId, status: requeued?.status });
        if (requeued?.status !== 'pending') {
          this.settle(claim.id, { ok: false, error: 'timeout', status: 'failed' });
        } else {
          this.pump(deviceId);
        }
      }
    }, ttl);
    this.inflight.set(deviceId, { id: claim.id, timer });
    bus.emitSafe('command-update', { id: claim.id, deviceId, status: 'sent', type: claim.command_type });
  }

  /** Dipanggil hub saat device mengirim {t:'result'}. */
  async onResult(deviceId, msg) {
    const cmdId = Number(msg.cmdId);
    const f = this.inflight.get(deviceId);
    if (!f || f.id !== cmdId) {
      // Balasan basi / bukan command aktif -> tolak keras.
      log.warn('result tidak cocok', { deviceId, cmdId, inflight: f?.id });
      return;
    }
    clearTimeout(f.timer);
    this.inflight.delete(deviceId);
    const row = await commandsRepo.complete(cmdId, {
      ok: !!msg.ok,
      result: msg.ok ? msg.data ?? {} : null,
      error: msg.ok ? null : msg.error || 'gagal di device',
    });
    bus.emitSafe('command-update', { id: cmdId, deviceId, status: row.status, type: row.command_type });
    this.settle(cmdId, { ok: !!msg.ok, data: msg.data ?? {}, error: msg.error, status: row.status });
    this.pump(deviceId);
  }

  settle(cmdId, result) {
    const w = this.waiters.get(cmdId);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiters.delete(cmdId);
    w.resolve(result);
  }

  /** Batalkan semua antrean pending device (mis. saat /tandai_tersedia). */
  async cancelPending(deviceId, reason = 'dibatalkan admin') {
    const rows = await commandsRepo.listByDevice(deviceId, 100);
    let n = 0;
    for (const r of rows) {
      if (r.status === 'pending' || r.status === 'sent') {
        await commandsRepo.complete(r.id, { ok: false, error: reason });
        n++;
      }
    }
    return n;
  }

  isOnline(deviceId) {
    const c = this.conns.get(deviceId);
    return !!(c && c.isOpen());
  }

  onlineDeviceIds() {
    return [...this.conns.entries()].filter(([, c]) => c.isOpen()).map(([id]) => id);
  }
}
