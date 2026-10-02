#!/usr/bin/env node
// Simulator device Guard: buat menguji seluruh pipeline tanpa HP sungguhan.
//   node scripts/simulator.mjs --count 5
//   node scripts/simulator.mjs HP-001 HP-002
//   node scripts/simulator.mjs --count 3 --url wss://host/ws/v1/device
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { openDb } from '../src/db/index.js';
import { devicesRepo } from '../src/db/repos.js';
import { open as openSealed } from '../src/crypto/box.js';
import { config } from '../src/config.js';

// JPEG 1x1 warna abu-abu (dipakai sebagai "foto" dummy).
const FAKE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/AP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

function deviceTag(token, nonce, deviceId) {
  return crypto.createHmac('sha256', Buffer.from(token, 'utf8')).update(`${nonce}.${deviceId}`).digest('hex');
}

async function startDevice(row, url, index) {
  const token = openSealed(row.auth_secret_enc);
  if (!token) {
    console.error(`token ${row.device_id} tidak bisa dibaca (keyring berubah?)`);
    return;
  }
  const wsUrl = url || `${config.publicBaseUrl.replace(/^http/, 'ws')}/ws/v1/device`;
  const ws = new WebSocket(wsUrl, ['fleetguard.v1']);

  const pos = {
    lat: -6.2 + index * 0.004,
    lng: 106.816 + index * 0.004,
  };

  ws.on('open', () => console.log(`[${row.device_id}] connect ${wsUrl}`));
  ws.on('close', (c) => console.log(`[${row.device_id}] close ${c}`));
  ws.on('error', (e) => console.error(`[${row.device_id}] error ${e.message}`));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

    switch (msg.t) {
      case 'challenge': {
        send({
          t: 'auth',
          deviceId: row.device_id,
          nonce: msg.nonce,
          tag: deviceTag(token, msg.nonce, row.device_id),
        });
        send({
          t: 'hello',
          status: {
            battery: 40 + Math.floor(Math.random() * 55),
            charging: Math.random() > 0.7,
            network: 'wifi',
            signal: -55 - Math.floor(Math.random() * 25),
            storageFreeMb: 4000 + Math.floor(Math.random() * 8000),
            ramFreeMb: 500 + Math.floor(Math.random() * 900),
            policyState: 'unlocked',
            locked: false,
            appVersion: '1.0.0',
            androidVersion: '13',
            apiLevel: 33,
            model: 'SIMULATOR',
            manufacturer: 'fleet-guard',
            serial: `SIM${index}`,
            androidId: `sim-android-id-${index}`,
            imei: `3500000000${String(index).padStart(5, '0')}`,
            bootAt: new Date().toISOString(),
            location: { ...pos, accuracy: 8 + Math.random() * 10, source: 'fused', ts: new Date().toISOString() },
          },
        });
        break;
      }
      case 'ping':
        send({ t: 'pong', ts: msg.ts });
        break;
      case 'cmd':
        await handleCommand(row, msg, send, pos);
        break;
      case 'sync':
        //(device.config = msg.config)
        break;
      default:
        break;
    }
  });

  // heartbeat + drift lokasi
  setInterval(() => {
    if (ws.readyState !== 1) return;
    ws.send(
      JSON.stringify({
        t: 'hb',
        status: {
          battery: 40 + Math.floor(Math.random() * 55),
          policyState: 'unlocked',
          locked: false,
          appVersion: '1.0.0',
          androidVersion: '13',
          apiLevel: 33,
        },
      }),
    );
  }, 30_000);

  if (!flag('no-drift')) {
    setInterval(() => {
      if (ws.readyState !== 1) return;
      pos.lat += (Math.random() - 0.5) * 0.0004;
      pos.lng += (Math.random() - 0.5) * 0.0004;
      ws.send(
        JSON.stringify({
          t: 'loc',
          location: { ...pos, accuracy: 6 + Math.random() * 8, source: 'fused', ts: new Date().toISOString() },
        }),
      );
    }, 45_000);
  }
}

async function handleCommand(row, msg, send, pos) {
  const reply = (ok, data = null, error = null) =>
    send({ t: 'result', cmdId: msg.cmdId, ok, data, error });
  const P = msg.payload || {};
  console.log(`[${row.device_id}] <-- ${msg.type} ${JSON.stringify(P)}`);
  switch (msg.type) {
    case 'lock':
      return reply(true, { locked: true });
    case 'unlock':
      return reply(true, { pin: '4271930', unlocked: true });
    case 'pin':
      return reply(true, { pin: '4271930' });
    case 'locate':
      return reply(true, {
        location: { ...pos, accuracy: 4, source: 'gps', ts: new Date().toISOString() },
        battery: 77,
      });
    case 'camera_front':
    case 'camera_rear':
      return send({
        t: 'media',
        cmdId: msg.cmdId,
        kind: msg.type.endsWith('front') ? 'front' : 'rear',
        mime: 'image/jpeg',
        b64: FAKE_JPEG.toString('base64'),
        lat: pos.lat,
        lng: pos.lng,
        ts: new Date().toISOString(),
      });
    case 'track_start':
      return reply(true, { intervalSec: P.intervalSec, untilSec: P.untilSec });
    case 'ring':
      return reply(true, { played: true });
    default:
      return reply(true, { applied: msg.type });
  }
}

async function main() {
  await openDb();
  // argumen posisional = device_id; flag --xxx tidak ikut (beserta nilainya)
  const argv = process.argv.slice(2);
  const explicit = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (!['--no-drift'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
      continue;
    }
    explicit.push(argv[i]);
  }
  const count = Number(arg('count', '3'));
  const url = arg('url', null);

  let rows;
  if (explicit.length) {
    rows = [];
    for (const id of explicit) {
      const r = await devicesRepo.byId(id);
      if (r) rows.push(r);
      else console.error(`device ${id} tidak terdaftar`);
    }
  } else {
    const list = (await devicesRepo.all()).slice(0, count);
    rows = [];
    for (const l of list) rows.push(await devicesRepo.byId(l.device_id));
  }
  if (!rows.length) {
    console.error('Tidak ada device. Jalankan dulu: npm run onboard -- batch --count 5 --group UJI');
    process.exit(1);
  }
  console.log(`Menjalankan ${rows.length} simulator: ${rows.map((r) => r.device_id).join(', ')}`);
  rows.forEach((r, i) => startDevice(r, url, i));
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
