// Format tampilan (HTML) + tombol inline.
import { esc } from './api.js';

export const ICON = {
  online: '🟢',
  offline: '⚫',
  status: { tersedia: '🟦', disewa: '🟧', hilang: '🟥', maintenance: '🛠' },
  lock: { locked: '🔒', unlocked: '🔓', kiosk: '📌', factory: '⚠️' },
  battery: (v) => (v === null || v === undefined ? '❔' : v >= 80 ? '🔋' : v >= 40 ? '🔋' : v >= 15 ? '🪫' : '🪫'),
};

export function fmtTime(iso, withDate = true) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p = (n) => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (!withDate) return time;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay ? `hari ini ${time}` : `${p(d.getDate())}/${p(d.getMonth() + 1)} ${time}`;
}

export function ago(iso) {
  if (!iso) return 'tidak pernah';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} detik lalu`;
  if (s < 3600) return `${Math.round(s / 60)} menit lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return `${Math.round(s / 86400)} hari lalu`;
}

export function batteryText(v) {
  if (v === null || v === undefined) return '?';
  return `${ICON.battery(v)} ${v}%`;
}

/** Ringkasan satu device. */
export function deviceLine(d) {
  return [
    `${d.is_online ? ICON.online : ICON.offline} <b>${esc(d.nama_device)}</b>`,
    `${ICON.status[d.status_sewa] || '⬜'} ${d.status_sewa}` +
      (d.nama_penyewa ? ` · ${esc(d.nama_penyewa)}` : ''),
    `${ICON.lock[d.policy_state] || '·'} ${d.policy_state}` +
      `${d.radius_meter ? ` · geofence ${d.radius_meter}m${d.geofence_armed ? '' : ' (off)'}` : ''}`,
    `${batteryText(d.battery_level)} · seen ${ago(d.last_seen_at)}`,
  ].join('\n');
}

export function kbDevice(d, cmd) {
  const items = [
    [`🔒 Lock`, `lock:${cmd}`],
    [`🔓 Unlock`, `unlock:${cmd}`],
    [`📍 Lokasi`, `locate:${cmd}`],
    [`🔔 Bunyi`, `ring:${cmd}`],
    [`📷 Depan`, `camf:${cmd}`],
    [`📷 Belakang`, `camb:${cmd}`],
  ];
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    rows.push([
      { text: items[i][0], callback_data: items[i][1] },
      { text: items[i + 1][0], callback_data: items[i + 1][1] },
    ]);
  }
  rows.push([{ text: '🔄 Refresh', callback_data: `refresh:${cmd}` }]);
  return { inline_keyboard: rows };
}

export function kbList(devices, prefix = 'dev') {
  const kb = [];
  for (const d of devices.slice(0, 40)) {
    kb.push([
      { text: `${d.is_online ? '🟢' : '⚫'} ${d.nama_device}`.slice(0, 60), callback_data: `${prefix}:${d.device_id}` },
    ]);
  }
  return { inline_keyboard: kb };
}

export function kbYesNo(prefix, yesData, noData = prefix + ':no') {
  return {
    inline_keyboard: [
      [
        { text: '✅ Ya, lanjutkan', callback_data: yesData },
        { text: '❌ Batal', callback_data: noData },
      ],
    ],
  };
}

export function esc2(s) {
  return esc(s);
}
