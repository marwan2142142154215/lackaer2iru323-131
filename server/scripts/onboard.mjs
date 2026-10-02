#!/usr/bin/env node
// Onboarding massal: buat device + token + kode pairing + payload QR/NFC enrollment.
//
//   node scripts/onboard.mjs batch --count 200 --group TOKO-A [--start 1] [--qr] [--nfc]
//   node scripts/onboard.mjs add HP-050-TOKO-B
//   node scripts/onboard.mjs list
//   node scripts/onboard.mjs rotate HP-001-TOKO-A
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/index.js';
import { devicesRepo, enrollmentRepo } from '../src/db/repos.js';
import { config } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

// ---------------------------------------------------------------------------
// Nama device WAJIB tanpa spasi.
//
// Bot Telegram mem-parse "/cmd <nama> <argumen>" sebagai token terpisah.
// Nama ber-spasi akan terpotong, membuat setiap perintah jadi ambigu, dan
// berisiko salah kirim ke unit yang keliru - yang persis tidak boleh terjadi.
function assertNamaValid(nama) {
  if (/\s/.test(nama)) {
    throw new Error(
      `nama device tidak boleh mengandung spasi: "${nama}".\n` +
        '  Pakai tanda hubung, contoh: HP-050-TOKO-B-Redmi9',
    );
  }
  if (nama.length > 64) {
    throw new Error(`nama device terlalu panjang (${nama.length} karakter, maks 64)`);
  }
}

// ---------------------------------------------------------------------------
function enrollmentPayload() {
  // Bundle provisioning extras Android Enterprise. Dipakai untuk QR scan
  // (Developer options) dan NFC tag. Menginstal Guard sebagai Device Owner.
  const payload = {
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_NAME': config.enrollment.dpcComponent.split('/')[0],
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': config.enrollment.dpcComponent,
    'android.app.extra.PROVISIONING_SKIP_ENCRYPTION': 'true',
    'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': 'true',
  };
  if (config.enrollment.dpcSignatureSha1)
    payload['android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM'] =
      config.enrollment.dpcSignatureSha1;
  if (config.enrollment.enrollmentToken) {
    payload['android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE'] = {
      'com.google.android.apps.work.clouddpc.EXTRA_ENROLLMENT_TOKEN':
        config.enrollment.enrollmentToken,
    };
  }
  return payload;
}

/** NDEF text record (TNF=1, 'T' dengan status UTF-8) berisi payload JSON.
 *  Pakai short record (<=255B) atau medium record (2-byte length) otomatis. */
function ndefTextRecord(text) {
  const payload = Buffer.concat([
    Buffer.from([0x01]), // status byte: UTF-8, IANA language 'en'
    Buffer.from('en', 'ascii'),
    Buffer.from(text, 'utf8'),
  ]);
  const type = Buffer.from('T', 'ascii');
  let header;
  if (payload.length <= 255) {
    header = Buffer.from([0xd1, type.length, payload.length]); // MB=1 ME=1 SR=1 TNF=001
  } else {
    header = Buffer.alloc(5);
    header[0] = 0xc1; // MB=1 ME=1 SR=0 TNF=001
    header[1] = type.length;
    header.writeUInt16LE(payload.length, 2);
  }
  return Buffer.concat([header, type, payload]);
}

async function writeEnrollmentArtifacts(batchName, method) {
  const dir = path.join(OUT, batchName);
  fs.mkdirSync(dir, { recursive: true });
  const payload = enrollmentPayload();
  const json = JSON.stringify(payload, null, 2);
  const qrFile = path.join(dir, 'enroll-qr.txt');
  fs.writeFileSync(qrFile, json);
  let qrPng = null;
  try {
    const QR = (await import('qrcode')).default;
    qrPng = path.join(dir, 'enroll-qr.png');
    await QR.toFile(qrPng, json, { errorCorrectionLevel: 'M', width: 720, margin: 2 });
  } catch {
    qrPng = null; // qrcode belum terpasang -> pakai generator online sekali
  }
  let ndefFile = null;
  if (method === 'nfc' || flag('nfc')) {
    ndefFile = path.join(dir, 'provision.ndef');
    fs.writeFileSync(ndefFile, ndefTextRecord(JSON.stringify(payload)));
  }
  return { dir, qrFile, qrPng, ndefFile, payload };
}

// ---------------------------------------------------------------------------
async function cmdBatch() {
  const count = Number(arg('count', '50'));
  const group = arg('group', 'TOKO');
  const start = Number(arg('start', '1'));
  const method = arg('method', flag('nfc') ? 'nfc' : 'qr');
  const batchName = arg('name', `BATCH-${group}-${new Date().toISOString().slice(0, 10)}`);
  if (!Number.isFinite(count) || count <= 0) throw new Error('--count wajib angka > 0');

  // Artefak dibuat dulu supaya kegagalan tidak meninggalkan device setengah jadi.
  const art = await writeEnrollmentArtifacts(batchName, method);

  const rows = [];
  for (let i = 0; i < count; i++) {
    const n = String(start + i).padStart(3, '0');
    const deviceId = `HP-${n}`;
    const nama = `HP-${n}-${group}`;
    const clash = await devicesRepo.byNameExact(nama);
    if (clash) {
      console.error(`! lewati ${nama} (sudah ada)`);
      continue;
    }
    const { pairCode } = await devicesRepo.create({
      deviceId,
      namaDevice: nama,
      createdBy: `onboard:${batchName}`,
    });
    rows.push({ device_id: deviceId, nama_device: nama, pair_code: pairCode });
  }

  const batchId = await enrollmentRepo.create({
    batchName,
    note: arg('note', null),
    method,
    qrPayload: fs.readFileSync(art.qrFile, 'utf8'),
    qrFile: path.relative(ROOT, art.qrPng || art.qrFile),
    ndefFile: art.ndefFile ? path.relative(ROOT, art.ndefFile) : null,
    amapiToken: config.enrollment.enrollmentToken || null,
    policyName: config.enrollment.policyName || null,
    count: rows.length,
    createdBy: 'onboard.mjs',
  });

  const csv = ['device_id,nama_device,pair_code', ...rows.map((r) => `${r.device_id},${r.nama_device},${r.pair_code}`)]
    .join('\n');
  fs.writeFileSync(path.join(art.dir, 'devices.csv'), csv);

  console.log(`\n✅ Batch "${batchName}" dibuat: ${rows.length} device (id batch #${batchId})`);
  console.log(`   CSV pairing : ${path.relative(ROOT, path.join(art.dir, 'devices.csv'))}`);
  console.log(`   Payload QR  : ${path.relative(ROOT, art.qrFile)}`);
  if (art.qrPng) console.log(`   QR PNG      : ${path.relative(ROOT, art.qrPng)}`);
  if (art.ndefFile) console.log(`   NFC NDEF    : ${path.relative(ROOT, art.ndefFile)}`);
  console.log(`\nLangkah device (${method.toUpperCase()}):`);
  console.log('  1. Nyalakan HP baru, sambungkan Wi-Fi saat setup wizard.');
  if (method === 'nfc') {
    console.log('  2. Tempelkan tag NFC yang sudah ditulis payload di belakang HP.');
  } else {
    console.log('  2. Ketuk 6x "Tambahkan perangkat" di layar welcome.');
    console.log('  3. Scan QR dari file enroll-qr.png (tampil di layar PC/laptop).');
  }
  console.log('  4. Guard ter-install sebagai Device Owner, setup wizard selesai sendiri.');
  console.log('  5. Buka Guard -> masukkan kode pairing dari devices.csv (sekali pakai).');
  if (!config.enrollment.dpcSignatureSha1)
    console.log('\n⚠️  GUARD_DPC_SIGNATURE_SHA1 belum diisi di .env - provisioning akan GAGAL.');
}

async function cmdAdd() {
  const nama = process.argv[3];
  if (!nama) throw new Error('contoh: node scripts/onboard.mjs add HP-050-TOKO-B');
  assertNamaValid(nama);
  const deviceId = nama.split('-').slice(0, 2).join('-') || nama;
  const { token, pairCode } = await devicesRepo.create({ deviceId, namaDevice: nama, createdBy: 'onboard:add' });
  console.log(`✅ ${nama} (${deviceId})`);
  console.log(`   pair code : ${pairCode}`);
  console.log(`   device token (rahasia, hanya tampil sekali): ${token}`);
}

async function cmdList() {
  const rows = await devicesRepo.all();
  console.log(`${'device_id'.padEnd(20)} ${'nama_device'.padEnd(24)} ${'sewa'.padEnd(12)} on  batt`);
  for (const d of rows) {
    console.log(
      `${d.device_id.padEnd(20)} ${d.nama_device.padEnd(24)} ${d.status_sewa.padEnd(12)} ${d.is_online ? 'Y' : '-'}   ${d.battery_level ?? '?'}`,
    );
  }
  console.log(`total ${rows.length}`);
}

async function cmdRotate() {
  const id = process.argv[3];
  if (!id) throw new Error('contoh: node scripts/onboard.mjs rotate HP-001-TOKO-A');
  const { token, pairCode } = await devicesRepo.rotateToken(id);
  console.log(`🔁 token ${id} dirotasi`);
  console.log(`   pair code : ${pairCode}`);
  console.log(`   token     : ${token}`);
}

// ---------------------------------------------------------------------------
const cmd = process.argv[2];
await openDb();
try {
  if (cmd === 'batch') await cmdBatch();
  else if (cmd === 'add') await cmdAdd();
  else if (cmd === 'list') await cmdList();
  else if (cmd === 'rotate') await cmdRotate();
  else
    console.log(
      'Pakai:\n  onboard.mjs batch --count 200 --group TOKO-A [--method qr|nfc] [--start 1]\n  onboard.mjs add <NAMA>\n  onboard.mjs list\n  onboard.mjs rotate <device_id>',
    );
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
} finally {
  process.exit(0);
}
