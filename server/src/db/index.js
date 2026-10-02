// Lapisan database: SQLite (node:sqlite, bawaan Node 22.5+) atau PostgreSQL.
// Placeholder selalu ditulis '?' di kode lalu diterjemahkan ke $1..$n untuk PG,
// sehingga query tidak perlu diubah saat pindah ke VPS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../util/logger.js';

const log = logger('db');
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const nowIso = () => new Date().toISOString();
export const isoPlus = (ms) => new Date(Date.now() + ms).toISOString();

/** Normalisasi nama device: "hp 001 toko a" -> "hp001tokoa" */
export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

// --------------------------------------------------------------------------
class SqliteDriver {
  constructor(url) {
    const file = url.replace(/^sqlite:(?:\/\/)?/i, '');
    this.file = path.isAbsolute(file) ? file : path.resolve(config.runtime.dataDir, '..', file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const { DatabaseSync } = require_sqlite();
    this.kind = 'sqlite';
    this.db = new DatabaseSync(this.file);
    this.db.exec(fs.readFileSync(path.join(HERE, 'schema.sqlite.sql'), 'utf8'));
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.cache = new Map();
    log.info('sqlite siap', { file: this.file });
  }
  prep(sql) {
    let st = this.cache.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.cache.set(sql, st);
    }
    return {
      all: (p = []) => st.all(...normArgs(p)).map(mapRow),
      get: (p = []) => {
        const r = st.get(...normArgs(p));
        return r === undefined ? undefined : mapRow(r);
      },
      run: (p = []) => {
        const r = st.run(...normArgs(p));
        return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
      },
    };
  }
  exec(sql) {
    this.db.exec(sql);
  }
  async close() {
    this.db.close();
  }
  toSqliteValue(v) {
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v === undefined ? null : v;
  }
}
function normArgs(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}
function mapRow(r) {
  const o = {};
  for (const k of Object.keys(r)) o[k] = r[k];
  return o;
}
function require_sqlite() {
  return nodeSqlite;
}
let nodeSqlite;
try {
  nodeSqlite = await import('node:sqlite');
} catch {
  throw new Error(
    'node:sqlite tidak tersedia. Butuh Node >= 22.5 (disarankan 24 LTS). ' +
      'Atau set DATABASE_URL ke PostgreSQL.',
  );
}

// --------------------------------------------------------------------------
class PostgresDriver {
  constructor(url) {
    this.kind = 'postgres';
    this.url = url;
    this.cache = new Map();
    this.pg = null;
    this.pool = null;
  }
  async init() {
    try {
      this.pg = (await import('pg')).default;
    } catch {
      throw new Error('Package "pg" belum terpasang. Jalankan: npm i pg');
    }
    this.pool = new this.pg.Pool({ connectionString: this.url, max: 10 });
    await this.pool.query(fs.readFileSync(path.join(HERE, 'schema.pg.sql'), 'utf8'));
    log.info('postgres siap', { host: new URL(this.url).host });
  }
  prep(sql) {
    const pgSql = toPgPlaceholders(sql);
    return {
      all: async (p = []) => {
        const r = await this.pool.query(pgSql, normArgs(p));
        return r.rows.map(normalizePgRow);
      },
      get: async (p = []) => {
        const r = await this.pool.query(pgSql, normArgs(p));
        return r.rows[0] ? normalizePgRow(r.rows[0]) : undefined;
      },
      run: async (p = []) => {
        const r = await this.pool.query(pgSql, normArgs(p));
        return { changes: r.rowCount, lastId: r.rows[0]?.id ?? null };
      },
    };
  }
  async exec(sql) {
    await this.pool.query(sql);
  }
  async close() {
    await this.pool.end();
  }
}
function toPgPlaceholders(sql) {
  let i = 0;
  let out = '';
  let inStr = false;
  for (const ch of sql) {
    if (ch === "'") inStr = !inStr;
    if (ch === '?' && !inStr) out += `$${++i}`;
    else out += ch;
  }
  return out;
}
function normalizePgRow(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    if (v instanceof Date) o[k] = v.toISOString();
    else if (typeof v === 'boolean') o[k] = v ? 1 : 0; // samakan dengan sqlite
    else o[k] = v;
  }
  return o;
}

// --------------------------------------------------------------------------
/**
 * Facade seragam. Semua method async (SQLite di-bungkus sync jadi tetap await-able
 * oleh pemanggil) sehingga tidak perlu ubah kode saat pindah ke PostgreSQL.
 */
export class Db {
  constructor(driver) {
    this.d = driver;
  }
  all(sql, p) {
    return this.d.prep(sql).all(p);
  }
  get(sql, p) {
    return this.d.prep(sql).get(p);
  }
  run(sql, p) {
    return this.d.prep(sql).run(p);
  }
  exec(sql) {
    return this.d.exec(sql);
  }
  /** Tutup koneksi (dipakai graceful shutdown dan script one-shot). */
  async close() {
    return this.d.close();
  }
  /** Transaksi; callback boleh sync (SQLite) atau async (PG). */
  async tx(fn) {
    if (this.d.kind === 'sqlite') {
      this.d.exec('BEGIN IMMEDIATE');
      try {
        const r = await fn(this);
        this.d.exec('COMMIT');
        return r;
      } catch (e) {
        try {
          this.d.exec('ROLLBACK');
        } catch {}
        throw e;
      }
    }
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = new Proxy(this, {
        get: (t, k) => {
          if (k === 'd') return t.d;
          if (k === 'tx') return scoped.tx;
          return (...a) => {
            const [sql, params] = a;
            const st = client.query.bind(client);
            return Promise.resolve(st(toPgPlaceholders(sql), normArgs(params || []))).then((r) =>
              k === 'run' ? { changes: r.rowCount, lastId: r.rows[0]?.id ?? null } : r.rows.map(normalizePgRow),
            );
          };
        },
      });
      const out = await fn(scoped);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

let instance = null;
export async function openDb() {
  if (instance) return instance;
  const url = config.db.url;
  if (/^postgres(ql)?:\/\//i.test(url)) {
    const drv = new PostgresDriver(url);
    await drv.init();
    instance = new Db(drv);
  } else {
    instance = new Db(new SqliteDriver(url));
  }
  return instance;
}
export function db() {
  if (!instance) throw new Error('Database belum dibuka: panggil openDb() lebih dulu');
  return instance;
}
