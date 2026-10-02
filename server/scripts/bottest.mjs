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
  async deleteMsg() {
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
  esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
};

let pass = 0;
let fail = 0;
const ok = (n, c, x = '') => {
  if (c) {
    pass++;
    console.log(`  ✅ ${n}${x ? ` — ${x}` : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${n}${x ? ` — ${x}` : ''}`);
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
const devices = await devicesRepo.all();
if (devices.length < 2) {
  console.error('Butuh minimal 2 device untuk uji ini. Jalankan: npm run onboard -- batch --count 3 --group UJI');
  process.exit(1);
}
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

console.log(`\nHASIL: ${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
