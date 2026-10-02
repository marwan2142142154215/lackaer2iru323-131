#!/usr/bin/env node
// Manajemen admin dashboard.
//   node scripts/admin.mjs add <username> <password> [superadmin|staff]
//   node scripts/admin.mjs chat <username> <telegram_chat_id>
//   node scripts/admin.mjs passwd <username> <password>
//   node scripts/admin.mjs list
// Password bisa juga diisi lewat env ADMIN_PASSWORD bila argumen dikosongkan.
import { openDb, db } from '../src/db/index.js';
import { adminsRepo } from '../src/db/repos.js';
import { hashPassword } from '../src/crypto/box.js';
import { config } from '../src/config.js';

const [cmd, a, b, c] = process.argv.slice(2);

async function main() {
  await openDb();

  if (cmd === 'add') {
    if (!a) throw new Error('contoh: admin.mjs add andi <password> superadmin');
    const password = b || config.security.adminPassword;
    if (!password || password.length < 8) throw new Error('password minimal 8 karakter (argumen ke-2 atau env ADMIN_PASSWORD)');
    const role = c === 'superadmin' ? 'superadmin' : 'staff';
    const created = await adminsRepo.create({
      username: a,
      passwordHash: hashPassword(password),
      role,
    });
    console.log(`✅ admin dibuat: ${created.username} (${created.role}) id=${created.id}`);
    return;
  }

  if (cmd === 'chat') {
    if (!a || !b) throw new Error('contoh: admin.mjs chat andi 123456789');
    const r = await db().run('UPDATE admin_users SET telegram_chat_id = ?, telegram_username = ? WHERE username = ?', [
      String(b),
      null,
      a,
    ]);
    if (!r.changes) throw new Error(`admin "${a}" tidak ditemukan`);
    const u = await adminsRepo.byUsername(a);
    console.log(`✅ ${a} -> chat_id ${u.telegram_chat_id}`);
    return;
  }

  if (cmd === 'passwd') {
    const password = b || config.security.adminPassword;
    if (!a || !password) throw new Error('contoh: admin.mjs passwd andi <password>');
    const r = await db().run(
      `UPDATE admin_users SET password_hash = ?, updated_at = ?, failed_logins = 0, locked_until = NULL
       WHERE username = ?`,
      [hashPassword(password), new Date().toISOString(), a],
    );
    if (!r.changes) throw new Error(`admin "${a}" tidak ditemukan`);
    console.log(`✅ password ${a} diganti`);
    return;
  }

  if (cmd === 'list') {
    const rows = await adminsRepo.list();
    if (!rows.length) console.log('(belum ada admin)');
    for (const r of rows)
      console.log(
        `#${r.id} ${r.username.padEnd(16)} ${r.role.padEnd(11)} chat=${r.telegram_chat_id || '-'} aktif=${
          r.is_active ? 'Y' : 'N'
        } login=${r.last_login_at || 'pernah?'}`,
      );
    return;
  }

  console.log('Pakai: add | chat | passwd | list');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
  });
