// Bot Telegram: satu-satunya antarmuka kontrol untuk admin.
// Semua perintah DITeruskan ke dispatcher (antrean per device) - bot tidak pernah
// bicara langsung ke HP.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../util/logger.js';
import * as tg from './api.js';
import { resolveDevice, formatCandidates } from './device-resolver.js';
import { deviceLine, ICON, ago, fmtTime, batteryText, kbDevice, kbList, kbYesNo } from './format.js';
import {
  devicesRepo,
  locationsRepo,
  commandsRepo,
  mediaRepo,
  auditRepo,
  adminsRepo,
  eventsRepo,
  logEvent,
} from '../db/repos.js';
import { listCatalog } from '../commands/catalog.js';
import { CommandError } from '../commands/catalog.js';
import { decryptBuffer } from '../crypto/box.js';
import { bus } from '../eventbus.js';

const log = logger('bot');
const esc = tg.esc;
const PICK_TTL_MS = 5 * 60 * 1000;
const CONFIRM_TTL_MS = 90 * 1000;

const HELP = `<b>Fleet Guard - perintah</b>
/daftar [filter]            daftar device
/status &lt;nama&gt;              detail 1 device
/lock &lt;nama&gt; [alasan]         kunci + suspend semua app
/unlock &lt;nama&gt;              buka + kirim PIN baru
/pin &lt;nama&gt;                 ambil PIN layar kunci (sekali)
/lokasi &lt;nama&gt;              titik lokasi real-time
/riwayat_lokasi &lt;nama&gt; [jam] jalur lokasi (default 6 jam)
/kamera_depan &lt;nama&gt;
/kamera_belakang &lt;nama&gt;
/sound &lt;nama&gt;              bunyikan alarm
/pesan &lt;nama&gt; &lt;teks&gt;         tampil pesan di layar
/tandai_hilang &lt;nama&gt;        status hilang + auto-lock + lacak cepat
/tandai_disewa &lt;nama&gt; &lt;orang&gt;
/tandai_tersedia &lt;nama&gt;
/maintenance &lt;nama&gt; · / Maintenance selesai
/set_radius &lt;nama&gt; &lt;meter&gt;
/lacak &lt;nama&gt; [menit] · /stop_lacak &lt;nama&gt;
/kiosk &lt;nama&gt; on|off
/rename &lt;lama&gt; &lt;baru&gt;
/reboot &lt;nama&gt;              (konfirmasi)
/hapus_data &lt;nama&gt;           (konfirmasi 2x, permanen)
/rotasi_token &lt;nama&gt;       |superadmin, putuskan device lama
/perintah · /audit · /stat · /uji

<b>Catatan:</b> nama boleh disingkat. Kalau ambigu, bot akan menampilkan
daftar kandidat lebih dulu - tidak akan pernah mengirim command ke device
yang salah.`;

export class TelegramBot {
  constructor({ dispatcher, hub, notifier = null }) {
    this.d = dispatcher;
    this.hub = hub;
    // Notifier bisa di-swap (dipakai selftest bot tanpa memanggil Telegram sungguhan).
    this.tg = notifier || tg;
    this.offset = 0;
    this.running = false;
    this.sessions = new Map(); // chatId -> {action, candidates, at, deviceId, confirm}
    this.allowed = new Set(config.telegram.adminChatIds);
    this.lastCmd = new Map(); // anti-spam: chatId -> {cmd, at}
  }

  async start() {
    if (!config.telegram.token) {
      log.error('TELEGRAM_BOT_TOKEN kosong - bot tidak dijalankan');
      return;
    }
    //(getMe Sometimes network is not ready when the PC just booted -> retry)
    let me = null;
    for (let i = 0; i < 4 && !me; i++) {
      try {
        me = await this.tg.getMe();
      } catch (e) {
        log.warn('gagal konek telegram, coba lagi', { attempt: i + 1, err: e.message });
        await this.tg.sleep(3000 * (i + 1));
      }
    }
    if (!me) throw new Error('tidak bisa konek ke api.telegram.org (cek internet/proxy)');
    log.info('bot telegram siap', { username: me.username, id: me.id });
    await this.tg
      .setCommands([
        { command: 'daftar', description: 'Daftar semua device' },
        { command: 'status', description: 'Detail satu device' },
        { command: 'lock', description: 'Kunci device' },
        { command: 'unlock', description: 'Buka kunci device' },
        { command: 'lokasi', description: 'Lokasi device' },
        { command: 'riwayat_lokasi', description: 'Riwayat lokasi' },
        { command: 'kamera_belakang', description: 'Foto kamera belakang' },
        { command: 'kamera_depan', description: 'Foto kamera depan' },
        { command: 'tandai_hilang', description: 'Tandai hilang' },
        { command: 'tandai_disewa', description: 'Tandai disewa' },
        { command: 'tandai_tersedia', description: 'Tandai tersedia' },
        { command: 'sound', description: 'Bunyikan alarm' },
        { command: 'set_radius', description: 'Set radius geofence' },
        { command: 'help', description: 'Bantuan' },
      ])
      .catch(() => {});
    this.initAlerts();
    this.running = true;
    this.loop().catch((e) => log.error('loop mati', { err: e.message }));
  }

  stop() {
    this.running = false;
  }

  async loop() {
    while (this.running) {
      try {
        const updates = await this.tg.getUpdates(this.offset, 35);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          try {
            await this.route(u);
          } catch (e) {
            log.error('update gagal', { update: u.update_id, err: e.message });
            if (u.message?.chat?.id) {
              await this.tg
                .send(u.message.chat.id, `⚠️ error: ${e.message}`)
                .catch(() => {});
            }
          }
        }
      } catch (e) {
        if (/Conflict|terminated by other getUpdates/i.test(e.message)) {
          await this.tg.sleep(5000);
        } else {
          log.warn('getUpdates error', { err: e.message });
          await this.tg.sleep(5000);
        }
      }
    }
  }

  // ---------------------------------------------------------------- auth --
  async isAllowed(chatId) {
    if (this.allowed.has(Number(chatId))) return true;
    const a = await adminsRepo.byTelegramChatId(chatId);
    if (a && a.is_active) {
      this.allowed.add(Number(chatId));
      return true;
    }
    return false;
  }

  async actorOf(msg) {
    const from = msg.from || {};
    const who = from.username ? `@${from.username}` : `id${from.id}`;
    return { actor: `bot:${who}`, actorKind: 'telegram', ip: null };
  }

  // --------------------------------------------------------------- route --
  async route(update) {
    if (update.message) return this.onMessage(update.message);
    if (update.callback_query) return this.onCallback(update.callback_query);
  }

  async onMessage(msg) {
    const chatId = msg.chat?.id;
    if (!chatId) return;
    const text = (msg.text || msg.caption || '').trim();
    const authorized = await this.isAllowed(chatId);
    if (!authorized) {
      await auditRepo.write({
        actor: `tg:${chatId}`,
        action: 'access.denied',
        target: text.slice(0, 80),
        detail: { username: msg.from?.username },
        ok: false,
      });
      log.warn('chat tidak di-whitelist', {
        chatId,
        user: msg.from?.username,
        hint: `node scripts/admin.mjs chat <username> ${chatId}`,
      });
      if (msg.chat.type === 'private') {
        await this.tg
          .send(
            chatId,
            `⛔️ Akses ditolak.\nChat ini <code>${chatId}</code> belum terdaftar sebagai admin.\n` +
              `Pemilik server perlu menjalankan: <code>node scripts/admin.mjs chat &lt;username&gt; ${chatId}</code>`,
          )
          .catch(() => {});
      }
      return;
    }
    if (!text.startsWith('/')) return;

    // Anti-spam: tolak HANYA perintah yang identik dalam 400 ms (cegah double-tap),
// bukan semua perintah yang berdekatan.
    const key = `${chatId}|${text}`;
    const prev = this.lastCmd.get(key) || 0;
    if (Date.now() - prev < 400) return;
    this.lastCmd.set(key, Date.now());

    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = cmdRaw.split('@')[0].toLowerCase();
    const rest = args.join(' ').trim();

    //gk: command yang butuh device
    try {
      switch (cmd) {
        case '/start':
        case '/help':
          return void (await this.tg.send(chatId, HELP));
        case '/daftar':
          return void (await this.cmdList(chatId, rest, msg));
        case '/status':
          return void (await this.cmdStatus(chatId, rest));
        case '/lock':
          return void (await this.cmdLock(chatId, rest, msg));
        case '/unlock':
          return void (await this.cmdUnlock(chatId, rest));
        case '/pin':
          return void (await this.cmdPin(chatId, rest));
        case '/lokasi':
          return void (await this.cmdLocate(chatId, rest));
        case '/riwayat_lokasi':
        case '/rilokasi':
          return void (await this.cmdHistory(chatId, rest));
        case '/kamera_depan':
        case '/kamera_belakang':
          return void (await this.cmdCamera(chatId, rest, cmd.endsWith('depan') ? 'front' : 'rear'));
        case '/sound':
          return void (await this.cmdRing(chatId, rest));
        case '/pesan':
          return void (await this.cmdToast(chatId, rest));
        case '/tandai_hilang':
          return void (await this.cmdMarkLost(chatId, rest));
        case '/tandai_disewa':
          return void (await this.cmdMarkRented(chatId, rest));
        case '/tandai_tersedia':
          return void (await this.cmdMarkFree(chatId, rest));
        case '/maintenance':
          return void (await this.cmdSetSewa(chatId, rest, 'maintenance'));
        case '/maintenance_selesai':
          return void (await this.cmdSetSewa(chatId, rest, 'tersedia'));
        case '/set_radius':
          return void (await this.cmdRadius(chatId, rest));
        case '/lacak':
          return void (await this.cmdTrack(chatId, rest));
        case '/stop_lacak':
          return void (await this.cmdTrackStop(chatId, rest));
        case '/kiosk':
          return void (await this.cmdKiosk(chatId, rest));
        case '/rename':
          return void (await this.cmdRename(chatId, rest));
        case '/reboot':
          return void (await this.askConfirm(chatId, rest, 'reboot', 'Reboot perangkat?'));
        case '/hapus_data':
          return void (await this.askConfirm(chatId, rest, 'wipe', 'Hapus data Guard & kunci permanen?'));
        case '/rotasi_token':
          return void (await this.cmdRotateToken(chatId, rest));
        case '/perintah':
          return void (await this.tg.send(chatId, this.renderCatalog()));
        case '/audit':
          return void (await this.cmdAudit(chatId, rest));
        case '/stat':
        case '/statistik':
          return void (await this.cmdStat(chatId));
        case '/uji':
          return void (await this.cmdSelftest(chatId));
        default:
          return void (await this.tg.send(chatId, `❓ Command tidak dikenal: ${esc(cmd)}\n${HELP}`));
      }
    } catch (e) {
      const msgText =
        e instanceof CommandError ? `❌ ${e.message}` : `❌ Error: ${e.message}`;
      await this.tg.send(chatId, msgText).catch(() => {});
      if (!(e instanceof CommandError)) log.error('command error', { cmd, err: e.message });
    }
  }

  // ------------------------------------------------- resolusi nama device --
  /**
   * @returns {object|null} device, atau null bila ambigu (sudah dikirim kandidat)
   */
  async pickDevice(chatId, query, action) {
    const devices = await devicesRepo.all();
    if (!devices.length) {
      await this.tg.send(chatId, 'Belum ada device terdaftar. Jalankan: <code>npm run onboard -- batch</code>');
      return null;
    }
    if (!query) {
      await this.tg.send(chatId, '❓ Sebut nama device, contoh: <code>/status HP-001</code>');
      return null;
    }
    const res = resolveDevice(devices, query);
    if (res.status === 'exact') return res.device;
    if (res.status === 'ambiguous') {
      const rid = Math.random().toString(36).slice(2, 10);
      this.sessions.set(chatId, { action, candidates: res.candidates, at: Date.now() });
      await this.tg.send(
        chatId,
        `🤔 <b>${esc(res.reason)}</b>\nPencarian: <code>${esc(query)}</code>\n\n${formatCandidates(
          res.candidates,
        )}\n\nPilih device yang benar di bawah:`,
        {
          reply_markup: {
            inline_keyboard: res.candidates
              .slice(0, 8)
              .map((d) => [
                {
                  text: `${d.is_online ? '🟢' : '⚫'} ${d.nama_device}`.slice(0, 60),
                  callback_data: `pick:${rid}:${d.device_id}`,
                },
              ])
              .concat([[{ text: '❌ Batal', callback_data: 'pickcancel' }]]),
          },
        },
      );
      return null;
    }
    await this.tg.send(
      chatId,
      `❌ Device <code>${esc(query)}</code> tidak ditemukan.\nKetik <code>/daftar</code> untuk melihat semua nama.`,
    );
    return null;
  }

  // ------------------------------------------------------------ commands --
  async cmdList(chatId, filter = '', msg) {
    let devices = await devicesRepo.all();
    if (filter) {
      const f = filter.toLowerCase();
      devices = devices.filter(
        (d) =>
          d.nama_device.toLowerCase().includes(f) ||
          d.device_id.toLowerCase().includes(f) ||
          d.status_sewa.includes(f) ||
          (d.nama_penyewa || '').toLowerCase().includes(f),
      );
    }
    const stat = await devicesRepo.countByStatus();
    const lines = [
      `<b>DAFTAR DEVICE</b>  total ${stat.total} · 🟢 online ${stat.online} · 🟧 disewa ${stat.disewa} · 🟥 hilang ${stat.hilang}`,
      '',
    ];
    for (const d of devices.slice(0, 60)) lines.push(deviceLine(d));
    if (!devices.length) lines.push('(tidak ada device yang cocok)');
    await this.tg.send(chatId, lines.join('\n'), {
      reply_to_message_id: msg?.message_id,
      reply_markup: kbList(await devicesRepo.all()),
    });
  }

  async cmdStatus(chatId, query) {
    const d = await this.pickDevice(chatId, query, 'status');
    if (!d) return;
    const full = await devicesRepo.byId(d.device_id);
    const loc = await devicesRepo.lastLocation(d.device_id);
    const cmds = await commandsRepo.listByDevice(d.device_id, 5);
    const evs = await eventsRepo.recent(d.device_id, 5);
    const out = [
      `<b>${esc(full.nama_device)}</b>`,
      `id: <code>${esc(full.device_id)}</code>`,
      ``,
      `Status sewa : ${ICON.status[full.status_sewa]} ${full.status_sewa}${
        full.nama_penyewa ? ` (${esc(full.nama_penyewa)})` : ''
      }`,
      `Kunci        : ${ICON.lock[full.policy_state] || '·'} ${full.policy_state}`,
      `Koneksi      : ${full.is_online ? ICON.online + ' online' : ICON.offline + ' offline'} (terakhir ${ago(
        full.last_seen_at,
      )})`,
      `Baterai      : ${batteryText(full.battery_level)}${full.charging ? ' ⚡ charging' : ''}`,
      `Jaringan     : ${esc(full.network_type || '-')} ${full.signal_dbm ?? ''} dBm`,
      `Perangkat    : ${esc(full.manufacturer || '')} ${esc(full.model || '')} · Android ${
        full.android_version || '?'
      } (API ${full.api_level ?? '?'}) · app ${full.app_version || '?'}`,
      `Geofence     : ${full.geofence_armed ? `aktif ⌀${full.radius_meter} m` : 'nonaktif'}`,
      `Lokasi       : ${
        loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)} (±${loc.accuracy ?? '?'}m) ${fmtTime(loc.ts)}` : 'belum ada'
      }`,
      `IMEI         : ${esc(full.imei || '-')}`,
    ];
    if (cmds.length) {
      out.push('', `<b>5 command terakhir</b>`);
      for (const c of cmds) {
        out.push(
          `#${c.id} <code>${esc(c.command_type)}</code> ${c.status} ${c.created_at.slice(11, 19)}${
            c.error ? ` · ${esc(c.error)}` : ''
          }`,
        );
      }
    }
    if (evs.length) {
      out.push('', `<b>5 event terakhir</b>`);
      for (const e of evs) {
        out.push(`• ${esc(e.event)} — ${fmtTime(e.created_at)}${e.severity !== 'info' ? ` (${e.severity})` : ''}`);
      }
    }
    await this.tg.send(chatId, out.join('\n'), { reply_markup: kbDevice(full, full.device_id) });
  }

  async issue(chatId, device, type, payload = {}, { silentOffline = false } = {}) {
    const res = await this.d.dispatch({
      deviceId: device.device_id,
      type,
      payload,
      issuedBy: `bot:chat${chatId}`,
      actorKind: 'telegram',
    });
    const online = this.hub.isOnline(device.device_id);
    if (!online && !silentOffline) {
      await this.tg.send(
        chatId,
        `⏳ <b>${esc(device.nama_device)}</b> sedang OFFLINE.\nCommand <code>${type}</code> (#${res.id}) masuk antrean dan dikirim otomatis saat device online kembali.`,
      );
    }
    return res;
  }

  async cmdLock(chatId, query, _msg) {
    const d = await this.pickDevice(chatId, query, 'lock');
    if (!d) return;
    const parts = query.split(/\s+/);
    const reason = parts.slice(1).join(' ') || 'perintah admin';
    await this.issue(chatId, d, 'lock', { reason });
    await devicesRepo.update(d.device_id, { is_locked: 1 });
    await logEvent(d.device_id, 'lock_issued', 'info', { reason, by: chatId });
    await this.tg.send(
      chatId,
      `🔒 <b>${esc(d.nama_device)}</b> dikunci.\nHP hanya bisa dibuka lewat /unlock. Semua app disuspensi, kamera dimatikan, factory reset diblokir.`,
    );
  }

  async cmdUnlock(chatId, query) {
    const d = await this.pickDevice(chatId, query, 'unlock');
    if (!d) return;
    if (!this.hub.isOnline(d.device_id)) {
      await this.tg.send(chatId, `⚠️ ${esc(d.nama_device)} offline - command unlock diantre.`);
    }
    const res = await this.issue(chatId, d, 'unlock', {});
    const done = await this.d.awaitResult(res.id, 60_000);
    if (!done.ok) return void (await this.tg.send(chatId, `⚠️ Unlock gagal/tidak dijawab: ${done.error || '-'}`));
    await devicesRepo.update(d.device_id, { is_locked: 0 });
    const pin = done.data?.pin;
    await this.tg.send(
      chatId,
      `🔓 <b>${esc(d.nama_device)}</b> terbuka.\n${
        pin ? `PIN layar kunci: <code>${esc(pin)}</code> (simpan, hanya ditampilkan sekali)` : ''
      }`,
    );
  }

  async cmdPin(chatId, query) {
    const d = await this.pickDevice(chatId, query, 'pin');
    if (!d) return;
    const res = await this.issue(chatId, d, 'pin', {});
    const done = await this.d.awaitResult(res.id, 40_000);
    if (!done.ok) return void (await this.tg.send(chatId, `⚠️ Gagal ambil PIN: ${done.error || '-'}`));
    await this.tg.send(
      chatId,
      `🔑 PIN <b>${esc(d.nama_device)}</b>: <code>${esc(done.data?.pin || '?')}</code>\n<i>pesan ini bisa dihapus oleh admin</i>`,
    );
    await this.tg
      .send(chatId, '🔑 PIN (rahasia): hapus pesan ini setelah dicatat.', {
        reply_markup: { inline_keyboard: [[{ text: '🗑 Hapus pesan', callback_data: 'del' }]] },
      })
      .catch(() => {});
  }

  async cmdLocate(chatId, query) {
    const d = await this.pickDevice(chatId, query, 'locate');
    if (!d) return;
    if (!this.hub.isOnline(d.device_id))
      return void (await this.tg.send(chatId, `⚫ ${esc(d.nama_device)} offline - lokasi terakhir tidak bisa diperbarui.`));
    const res = await this.issue(chatId, d, 'locate', { accuracy: 'high' }, { silentOffline: true });
    const done = await this.d.awaitResult(res.id, 45_000);
    const loc = done.data?.location;
    if (!done.ok || !loc)
      return void (await this.tg.send(chatId, `⚠️ Lokasi gagal: ${done.error || 'tidak ada data'}`));
    await this.tg.sendLocation(chatId, loc.lat, loc.lng, {
      caption: `📍 <b>${esc(d.nama_device)}</b>\n±${loc.accuracy ?? '?'}m · ${loc.source || 'fused'} · ${
        done.data?.battery !== undefined ? `${done.data.battery}%` : ''
      } · ${fmtTime(loc.ts)}`,
    });
    // Simpan juga ke riwayat supaya /riwayat_lokasi langsung punya data
    await locationsRepo.insert(d.device_id, { ...loc, source: loc.source || 'manual' });
  }

  async cmdHistory(chatId, query) {
    const parts = query.split(/\s+/);
    const d = await this.pickDevice(chatId, parts[0], 'riwayat');
    if (!d) return;
    const hours = Math.min(720, Math.max(1, Number(parts[1]) || 6));
    const rows = await locationsRepo.recent(d.device_id, hours, 300);
    if (!rows.length) return void (await this.tg.send(chatId, `📭 Tidak ada titik lokasi dalam ${hours} jam terakhir.`));
    const first = rows[rows.length - 1];
    const last = rows[0];
    await this.tg.sendLocation(chatId, last.lat, last.lng, {
      caption: `🧭 <b>${esc(d.nama_device)}</b> - ${hours} jam terakhir\n${rows.length} titik · ${
        last.ts
      }`,
    });
    const lines = ['<b>Riwayat (10 terakhir)</b>'];
    for (const r of rows.slice(0, 10)) {
      lines.push(
        `${fmtTime(r.ts)} · ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)} ±${r.accuracy ?? '?'}m${
          r.breach ? ' ⚠️ luar geofence' : ''
        }`,
      );
    }
    lines.push(`\nPindah total: dari ${fmtTime(first.ts)} ke ${fmtTime(last.ts)}`);
    await this.tg.send(chatId, lines.join('\n'));
  }

  async cmdCamera(chatId, query, kind) {
    const d = await this.pickDevice(chatId, query, `camera_${kind}`);
    if (!d) return;
    if (!this.hub.isOnline(d.device_id))
      return void (await this.tg.send(chatId, `⚫ ${esc(d.nama_device)} offline, kamera tidak bisa diakses.`));
    const label = kind === 'front' ? '📷 kamera depan' : '📷 kamera belakang';
    await this.tg.send(chatId, `⏳ Mengambil ${label} dari <b>${esc(d.nama_device)}</b>...`);
    const res = await this.issue(chatId, d, `camera_${kind}`, {}, { silentOffline: true });
    const done = await this.d.awaitResult(res.id, 70_000);
    if (!done.ok || !done.data?.mediaId)
      return void (await this.tg.send(chatId, `⚠️ Gagal ambil foto: ${done.error || 'tidak ada media'}`));
    const buf = await this.readMedia(done.data.mediaId);
    if (!buf) return void (await this.tg.send(chatId, '⚠️ File foto tidak bisa didekripsi (key server berubah?).'));
    const loc = done.data.location || (await devicesRepo.lastLocation(d.device_id));
    const caption = `📷 <b>${esc(d.nama_device)}</b> · ${kind}${
      loc ? `\n📍 ${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : ''
    }\n🕒 ${fmtTime(done.data.ts || new Date().toISOString())}`;
    await this.tg
      .photo(chatId, buf, { caption })
      .catch(async (e) => {
        log.warn('sendPhoto gagal, kirim sebagai document', { err: e.message });
        await this.tg.document(chatId, buf, `${d.device_id}-${kind}.jpg`, { caption });
      });
  }

  async readMedia(mediaId) {
    const m = await mediaRepo.byId(mediaId);
    if (!m) return null;
    try {
      const enc = await fs.readFile(path.join(config.runtime.mediaDir, m.file));
      return decryptBuffer(enc);
    } catch (e) {
      log.error('baca media gagal', { mediaId, err: e.message });
      return null;
    }
  }

  async cmdRing(chatId, query) {
    const d = await this.pickDevice(chatId, query, 'ring');
    if (!d) return;
    await this.issue(chatId, d, 'ring', { seconds: 20 });
    await this.tg.send(chatId, `🔔 Alarm dibunyikan di <b>${esc(d.nama_device)}</b>.`);
  }

  async cmdToast(chatId, query) {
    const m = query.match(/^(\S+)\s+([\s\S]+)$/);
    if (!m) return void (await this.tg.send(chatId, 'Format: <code>/pesan HP-001 Kembalikan HP ke toko</code>'));
    const d = await this.pickDevice(chatId, m[1], 'pesan');
    if (!d) return;
    await this.issue(chatId, d, 'toast', { text: m[2] });
    await this.tg.send(chatId, `💬 Pesan dikirim ke <b>${esc(d.nama_device)}</b>.`);
  }

  async cmdMarkLost(chatId, query) {
    const d = await this.pickDevice(chatId, query, 'hilang');
    if (!d) return;
    await devicesRepo.update(d.device_id, { status_sewa: 'hilang', is_locked: 1 });
    await logEvent(d.device_id, 'marked_lost', 'critical', { by: chatId });
    const tasks = [
      ['lock', { reason: 'perceived hilang' }],
      ['track_start', { intervalSec: 30, untilSec: 21600 }],
      ['locate', { accuracy: 'high' }],
    ];
    for (const [type, payload] of tasks) {
      await this.issue(chatId, d, type, payload, { silentOffline: true }).catch(() => {});
    }
    await this.tg.send(
      chatId,
      `🟥 <b>${esc(d.nama_device)}</b> ditandai HILANG.\n• status_sewa = hilang\n• auto-lock dikirim\n• pelacakan tiap 30 detik selama 6 jam\n\nUntuk normalkan: /tandai_tersedia ${esc(d.device_id)}`,
    );
  }

  async cmdMarkRented(chatId, query) {
    const m = query.match(/^(\S+)\s+([\s\S]+)$/);
    if (!m) return void (await this.tg.send(chatId, 'Format: <code>/tandai_disewa HP-001 Budi</code>'));
    const d = await this.pickDevice(chatId, m[1], 'disewa');
    if (!d) return;
    await devicesRepo.update(d.device_id, { status_sewa: 'disewa', nama_penyewa: m[2].slice(0, 120) });
    await this.tg.send(chatId, `🟧 <b>${esc(d.nama_device)}</b> -> disewa oleh <b>${esc(m[2])}</b>.`);
  }

  async cmdMarkFree(chatId, query) {
    const d = await this.pickDevice(chatId, query, 'tersedia');
    if (!d) return;
    await this.d.cancelPending(d.device_id, 'device ditandai tersedia').catch(() => {});
    await devicesRepo.update(d.device_id, { status_sewa: 'tersedia', nama_penyewa: null });
    await this.tg.send(chatId, `🟦 <b>${esc(d.nama_device)}</b> -> tersedia, antrean command dibersihkan.`);
  }

  async cmdSetSewa(chatId, query, status) {
    const d = await this.pickDevice(chatId, query, status);
    if (!d) return;
    await devicesRepo.update(d.device_id, { status_sewa: status });
    await this.tg.send(chatId, `🛠 <b>${esc(d.nama_device)}</b> -> ${status}.`);
  }

  async cmdRadius(chatId, query) {
    const parts = query.split(/\s+/);
    const d = await this.pickDevice(chatId, parts[0], 'radius');
    if (!d) return;
    const meter = Number(parts[1]);
    if (!Number.isFinite(meter) || meter < 0)
      return void (await this.tg.send(chatId, 'Format: <code>/set_radius HP-001 200</code> (meter, 0 = matikan)'));
    const armed = meter > 0;
    await devicesRepo.update(d.device_id, { radius_meter: Math.round(meter), geofence_armed: armed ? 1 : 0 });
    await this.issue(chatId, d, 'set_geofence', { radiusM: Math.round(meter), armed }, { silentOffline: true }).catch(
      () => {},
    );
    await this.tg.send(
      chatId,
      armed
        ? `📍 Geofence <b>${esc(d.nama_device)}</b> = ${Math.round(meter)} m (titik acuan: lokasi sekarang).`
        : `📍 Geofence <b>${esc(d.nama_device)}</b> dimatikan.`,
    );
  }

  async cmdTrack(chatId, query) {
    const parts = query.split(/\s+/);
    const d = await this.pickDevice(chatId, parts[0], 'lacak');
    if (!d) return;
    const minutes = Math.min(720, Math.max(1, Number(parts[1]) || 15));
    await this.issue(chatId, d, 'track_start', {
      intervalSec: 30,
      untilSec: minutes * 60,
    });
    await this.tg.send(chatId, `🛰 Lacak <b>${esc(d.nama_device)}</b> tiap 30 detik selama ${minutes} menit.`);
  }

  async cmdTrackStop(chatId, query) {
    const d = await this.pickDevice(chatId, query, 'stop_lacak');
    if (!d) return;
    await this.issue(chatId, d, 'track_stop', {});
    await this.tg.send(chatId, `🛑 Pelacakan <b>${esc(d.nama_device)}</b> dihentikan.`);
  }

  async cmdKiosk(chatId, query) {
    const parts = query.split(/\s+/);
    const d = await this.pickDevice(chatId, parts[0], 'kiosk');
    if (!d) return;
    const on = /on|1|ya|aktif/i.test(parts[1] || 'on');
    await this.issue(chatId, d, 'set_kiosk', { enabled: on });
    await this.tg.send(chatId, `${on ? '📌' : '🔓'} Kiosk <b>${esc(d.nama_device)}</b> ${on ? 'AKTIF' : 'nonaktif'}.`);
  }

  async cmdRename(chatId, query) {
    const m = query.match(/^(\S+)\s+([\s\S]+)$/);
    if (!m) return void (await this.tg.send(chatId, 'Format: <code>/rename HP-001 HP-001-TOKO-B</code>'));
    const d = await this.pickDevice(chatId, m[1], 'rename');
    if (!d) return;
    const newName = m[2].trim().slice(0, 120);
    const clash = await devicesRepo.byNameExact(newName);
    if (clash && clash.device_id !== d.device_id)
      return void (await this.tg.send(chatId, `❌ Nama <code>${esc(newName)}</code> sudah dipakai ${esc(clash.device_id)}.`));
    await devicesRepo.update(d.device_id, { nama_device: newName });
    await this.issue(chatId, d, 'sync_config', {}, { silentOffline: true }).catch(() => {});
    await this.tg.send(chatId, `✏️ <code>${esc(d.device_id)}</code> -&gt; <b>${esc(newName)}</b>.`);
  }

  async askConfirm(chatId, query, action, label) {
    const d = await this.pickDevice(chatId, query, action);
    if (!d) return;
    this.sessions.set(chatId, { action, deviceId: d.device_id, at: Date.now() });
    await this.tg.send(chatId, `⚠️ <b>${label}</b>\nDevice: <code>${esc(d.nama_device)}</code>`, {
      reply_markup: kbYesNo(action, `${action}:yes`, `${action}:no`),
    });
  }

  async cmdRotateToken(chatId, query) {
    const a = await adminsRepo.byTelegramChatId(chatId);
    const isEnvSuper = config.telegram.adminChatIds.includes(Number(chatId));
    if (!isEnvSuper && (!a || a.role !== 'superadmin'))
      return void (await this.tg.send(chatId, '⛔️ Hanya superadmin yang bisa rotasi token.'));
    const d = await this.pickDevice(chatId, query, 'rotasi');
    if (!d) return;
    const { token, pairCode } = await devicesRepo.rotateToken(d.device_id);
    await auditRepo.write({
      actor: `bot:${chatId}`,
      action: 'device.token.rotate',
      target: d.device_id,
      detail: { by: chatId },
    });
    await this.tg.send(
      chatId,
      `🔁 Token <b>${esc(d.nama_device)}</b> dirotasi.\nKode pairing baru (beri ke staff, sekali pakai): <code>${esc(pairCode)}</code>\nDevice dengan token lama akan ditolak sampai pairing ulang.`,
    );
    log.info('token dirotasi', { deviceId: d.device_id, pairCodePreview: `${pairCode.slice(0, 2)}***` });
  }

  async cmdAudit(chatId, query) {
    const limit = Math.min(50, Math.max(5, Number(query) || 15));
    const rows = await auditRepo.recent(limit);
    const lines = ['<b>AUDIT TERAKHIR</b>'];
    for (const r of rows) {
      lines.push(
        `${r.created_at.slice(11, 19)} ${r.ok ? '✅' : '⛔️'} <code>${esc(r.action)}</code> ${
          r.target ? esc(r.target) : ''
        } <i>${esc(r.actor)}</i>`,
      );
    }
    await this.tg.send(chatId, lines.join('\n'));
  }

  async cmdStat(chatId) {
    const stat = await devicesRepo.countByStatus();
    const hub = this.hub.stats();
    const recent = await commandsRepo.listRecent(8);
    const lines = [
      '<b>STATISTIK SERVER</b>',
      `Total device : ${stat.total}`,
      `Online       : ${stat.online}`,
      `Tersedia ${stat.tersedia} · Sewa ${stat.disewa} · Hilang ${stat.hilang} · Maintenance ${stat.maintenance}`,
      `Sesi WS      : ${hub.sessions}`,
      `Server       : ${config.serverName}`,
      '',
      '<b>Command terakhir</b>',
      ...recent.map(
        (c) =>
          `#${c.id} ${esc(c.nama_device || c.device_id)} <code>${esc(c.command_type)}</code> ${c.status}`,
      ),
    ];
    await this.tg.send(chatId, lines.join('\n'));
  }

  async cmdSelftest(chatId) {
    const checks = [
      ['db', !!(await devicesRepo.countByStatus())],
      ['telegram', true],
      ['ws hub', true],
    ];
    const ok = checks.every(([, v]) => v);
    await this.tg.send(
      chatId,
      `<b>UJI SISTEM</b>\n${checks
        .map(([n, v]) => `${v ? '✅' : '❌'} ${n}`)
        .join('\n')}\n${ok ? 'Semua komponen hidup.' : 'Ada komponen bermasalah.'}`,
    );
  }

  renderCatalog() {
    const rows = listCatalog();
    return [
      '<b>DAFTAR COMMAND TERSEDIA</b>',
      ...rows.map((r) => `${r.destructive ? '⚠️' : '•'} <code>${r.type}</code> — ${r.describe}`),
    ].join('\n');
  }

  // ----------------------------------------------------------- callbacks --
  async onCallback(cb) {
    const chatId = cb.message?.chat?.id;
    const data = String(cb.data || '');
    const [cmd, ...rest] = data.split(':');
    const authorized = await this.isAllowed(chatId);
    if (!authorized) {
      await this.tg.answerCb(cb.id, 'Akses ditolak', true);
      return auditRepo.write({
        actor: `tg:${chatId}`,
        action: 'access.denied',
        target: data,
        ok: false,
      });
    }
    try {
      if (cmd === 'del') {
        await this.tg.deleteMsg(chatId, cb.message.message_id);
        return;
      }
      if (cmd === 'pickcancel') {
        this.sessions.delete(chatId);
        await this.tg.answerCb(cb.id, 'Dibatalkan');
        await this.tg.edit(chatId, cb.message.message_id, 'Dibatalkan.', { reply_markup: undefined }).catch(() => {});
        return;
      }
      if (cmd === 'pick') {
        const [, , deviceId] = rest;
        const s = this.sessions.get(chatId);
        if (!s || Date.now() - s.at > PICK_TTL_MS) {
          await this.tg.answerCb(cb.id, 'Sesi kedaluwarsa, ulangi perintah', true);
          return;
        }
        const d = await devicesRepo.byId(deviceId);
        if (!d) return void (await this.tg.answerCb(cb.id, 'Device tidak ada', true));
        this.sessions.delete(chatId);
        await this.tg.answerCb(cb.id, `Dipilih: ${d.nama_device}`);
        return void (await this.runAction(chatId, s.action, d, cb));
      }
      if (cmd === 'lock' || cmd === 'unlock' || cmd === 'locate' || cmd === 'ring' || cmd === 'camf' || cmd === 'camb' || cmd === 'refresh') {
        const deviceId = rest[0];
        const d = await devicesRepo.byId(deviceId);
        if (!d) return void (await this.tg.answerCb(cb.id, 'Device tidak ada', true));
        await this.tg.answerCb(cb.id, 'Diproses...');
        if (cmd === 'refresh') return void (await this.cmdStatus(chatId, d.device_id));
        const map = { lock: 'lock', unlock: 'unlock', locate: 'lokasi', ring: 'sound', camf: 'kamera_depan', camb: 'kamera_belakang' };
        return void (await this.runAction(chatId, map[cmd], d, cb));
      }
      if (cmd === 'dev') {
        const d = await devicesRepo.byId(rest.join(':'));
        if (!d) return void (await this.tg.answerCb(cb.id, 'Device tidak ada', true));
        await this.tg.answerCb(cb.id, d.nama_device);
        return void (await this.cmdStatus(chatId, d.device_id));
      }
      if (cmd === 'reboot' || cmd === 'wipe') {
        if (rest[0] === 'no') {
          this.sessions.delete(chatId);
          await this.tg.answerCb(cb.id, 'Dibatalkan');
          await this.tg.edit(chatId, cb.message.message_id, '❌ Dibatalkan.').catch(() => {});
          return;
        }
        if (rest[0] !== 'yes') return void (await this.tg.answerCb(cb.id, 'Klik Ya dulu', true));
        const s = this.sessions.get(chatId);
        if (!s || Date.now() - s.at > CONFIRM_TTL_MS)
          return void (await this.tg.answerCb(cb.id, 'Konfirmasi kedaluwarsa, ulangi perintah', true));
        const d = await devicesRepo.byId(s.deviceId);
        this.sessions.delete(chatId);
        await this.tg.answerCb(cb.id, 'Dikerjakan');
        await this.tg.edit(chatId, cb.message.message_id, `⚙️ <code>${cmd}</code> dikirim ke ${esc(d?.nama_device || '-')}`);
        if (cmd === 'wipe') await auditRepo.write({ actor: `bot:${chatId}`, action: 'device.wipe', target: s.deviceId });
        return void (await this.issue(chatId, d, cmd, {}));
      }
      if (cmd === 'no') {
        this.sessions.delete(chatId);
        await this.tg.answerCb(cb.id, 'Dibatalkan');
        return;
      }
      await this.tg.answerCb(cb.id, 'Aksi tidak dikenal');
    } catch (e) {
      log.error('callback error', { data, err: e.message });
      await this.tg.answerCb(cb.id, `Error: ${e.message}`, true).catch(() => {});
    }
  }

  async runAction(chatId, action, d, cb) {
    switch (action) {
      case 'status':
        return this.cmdStatus(chatId, d.device_id);
      case 'lock':
        return this.cmdLock(chatId, d.nama_device);
      case 'unlock':
        return this.cmdUnlock(chatId, d.device_id);
      case 'lokasi':
      case 'locate':
        return this.cmdLocate(chatId, d.device_id);
      case 'ring':
        return this.cmdRing(chatId, d.device_id);
      case 'camera_front':
        return this.cmdCamera(chatId, d.nama_device, 'front');
      case 'camera_rear':
        return this.cmdCamera(chatId, d.nama_device, 'rear');
      case 'riwayat':
        return this.cmdHistory(chatId, `${d.device_id} 6`);
      case 'hilang':
        return this.cmdMarkLost(chatId, d.device_id);
      case 'disewa':
        return this.tg.send(
          chatId,
          `Siap. Kirim nama penyewa:\n<code>/tandai_disewa ${esc(d.device_id)} nama_penyewa</code>`,
        );
      case 'tersedia':
        return this.cmdMarkFree(chatId, d.device_id);
      case 'maintenance':
        return this.cmdSetSewa(chatId, d.device_id, 'maintenance');
      case 'radius':
        return this.tg.send(
          chatId,
          `Kirim radiusnya:\n<code>/set_radius ${esc(d.device_id)} 200</code> (meter, 0 = matikan)`,
        );
      case 'kiosk':
        return this.tg.send(chatId, `Kilkas:\n<code>/kiosk ${esc(d.device_id)} on|off</code>`);
      case 'rename':
        return this.tg.send(chatId, `Kirim nama baru:\n<code>/rename ${esc(d.device_id)} HP-001-TOKO-B</code>`);
      case 'track':
        return this.tg.send(chatId, `Kirim durasi (menit):\n<code>/lacak ${esc(d.device_id)} 15</code>`);
      case 'stop_lacak':
        return this.cmdTrackStop(chatId, d.device_id);
      case 'pin':
        return this.cmdPin(chatId, d.device_id);
      case 'pesan':
        return this.tg.send(
          chatId,
          `Kirim isi pesan:\n<code>/pesan ${esc(d.device_id)} Kembalikan HP ke toko</code>`,
        );
      case 'reboot':
      case 'wipe':
        return this.askConfirm(chatId, d.device_id, action, action === 'wipe' ? 'Hapus data?' : 'Reboot?');
      case 'rotasi':
        return this.cmdRotateToken(chatId, d.device_id);
      default:
        if (cb) await this.tg.answerCb(cb.id, 'OK');
    }
  }

  // -------------------------------------------------------------- alerts --
  initAlerts() {
    bus.on('alert', async (a) => {
      const targets = new Set(this.allowed);
      if (config.telegram.alertGroupChatId) targets.add(config.telegram.alertGroupChatId);
      const icon = a.level === 'critical' ? '🟥' : '🟧';
      for (const t of targets) {
        await this.tg
          .send(t, `${icon} <b>ALERT</b>\n${esc(a.text)}`, { reply_markup: kbDevice({ device_id: a.deviceId }, a.deviceId) })
          .catch(() => {});
      }
    });
  }
}
