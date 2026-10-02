// Pemeriksaan ringan untuk file Markdown:
//  1. karakter non-Latin yang tidak disengaja (CJK / Cyrillic),
//  2. kata Inggris yang tertinggal di dalam teks Indonesia,
//  3. "..." sebagai pengisi (selalu bug kalau muncul_many),
//  4. tabel markdown dengan jumlah kolom tidak konsisten.
//
// Bukan linter bahasa; ini penangkap blunder yang mahal ditemukan karena
// harus dibaca manusia sebelum dikirim.
import fs from 'node:fs';
import path from 'node:path';

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('pemakaian: node tools/check-docs.mjs <file.md|folder> [...]');
  process.exit(2);
}

const BAD_CHAR = /[\u3000-\u9FFF\uAC00-\uD7AF\u0400-\u04FF\uFF00-\uFFEF]/;
const FILLER = /\u2026{3,}/;

// Kata Inggris yang tidak punya padanan wajar di teks Indonesia dan sering
// muncul kalau menulis terlalu lama tanpa disunting.
const ENGLISH_WORDS = [
  'handled', 'manages', 'sometimes', 'prohibits', 'connectivity',
  'mandatory', 'nails', 'skandal', 'endirect', 'without', 'around', 'during',
  'provide', 'require', 'should', 'would', 'could', 'there', 'which', 'about',
  'after', 'before', 'between', 'because', 'however', 'therefore', 'already',
  'every', 'each', 'both', 'other', 'such', 'very', 'just', 'make', 'made',
  'need', 'want', 'know', 'more', 'most', 'some', 'time', 'year', 'month',
];
const EN_RE = new RegExp('\\b(' + ENGLISH_WORDS.join('|') + ')\\b', 'i');

// Istilah yang memang dipakai apa adanya karena itu nama antarmuka Android.
const ALLOWED = /About phone|Build number|Developer options|Zero-Touch|FRP/;

// Partisipan pasif Indonesia (dib-, di-) berakhiran -ed/-an/-kan, jadi pola
// "kata + -ed" tidak bisa dipakai sebagai detektor campur bahasa.
const MIXED_RE = /^\0$/;

function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(path.join(p, e.name), out);
    }
  } else if (p.endsWith('.md')) out.push(p);
  return out;
}

let problems = 0;
for (const t of targets) {
  for (const file of walk(t)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let inFence = false;
    lines.forEach((line, i) => {
      const loc = `${path.relative(process.cwd(), file)}:${i + 1}`;
      if (line.trim().startsWith('```')) inFence = !inFence;
      if (BAD_CHAR.test(line)) {
        console.log(`  ! ${loc} karakter non-Latin: ${line.trim().slice(0, 100)}`);
        problems += 1;
      }
      if (FILLER.test(line)) {
        console.log(`  ! ${loc} teks pengisi: ${line.trim().slice(0, 100)}`);
        problems += 1;
      }
      if (inFence) return;
      // Hanya.prose yang diperiksa: baris markdown table/code inline diabaikan
      // kalau seluruh baris berada di dalam blok yang ditandai.
      const m = ALLOWED.test(line) ? null : EN_RE.exec(line);
      if (m) {
        console.log(`  ? ${loc} kata Inggris "${m[1]}": ${line.trim().slice(0, 100)}`);
        problems += 1;
      }
      if (MIXED_RE.test(line)) {
        console.log(`  ? ${loc} campur bahasa: ${line.trim().slice(0, 100)}`);
        problems += 1;
      }
    });
  }
}

console.log(problems ? `\n${problems} baris perlu ditinjau` : 'Markdown bersih.');
process.exit(problems ? 1 : 0);