#!/usr/bin/env node
// Seed perangkat UJI untuk scripts/selftest.mjs.
//
// Kenapa file ini ada: selftest butuh device yang SUDAH terdaftar di DB
// (token + auth_secret). Simulator hanya MENGHUBUNGKAN device yang sudah ada,
// dia tidak bisa membuat device baru. Setelah DB produksi di-purge, selftest
// akan gagal dengan "0 device" - dan itu bukan bug server.
//
// Pakai:
//   node scripts/seed-test-devices.mjs          -> buat HP-001..HP-004 bila belum ada
//   node scripts/seed-test-devices.mjs --clean  -> hapus hanya perangkat UJI
//
// PENTING: perangkat yang dibuat file ini adalah data SIMULASI. Jangan biarkan
// mereka masuk produksi. Setelah selesai menguji, jalankan purge-devices.mjs.

import { devicesRepo } from '../src/db/repos.js';
import { openDb } from '../src/db/index.js';
import { config } from '../src/config.js';

// PENTING: nama TIDAK BOLEH mengandung spasi. Bot mem-parse "/cmd <nama>
// <argumen>" sebagai token terpisah, jadi "HP-001 Redmi 9" akan terpotong dan
// setiap perintah menjadi ambigu. Pakai tanda hubung.
const TEST_IDS = ['HP-001', 'HP-002', 'HP-003', 'HP-004'];
const TEST_NAME_PREFIX = 'UJI-';

async function clean() {
  const all = await devicesRepo.all();
  let n = 0;
  for (const d of all) {
    if (TEST_IDS.includes(d.device_id) || String(d.nama_device).startsWith(TEST_NAME_PREFIX)) {
      if (await devicesRepo.remove(d.device_id)) n += 1;
    }
  }
  console.log(n ? `perangkat uji dihapus: ${n}` : 'tidak ada perangkat uji untuk dihapus');
}

async function seed() {
  console.log(`DB    : ${config.db.driver} ${config.db.file || config.db.url || ''}`);
  console.log(`ID uji: ${TEST_IDS.join(', ')}\n`);
  for (const id of TEST_IDS) {
    const existing = await devicesRepo.byId(id);
    const expected = `${TEST_NAME_PREFIX}${id}`;
    if (existing) {
      // Nama lama bisa ber-spasi (seed versi lama). Normalkan sekarang karena
      // nama ber-spasi membuat perintah bot selalu ambigu.
      if (existing.nama_device !== expected) {
        await devicesRepo.rename(id, expected);
        console.log(`~ ${id} nama diperbaiki: "${existing.nama_device}" -> "${expected}"`);
      } else {
        console.log(`- ${id} sudah ada, dilewati`);
      }
      continue;
    }
    const { pairCode } = await devicesRepo.create({
      deviceId: id,
      namaDevice: expected,
      createdBy: 'seed-test',
    });
    console.log(`+ ${id} dibuat (pair code ${pairCode}, tidak dipakai oleh simulator)`);
  }
  const all = await devicesRepo.all();
  console.log(`\nseluruh device di DB sekarang: ${all.length}`);
  console.log('Jalankan: node scripts/simulator.mjs --count 4');
  console.log('Lalu:     node scripts/selftest.mjs');
}

await openDb();

if (process.argv.includes('--clean')) {
  await clean();
} else {
  await seed();
}
process.exit(0);