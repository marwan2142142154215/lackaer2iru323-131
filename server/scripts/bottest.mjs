#!/usr/bin/env node
// Uji handler bot TANPA memanggil API Telegram (notifier palsu).
// Memverifikasi: whitelist, daftar, fuzzy-match/ambigu, status, command,
//  validasi argumen, konfirmasi destructive, dan RBAC.
// Prasyarat: server + simulator sudah jalan, dan ada >1 device untuk uji ambiguitas.
import { openDb } from '../src/db/index.js';
import { devicesRepo, adminsRepo, auditRepo, commandsRepo } from '../src/db/repos.js';
import { CommandDispatcher } from '../src/commands/dispatcher.js';
import { DeviceHub } from '../src/net/hub.js';
import { TelegramBot } from '../src/telegram/bot.js';
import { resolveDevice } from '../src/telegram/device-resolver.js';

const CHAT = 999_001;
const outbox = [];

const fakeTg = {
  async send(chat, text, extra = {}) {
    outbox.push({ kind: 'send', chat, text, extra });
    return { message_id: outbox.length };
  },
  async reply(msg, text, extra = {}) {
    return fakeTg.send(msg.chat.id, text, extra);
  },
  async edit(chat, id, text, extra = {}) {
    outbox.push({ kind: 'edit', chat, text, extra });
    return {};
  },
  async photo(chat, buf, extra = {}) {
    outbox.push({ kind: 'photo', chat, bytes: buf.length, extra });
    return {};
  },
  async document(chat, buf, name, extra = {}) {
    outbox.push({ kind: 'document', chat, bytes: buf.length, name });
    return {};
  },
  async sendLocation(chat, lat, lng, extra = {}) {
    outbox.push({ kind: 'location', chat, lat, lng, extra });
    return {};
  },
  async answerCb() {
    return {};
  },
  async deleteMsg(chat, id) {
    fakeTg.deleted.push({ chat, id });
    return {};
  },
  async getMe() {
    return { id: 1, username: 'test_bot' };
  },
  async setCommands() {
    return {};
  },
  async getUpdates() {
    return [];
  },
  async sleep() {},
  deleted: [],
  esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
};

let pass = 0;
let fail = 0;
const ok = (n, c, x = '') => {
  if (c) {
    pass++;
    console.log(`  âœ… ${n}${x ? ` â€” ${x}` : ''}`);
  } else {
    fail++;
    console.log(`  âŒ ${n}${x ? ` â€” ${x}` : ''}`);
  }
};
const last = () => outbox[outbox.length - 1];

function msg(text) {
  return {
    message_id: outbox.length + 1,
    chat: { id: CHAT, type: 'private' },
    from: { id: 42, username: 'andi' },
    text,
  };
}

await openDb();
const dispatcher = new CommandDispatcher();
const hub = new DeviceHub(dispatcher);
// Hub tidak di-attach ke HTTP server; tandai device online manual agar
// bot tidak thinks device offline.
const allDevices = await devicesRepo.all();
// PENTING: uji ini me-RENAME device. Jangan pernah menyentuh device
// produksi. Hanya device uji (seed-test-devices) yang boleh dipakai.
const devices = allDevices.filter(
  (d) => /^HP-0\d+$/.test(d.device_id) || String(d.nama_device).startsWith('UJI-'),
);
if (devices.length < 2) {
  console.error(
    `Butuh minimal 2 device UJI (HP-001..), bukan device produksi.\n` +
      `Ditemukan ${allDevices.length} device, ${devices.length} di antaranya device uji.\n` +
      `Jalankan dulu: node scripts/seed-test-devices.mjs`,
  );
  process.exit(1);
}
console.log(`  memakai ${devices.length} device uji: ${devices.map((d) => d.device_id).join(', ')}`);
for (const d of devices) hub.sessions.set(d.device_id, { ws: { readyState: 1 }, ip: 'test', alive: true });

const bot = new TelegramBot({ dispatcher, hub, notifier: fakeTg });
bot.allowed.add(CHAT);

// dispatcher memakai koneksi dummy supaya thinks device online & bisa kirim frame
for (const d of devices) {
  dispatcher.attach(d.device_id, { send: () => true, isOpen: () => true });
}

console.log('\nUJI HANDLER BOT TELEGRAM (offline)\n');

// 1. daftar -----------------------------------------------------------------
await bot.onMessage(msg('/daftar'));
ok('/daftar', /DAFTAR DEVICE/.test(last().text), last().text.split('\n')[1]);

// 2. status dengan nama persis --------------------------------------------
const target = devices[0];
await bot.onMessage(msg(`/status ${target.nama_device}`));
ok('/status nama persis', new RegExp(target.nama_device.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(last().text));
ok('/status ada tombol aksi', !!last().extra?.reply_markup?.inline_keyboard?.length);

// 3. singkatan / prefix ------------------------------------------------------
await bot.onMessage(msg(`/status ${target.device_id}`));
ok('/status pakai device_id', new RegExp(target.nama_device.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(last().text));

// 4. nama ngawur -> harus minta kandidat, TIDAK eksekusi ---------------------
const before = await commandsRepo.pendingCount(target.device_id);
await bot.onMessage(msg('/lokasi definitely-not-a-device'));
ok('nama tak dikenal ditolak', /tidak ditemukan/.test(last().text), last().text.split('\n')[0]);
ok('tidak ada command yg terkirim', (await commandsRepo.pendingCount(target.device_id)) === before);

// 5. prefix ambigu -> kandidat (butuh >1 device dengan prefix sama)
{
  // "/status HP-00" cocok beberapa device
  const r = await bot.onMessage(msg('/status HP-00'));
  const t = last().text;
  ok(
    'prefix ambigu menampilkan kandidat',
    /beberapa device cocok|Pilih device/.test(t),
    t.split('\n').slice(0, 2).join(' ').slice(0, 80),
  );
  ok('kandidat pakai tombol inline', (last().extra?.reply_markup?.inline_keyboard || []).length > 1);
}

// 6. resolver murni -----------------------------------------------------------
{
  const res = resolveDevice(devices, target.nama_device.toLowerCase());
  ok('resolver exact (case-insensitive)', res.status === 'exact' && res.device.device_id === target.device_id);
  const res2 = resolveDevice(devices, 'zzz-not-there');
  ok('resolver notfound', res2.status === 'notfound');
  const res3 = resolveDevice(devices, target.nama_norm.slice(0, 5));
  ok('resolver prefix unik', res3.status === 'exact' || res3.status === 'ambiguous', res3.status);
}

// 7. lock + ring --------------------------------------------------------------
await bot.onMessage(msg(`/lock ${target.nama_device} alasan: cek mingguan`));
ok('/lock mengonfirmasi', /dikunci/.test(outbox.slice(-2).map((o) => o.text).join(' ')));
await bot.onMessage(msg(`/sound ${target.nama_device}`));
ok('/sound terkirim', /Alarm dibunyikan/.test(last().text));

// 8. validasi argumen radius --------------------------------------------------
await bot.onMessage(msg(`/set_radius ${target.nama_device} abc`));
ok('/set_radius tolak nilai buruk', /Format:/.test(last().text));

// 9. tandai disewa perlu nama penyewa ---------------------------------------
await bot.onMessage(msg(`/tandai_disewa ${target.nama_device}`));
ok('/tandai_disewa tanpa nama ditolak', /Format:/.test(last().text));
await bot.onMessage(msg(`/tandai_disewa ${target.nama_device} Budi Santoso`));
ok('/tandai_disewa OK', /disewa oleh/.test(last().text));
await bot.onMessage(msg(`/tandai_tersedia ${target.nama_device}`));
ok('/tandai_tersedia OK', /tersedia/.test(last().text));

// 10. radius valid -------------------------------------------------------------
await bot.onMessage(msg(`/set_radius ${target.nama_device} 250`));
ok('/set_radius OK', /Geofence/.test(last().text), last().text.slice(0, 70));

// 11. destructive perlu konfirmasi -------------------------------------------
await bot.onMessage(msg(`/reboot ${target.nama_device}`));
ok('/reboot minta konfirmasi', /Konfirmasi|lanjut/.test(last().text) || last().extra?.reply_markup);

// 12. rename menabrak nama yang dipakai ---------------------------------------
await bot.onMessage(msg(`/rename ${target.nama_device} ${devices[1].nama_device}`));
ok('/rename tolak nama bentrok', /sudah dipakai/.test(last().text));

// 13. RBAC: chat tidak di-whitelist ------------------------------------------
{
  const stranger = { message_id: 1, chat: { id: 777_777, type: 'private' }, from: { id: 9, username: 'asing' }, text: '/daftar' };
  const n = outbox.length;
  await bot.onMessage(stranger);
  ok('chat asing ditolak', outbox.length > n && /Akses ditolak/.test(outbox[n]?.text || ''), outbox[n]?.text?.slice(0, 40) || '(tidak ada balasan)');
  const audit = await auditRepo.recent(1);
  ok('percobaan asing masuk audit', audit[0]?.action === 'access.denied', audit[0]?.action);
}

// 14. command catalog --------------------------------------------------------
await bot.onMessage(msg('/perintah'));
ok('/perintah daftar catalog', /camera_rear/.test(last().text) && /wipe/.test(last().text));

// 15. rename valid (nama baru boleh ber-spasi) -------------------------------
{
  const before = target.nama_device;
  const newName = 'Marwan Punya';
  await bot.onMessage(msg(`/rename ${before} ${newName}`));
  ok('/rename terima nama ber-spasi', new RegExp(newName).test(last().text), last().text.slice(0, 60));
  const after = await devicesRepo.byId(target.device_id);
  ok('/rename tersimpan di DB', after?.nama_device === newName, after?.nama_device);
  // kembalikan supaya uji lain tidak terpengaruh
  await devicesRepo.update(target.device_id, { nama_device: before });
}

// 16. tambah admin: gerbang + hashing ---------------------------------------
{
  const { hashPassword: hp, verifyPassword: vp } = await import('../src/crypto/box.js');
  const { settingsRepo: sr, db } = await import('../src/db/repos.js').then(async (m) => ({
    settingsRepo: m.settingsRepo,
    db: (await import('../src/db/index.js')).db,
  }));
  await sr.set('smb.gate', hp('SANDI_GERBANG_ANDA'));

  // Bersihkan sisa akun uji dari run sebelumnya (kalau ada) supaya uji ini
  // idempotent - deactivate() hanya menonaktifkan, username tetap terpakai.
  await db().run('DELETE FROM admin_users WHERE username = ?', ['stafbaru']);

  // onMessage() memverifikasi via adminsRepo.byTelegramChatId(chatId). CHAT
  // harus tertaut ke akun superadmin agar lolos gerbang whitelist.
  const ADMIN_ID = 1; // admin 'andi' yang sudah superadmin
  // SIMPAN nilai asli - jangan sampai uji ini mencabut tautan Telegram owner.
  const adminRow = await adminsRepo.byId(ADMIN_ID);
  const savedChat = adminRow.telegram_chat_id;
  const savedRole = adminRow.role;
  const savedActive = adminRow.is_active;
  await db().run('UPDATE admin_users SET telegram_chat_id = ?, is_active = 1, role = ? WHERE id = ?', [
    String(CHAT),
    'superadmin',
    ADMIN_ID,
  ]);
  bot.allowed.add(CHAT);
  bot.allowed.delete(777_777);

  // 16a. sandi gerbang salah -> ditolak
  let n = outbox.length;
  await bot.onMessage(msg('/tambah_admin stafuji salahbanget rahasia123'));
  ok('/tambah_admin tolak gerbang salah', /gerbang salah/.test(outbox[n]?.text || ''), outbox[n]?.text?.slice(0, 40));

  // 16b. username tidak valid -> ditolak
  n = outbox.length;
  await bot.onMessage(msg('/tambah_admin ab SANDI_GERBANG_ANDA rahasia123'));
  ok('/tambah_admin tolak username pendek', /Username 3-32/.test(outbox[n]?.text || ''));

  // 16c. sandi baru terlalu pendek -> ditolak
  n = outbox.length;
  await bot.onMessage(msg('/tambah_admin stafok SANDI_GERBANG_ANDA 123'));
  ok('/tambah_admin tolak sandi pendek', /minimal 8 karakter/.test(outbox[n]?.text || ''));

  // 16d. jalur sukses: /tambah_admin TIDAK menautkan chat pemanggil
  n = outbox.length;
  await bot.onMessage(msg('/tambah_admin stafbaru SANDI_GERBANG_ANDA sandirahasia9'));
  ok('/tambah_admin berhasil', /Admin <b>stafbaru<\/b> dibuat/.test(outbox[n]?.text || ''), outbox[n]?.text?.slice(0, 50));

  const created = await adminsRepo.byUsername('stafbaru');
  ok('/tambah_admin akun tersimpan', !!created, created?.username);
  ok('/tambah_admin peran staff', created?.role === 'staff', created?.role);
  ok('/tambah_admin chat pemanggil TIDAK tertaut', created?.telegram_chat_id == null, String(created?.telegram_chat_id));
  ok('/tambah_admin sandi ter-hash scrypt', String(created?.password_hash || '').startsWith('scrypt$'));
  ok('/tambah_admin sandi tidak tersimpan mentah', !String(created?.password_hash || '').includes('sandirahasia9'));
  ok('/tambah_admin sandi bisa diverifikasi', vp('sandirahasia9', created.password_hash));
  ok('/tambah_admin pesan sandi dihapus', fakeTg.deleted.length > 0, `deleted=${fakeTg.deleted.length}`);

  // 16e. /mulai - pekerja menautkan Telegram-nya sendiri
  const WORKER = 555_444_333;
  const workerMsg = (text) => ({
    message_id: outbox.length + 1,
    chat: { id: WORKER, type: 'private' },
    from: { id: 7, username: 'pekerja1' },
    text,
  });

  n = outbox.length;
  await bot.onMessage(workerMsg('/mulai stafbaru sandisalahsekali'));
  ok('/mulai tolak sandi salah', /Username atau sandi salah/.test(outbox[n]?.text || ''), outbox[n]?.text?.slice(0, 40));

  bot.allowed.delete(WORKER); // pastikan aktivasi yang mengaktifkan, bukan pra-whitelist
  n = outbox.length;
  await bot.onMessage(workerMsg('/mulai stafbaru sandirahasia9'));
  ok('/mulai berhasil', /tertaut ke akun Anda/.test(outbox[n]?.text || ''), outbox[n]?.text?.slice(0, 50));

  const afterLink = await adminsRepo.byUsername('stafbaru');
  ok('/mulai chat pekerja tertaut', String(afterLink?.telegram_chat_id) === String(WORKER), afterLink?.telegram_chat_id);
  ok('/mulai chat pekerja masuk whitelist', await bot.isAllowed(WORKER));

  // 16f. /ganti_sandi oleh pekerja
  n = outbox.length;
  await bot.onMessage(workerMsg('/ganti_sandi sandirahasia9 sandibaru2026'));
  ok('/ganti_sandi berhasil', /berhasil diganti/.test(outbox[n]?.text || ''), outbox[n]?.text?.slice(0, 50));
  const again = await adminsRepo.byUsername('stafbaru');
  ok('/ganti_sandi hash diperbarui', vp('sandibaru2026', again.password_hash));

  // 16g. akun non-superadmin tidak boleh menambah admin
  bot.allowed.add(WORKER);
  n = outbox.length;
  await bot.onMessage(workerMsg('/tambah_admin stafketiga SANDI_GERBANG_ANDA rahasia123'));
  ok('/tambah_admin tolak non-superadmin', /Hanya superadmin/.test(outbox[n]?.text || ''), outbox[n]?.text?.slice(0, 40));

  // bersihkan akun uji, PULIHKAN keadaan owner semula
  await adminsRepo.deactivate('stafbaru');
  await db().run('DELETE FROM admin_users WHERE username = ?', ['stafbaru']);
  bot.allowed.delete(WORKER);
  await db().run(
    'UPDATE admin_users SET telegram_chat_id = ?, role = ?, is_active = ? WHERE id = ?',
    [savedChat, savedRole, savedActive, ADMIN_ID],
  );
}

console.log(`\nHASIL: ${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
