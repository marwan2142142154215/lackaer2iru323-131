#!/usr/bin/env node
// Uji integrasi end-to-end: dashboard API -> antrean -> device (simulator) -> hasil.
// Prasyarat: server jalan (npm start) dan simulator jalan (npm run sim).
//   node scripts/selftest.mjs [--url http://localhost:8787] [--user andi] [--pass "..."]
import crypto from 'node:crypto';
import WebSocket from 'ws';

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = (arg('url', process.env.PUBLIC_BASE_URL || 'http://localhost:8787')).replace(/\/+$/, '');
const USER = arg('user', 'andi');
const PASS = arg('pass', 'Rental2026!oke');

let cookie = '';
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

async function req(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', cookie, ...(opts.headers || {}) },
  });
  const setc = r.headers.get('set-cookie');
  if (setc) cookie = setc.split(';')[0];
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: r.status, json, headers: r.headers };
}

async function waitFor(cmdId, timeoutMs = 25_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { json } = await req(`/api/devices/HP-001`);
    const c = json.commands?.find((x) => x.id === cmdId);
    if (c && (c.status === 'acked' || c.status === 'failed' || c.status === 'expired')) return c;
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

console.log(`\nUJI INTEGRASI FLEET GUARD -> ${BASE}\n`);

// 1. health -----------------------------------------------------------------
{
  const { json } = await req('/healthz');
  ok('healthz', json.ok === true, `sessions=${json.sessions}`);
}

// 1b. dashboard HTML harus benar-benar tersaji --------------------------------
// Regresi: PUBLIC_DIR pernah menunjuk server/src/public sehingga '/' membalas
// 302 ke '/' sendiri (loop). Semua uji lain hanya menyentuh endpoint API, jadi
// bug ini lolos tanpa terdeteksi.
{
  // redirect:'manual' supaya loop terdeteksi sebagai status, bukan exception.
  const { status, headers, json } = await req('/', { redirect: 'manual' });
  const ctype = headers.get('content-type') || '';
  const raw = json?.raw || '';
  const served = status === 200 && /text\/html/.test(ctype) && /<html/i.test(raw);
  ok('dashboard HTML tersaji di /', served,
    `status=${status} type=${ctype || '-'} bytes=${raw.length}`
    + (status === 302 ? ` -> LOKASI ${headers.get('location')}` : ''));
}

// 2. login ------------------------------------------------------------------
{
  const { status, json } = await req('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  ok('login dashboard', status === 200 && json.ok, json.error || '');
  if (status !== 200) {
    console.log('\nGagal login. Jalankan: node scripts/admin.mjs add andi <password> superadmin\n');
    process.exit(1);
  }
}

// 3. daftar device ----------------------------------------------------------
let devices = [];
{
  const { json } = await req('/api/devices');
  devices = json.devices || [];
  ok('daftar device', devices.length > 0, `${devices.length} device, online=${json.stat?.online}`);
  const online = devices.filter((d) => d.online);
  ok('ada device online', online.length > 0, `${online.length} online`);
// Kalau ada device yang gagal, berhenti di sini dengan pesan jelas.
  // Jangan lanjut: waitFor() mengembalikan null setelah timeout, dan akses
  // properties of null di bawahnya hanya menambah derail yang tidak berguna.
  if (devices.length === 0 || online.length === 0) {
    console.log('\nDEVICE UJI BELUM ADA. Jalankan urutan ini:');
    console.log('  1. node scripts/seed-test-devices.mjs');
    console.log('  2. node scripts/simulator.mjs --count 4   (biarkan berjalan)');
    console.log('  3. node scripts/selftest.mjs');
    process.exit(1);
  }
}

// 4. FIFO: 3 command beruntun ke device yang sama --------------------------
{
  const ids = [];
  for (const type of ['ring', 'locate', 'track_start']) {
    const { json } = await req('/api/devices/HP-001/command', {
      method: 'POST',
      body: JSON.stringify({ type, payload: type === 'track_start' ? { intervalSec: 60 } : {} }),
    });
    ids.push(json.id);
  }
  ok('3 command diantre', ids.every(Boolean), `cmd ${ids.join(', ')}`);

  const results = [];
  for (const id of ids) results.push(await waitFor(id));
  const semuaSelesai = results.every((r) => r && r.status === 'acked');
  ok('semua command selesai', semuaSelesai,
    results.map((r) => `${r?.id ?? '?'}:${r?.status ?? 'TIMEOUT'}`).join(' '));

  // r bisa null kalau timeout; pakai ?? '' supaya tidak crash di sini.
  const sentOrder = results.map((r) => r?.sent_at || '');
  ok('terkirim berurutan (FIFO)', sentOrder.every((v, i) => i === 0 || v >= sentOrder[i - 1]), sentOrder.join(' < '));
}

// 5. kamera + media terenkripsi --------------------------------------------
{
  const { json } = await req('/api/devices/HP-001/command', {
    method: 'POST',
    body: JSON.stringify({ type: 'camera_rear', payload: {} }),
  });
  const done = await waitFor(json.id);
  ok('command kamera', done?.status === 'acked', `${done?.status} ${done?.error || ''}`);
  const { json: detail } = await req('/api/devices/HP-001');
  const media = detail.media?.[0];
  ok('media tersimpan', !!media, media ? `id=${media.id} ${media.bytes}B` : '');
  if (media) {
    const r = await fetch(`${BASE}/api/media/${media.id}`, { headers: { cookie } });
    const buf = Buffer.from(await r.arrayBuffer());
    ok('media bisa didekripsi', buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8,
      `status=${r.status} bytes=${buf.length} magic=${buf.subarray(0, 2).toString('hex')}`);
  }
}

// 6. lokasi tersimpan & didekripsi ----------------------------------------
{
  const { json } = await req('/api/location?device_id=HP-001&hours=24');
  const p = json.points?.[0];
  ok('riwayat lokasi', !!p && Number.isFinite(p.lat), p ? `${p.lat},${p.lng} @${p.ts}` : 'kosong');
}

// 7. auth device ditolak kalau token salah ---------------------------------
{
  const wsUrl = BASE.replace(/^http/, 'ws') + '/ws/v1/device';
  const ws = new WebSocket(wsUrl, ['fleetguard.v1']);
  const closed = await new Promise((resolve) => {
    const to = setTimeout(() => resolve('timeout'), 8000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'challenge') {
        const bad = crypto.createHmac('sha256', 'token-palsu').update(`${m.nonce}.HP-001`).digest('hex');
        ws.send(JSON.stringify({ t: 'auth', deviceId: 'HP-001', nonce: m.nonce, tag: bad }));
      }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(to);
      resolve(`${code} ${reason}`);
    });
    ws.on('error', () => {});
  });
  ok('token palsu ditolak', closed.startsWith('4004'), closed);
}

// 8. command ke device yang tidak ada --------------------------------------
{
  const { status, json } = await req('/api/devices/HP-999/command', {
    method: 'POST',
    body: JSON.stringify({ type: 'lock', payload: {} }),
  });
  ok('device tak dikenal ditolak', status === 400 && /tidak terdaftar/i.test(json.error), json.error || '');
}

// 9. cooldown anti-spam -----------------------------------------------------
{
  const a = await req('/api/devices/HP-001/command', {
    method: 'POST',
    body: JSON.stringify({ type: 'camera_front', payload: {} }),
  });
  const b = await req('/api/devices/HP-001/command', {
    method: 'POST',
    body: JSON.stringify({ type: 'camera_front', payload: {} }),
  });
  ok('cooldown kamera', a.status === 200 && b.status === 400, `${a.status}/${b.status} ${b.json?.error || ''}`);
}

console.log(`\nHASIL: ${pass} lulus, ${fail} gagal\n`);
process.exit(fail ? 1 : 0);
