#!/usr/bin/env node
// Backup data Fleet Guard: database + keyring + media terenkripsi.
//
// Penting: keyring.json WAJIB ikut dibackup. Tanpa file itu, semua token
// device, password admin, dan data yang terenkripsi di database tidak bisa
// dibaca lagi - dan perangkat yang sudah ter-enroll tidak akan pernah
// connect kembali.
//
// Pakai:  node scripts/backup.mjs            -> backup ke backups/<timestamp>/
//        node scripts/backup.mjs --prune 30 -> hapus backup lama > 30 hari
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { config } from '../src/config.js';
import { openDb, db } from '../src/db/index.js';
import { logger } from '../src/util/logger.js';

const log = logger('backup');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BACKUP_ROOT = path.join(ROOT, 'backups');

const args = process.argv.slice(2);
const pruneDays = args.includes('--prune') ? Number(args[args.indexOf('--prune') + 1]) || 30 : 0;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function main() {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const outDir = path.join(BACKUP_ROOT, stamp());
  fs.mkdirSync(outDir, { recursive: true });
  log.info('mulai backup', { outDir });

  // 1. Database -------------------------------------------------
  const url = config.db.url;
  if (/^postgres(ql)?:\/\//i.test(url)) {
    log.info('postgres terdeteksi -> pg_dump');
    const pw = new URL(url).password;
    const dump = spawnSync(
      'pg_dump',
      ['--no-owner', '--no-acl', '--format=custom', '--file', path.join(outDir, 'db.dump'), url],
      { env: { ...process.env, PGPASSWORD: pw }, stdio: 'inherit' },
    );
    if (dump.status !== 0) throw new Error('pg_dump gagal (status ' + dump.status + ')');
  } else {
    const d = await openDb();
    // SQLite: pakai VACUUM INTO supaya bisa jalan walau ada koneksi lain aktif.
    const target = path.join(outDir, 'fleetguard.db').replace(/'/g, "''");
    d.exec(`VACUUM INTO '${target}'`);
    log.info('sqlite disalin', { target });
  }

  // 2. Keyring (wajib) -------------------------------------------
  const keyring = config.security.keyringPath;
  if (fs.existsSync(keyring)) {
    fs.copyFileSync(keyring, path.join(outDir, 'keyring.json'));
    log.info('keyring ikut dibackup', { keyring });
  } else {
    log.warn('keyring.json tidak ditemukan - data terenkripsi tidak bisa dipulihkan!');
  }

  // 3. Media (sudah terenkripsi di disk) -------------------------
  const mediaDir = config.runtime.mediaDir;
  if (fs.existsSync(mediaDir)) {
    fs.cpSync(mediaDir, path.join(outDir, 'media'), { recursive: true });
    log.info('media ikut dibackup', { mediaDir });
  }

  // 4. Manifest kecil supaya jelas isi & versinya -----------------
  fs.writeFileSync(
    path.join(outDir, 'MANIFEST.json'),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        serverName: config.serverName,
        database: /^postgres/i.test(url) ? 'postgres (db.dump)' : 'sqlite (fleetguard.db)',
        keyringIncluded: fs.existsSync(path.join(outDir, 'keyring.json')),
        mediaIncluded: fs.existsSync(path.join(outDir, 'media')),
        files: fs.readdirSync(outDir),
      },
      null,
      2,
    ),
  );

  log.info('backup selesai', { outDir, files: fs.readdirSync(outDir) });

  // 5. Retensi ---------------------------------------------------
  if (pruneDays > 0) {
    const cutoff = Date.now() - pruneDays * 86400_000;
    let n = 0;
    for (const d of fs.readdirSync(BACKUP_ROOT)) {
      const full = path.join(BACKUP_ROOT, d);
      const st = fs.statSync(full);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
        n += 1;
      }
    }
    log.info('retensi diterapkan', { pruneDays, dihapus: n });
  }

  console.log('\nBackup siap: ' + outDir);
  console.log('Simpan juga salinan OFFSITE (cloud/USB). Backup di PC yang sama');
  console.log('tidak melindungi dari pencurian atau ransomware.\n');
}

main()
  .then(async () => {
    await db().close().catch(() => {});
    process.exit(0);
  })
  .catch((e) => {
    console.error('backup gagal:', e.message);
    process.exit(1);
  });