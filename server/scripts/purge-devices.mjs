#!/usr/bin/env node
// Bersihkan SELURUH data device dari database.
//
// Untuk apa: simulator dan self-test menulis device/lokasi/command/foto ke
// database yang sama dengan produksi. Kalau tidak dibersihkan, dashboard
// menampilkan HP-001 s/d HP-008 seolah-olah unit rental asli - padahal tidak
// ada satu pun HP yang pernah connect. Skrip ini mengembalikan DB ke kondisi
// kosong supaya unit pertama yang muncul benar-benar unit sungguhan.
//
// Aman: backup otomatis dibuat lebih dulu lewat scripts/backup.mjs.
//
// Pakai:
//   node scripts/purge-devices.mjs            -> tampilkan dulu apa yang akan dihapus
//   node scripts/purge-devices.mjs --yes      -> eksekusi
//   node scripts/purge-devices.mjs --yes --keep-admin
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { config } from '../src/config.js';
import { openDb, db } from '../src/db/index.js';
import { logger } from '../src/util/logger.js';

const log = logger('purge');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const CONFIRMED = args.includes('--yes');
const KEEP_ADMIN = args.includes('--keep-admin');
const KEEP_MEDIA_FILES = args.includes('--keep-media-files');

const TABLES = ['devices', 'location_history', 'command_log', 'media', 'device_events'];

function out(line = '') {
  process.stdout.write(line + '\n');
}

async function main() {
  await openDb();

  // ---- laporan dulu -------------------------------------------------------
  const before = {};
  for (const t of TABLES) before[t] = Number(db().get(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0);
  const adminN = Number(db().get('SELECT COUNT(*) AS n FROM admin_users')?.n ?? 0);

  out();
  out('  PURGE DATA DEVICE');
  out('  ' + '-'.repeat(52));
  out(`  database : ${config.db.url}`);
  for (const t of TABLES) {
    if (before[t]) out(`  ${t.padEnd(17)} ${String(before[t]).padStart(5)} baris`);
  }
  out(`  ${'admin_users'.padEnd(17)} ${String(adminN).padStart(5)} baris${KEEP_ADMIN ? '  (DIPERTAHANKAN)' : ''}`);
  out();

  if (!before.devices) {
    out('  Tidak ada device. Database sudah bersih.');
    out();
    await close();
    return;
  }

  if (!CONFIRMED) {
    out('  Mode dry-run. Tidak ada yang dihapus.');
    out('  Jalankan ulang dengan --yes untuk benar-benar menghapus.');
    out();
    await close();
    return;
  }

  // ---- backup dulu, tanpa syarat ------------------------------------------
  out('  [1/3] backup sebelum menghapus...');
  const r = spawnSync(process.execPath, [path.join(HERE, 'backup.mjs')], { stdio: 'ignore' });
  if (r.status !== 0) {
    log.error('backup gagal -> batal menghapus', { status: r.status });
    out('  BACKUP GAGAL. Dibatalkan demi keamanan.');
    process.exitCode = 1;
    await close();
    return;
  }
  out('        backup ok');

  // ---- hapus ---------------------------------------------------------------
  out('  [2/3] menghapus...');
  // Urutan: devices duluan, sisanya sudah hilang otomatis lewat
  // ON DELETE CASCADE (PRAGMA foreign_keys = ON). sisa children dihapus
  // eksplisit supaya aman juga kalau cascade tidak berlaku.
  db().run('DELETE FROM devices');
  for (const t of ['device_events', 'media', 'location_history', 'command_log']) {
    db().run(`DELETE FROM ${t}`);
  }
  if (!KEEP_ADMIN) db().run('DELETE FROM admin_users');
  if (!KEEP_ADMIN) db().run('DELETE FROM sessions');
  log.info('baris dihapus', TABLES.map((t) => ({ table: t, n: before[t] })));

  // ---- file media terenkripsi ---------------------------------------------
  if (!KEEP_MEDIA_FILES) {
    const mediaDir = path.join(config.runtime.dataDir, 'media');
    if (fs.existsSync(mediaDir)) {
      let n = 0;
      for (const f of fs.readdirSync(mediaDir)) {
        if (/^FGENC001\./.test(f) || /\.(enc|bin)$/i.test(f)) {
          try {
            fs.unlinkSync(path.join(mediaDir, f));
            n += 1;
          } catch {
            /* abaikan file yang terkunci */
          }
        }
      }
      out(`        ${n} file media dihapus`);
    }
  }

  // ---- verifikasi ---------------------------------------------------------
  out('  [3/3] verifikasi...');
  const after = {};
  for (const t of TABLES) after[t] = Number(db().get(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0);
  const bad = TABLES.filter((t) => after[t] !== 0);
  out();
  if (bad.length) {
    out(`  GAGAL: masih ada baris di ${bad.join(', ')}`);
    process.exitCode = 1;
  } else {
    out(' BERSIH. Semua tabel device kosong.');
    out('  Langkah berikutnya: jalankan server, lalu pair unit HP pertama.');
    out('  Unit yang muncul setelah itu dijamin device sungguhan, bukan simulator.');
  }
  out();

  await close();
}

async function close() {
  await db().close();
}

main().catch((e) => {
  log.error('gagal', { err: e.message });
  process.exit(1);
});