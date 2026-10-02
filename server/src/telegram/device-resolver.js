// Pencocokan nama device -> device_id untuk bot Telegram.
//
// Syarat mutlak: TIDAK PERNAH kirim command kalau nama ambigu.
// Urutan resolusi:
//   1. device_id persis  (HP-001-TOKO-A)
//   2. nama persis / ternormalisasi (case & tanda baca diabaikan)
//   3. prefiks unik        (HP-001  -> hanya satu device)
//   4. substring unik      (toko a  -> hanya satu device)
//   5. fuzzy distance <= threshold, skor terbaik unik -> OK
//   6. selain itu: kembalikan kandidat untuk dipilih user (inline keyboard)
import { normalizeName } from '../db/index.js';

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  return 1 - levenshtein(a, b) / max;
}

function tokenOverlap(q, name) {
  const qt = String(q).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const nt = new Set(String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (!qt.length) return 0;
  return qt.filter((t) => nt.has(t)).length / qt.length;
}

/**
 * @param {Array} devices hasil devicesRepo.all()
 * @param {string} query nama/id dari user
 * @returns {{status:'exact'|'ambiguous'|'notfound', device?:object, candidates?:Array, reason?:string}}
 */
export function resolveDevice(devices, query) {
  const raw = String(query || '').trim();
  if (!raw) return { status: 'notfound', reason: 'nama device kosong', candidates: [] };

  // 1. device_id persis
  const byId = devices.find((d) => d.device_id.toLowerCase() === raw.toLowerCase());
  if (byId) return { status: 'exact', device: byId, via: 'device_id' };

  const q = normalizeName(raw);
  if (!q) return { status: 'notfound', reason: 'nama tidak mengandung karakter valid', candidates: [] };

  // 2. nama ternormalisasi persis
  const exact = devices.filter((d) => d.nama_norm === q);
  if (exact.length === 1) return { status: 'exact', device: exact[0], via: 'nama' };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact, reason: 'nama identik di lebih dari satu device' };

  // 3. prefiks unik
  const prefix = devices.filter((d) => d.nama_norm.startsWith(q) || q.startsWith(d.nama_norm));
  if (prefix.length === 1) return { status: 'exact', device: prefix[0], via: 'prefiks' };

  // 4. substring unik
  const sub = devices.filter((d) => d.nama_norm.includes(q));
  if (sub.length === 1) return { status: 'exact', device: sub[0], via: 'substring' };

  // 5. fuzzy: skor gabungan kemiripan teks + tumpang tindih token
  const scored = devices
    .map((d) => {
      const s = similarity(q, d.nama_norm);
      const t = tokenOverlap(raw, d.nama_device);
      const hasDigits = /\d/.test(raw) && /\d/.test(d.nama_device);
      return { d, score: Math.max(s * 0.75 + t * 0.25, hasDigits && s > 0.6 ? s : 0) };
    })
    .filter((x) => x.score >= 0.55)
    .sort((a, b) => b.score - a.score);

  if (scored.length && scored[0].score >= 0.86) {
    const best = scored[0];
    const runnerUp = scored[1];
    // Margin kecil = ambigu -> tanya user, jangan nebak.
    if (!runnerUp || best.score - runnerUp.score >= 0.06) {
      return { status: 'exact', device: best.d, via: 'fuzzy', score: best.score };
    }
  }

  // 6. ambigu / tidak ketemu -> kandidat (maks 8)
  const pool = (scored.length ? scored : prefix.length ? prefix.map((d) => ({ d, score: 0 })) : sub.map((d) => ({ d, score: 0 })))
    .slice(0, 8)
    .map((x) => x.d);
  return {
    status: pool.length ? 'ambiguous' : 'notfound',
    candidates: pool,
    reason: pool.length ? 'beberapa device cocok - pilih salah satu dulu' : 'tidak ada device yang cocok',
  };
}

export function formatCandidates(candidates) {
  return candidates
    .map((d, i) => `${i + 1}. <code>${d.nama_device}</code> — ${d.device_id}`)
    .join('\n');
}
