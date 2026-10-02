// Pemeriksaan statis ringan untuk sumber Android Guard.
// Tidak menggantikan kompilasi Kotlin, tapi menangkap kesalahan yang
// mahal ditemukan (resource hilang, kelas tidak ada, komponen manifest yatim).
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
let problems = 0;
const bad = (msg) => {
  problems += 1;
  console.log('  ! ' + msg);
};

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const files = walk(root);
const ktFiles = files.filter((f) => f.endsWith('.kt'));

// ---------------------------------------------------------------- [1] res
console.log('[1] referensi resource R.* harus ada di res/');
const resXml = {};
const DIR_KIND = {
  values: ['string', 'color', 'style', 'bool', 'integer', 'dimen', 'array'],
  xml: ['xml'],
  layout: ['layout'],
  drawable: ['drawable'],
  mipmap: ['mipmap'],
  menu: ['menu'],
  anim: ['anim'],
};
for (const f of files.filter((x) => x.endsWith('.xml') && x.includes(path.sep + 'res' + path.sep))) {
  const dir = path.basename(path.dirname(f)).split('-')[0];
  const kinds = DIR_KIND[dir] || [dir];
  const src = fs.readFileSync(f, 'utf8');
  for (const k of kinds) resXml[k] ??= new Set();
  for (const m of src.matchAll(/name="([A-Za-z0-9_.]+)"/g)) {
    for (const k of kinds) resXml[k].add(m[1]);
  }
  // Resource berbasis file (xml/, drawable/, mipmap/, layout/) dinamai dari
  // nama file-nya, bukan dari atribut name="".
  if (kinds.includes('xml') || kinds.includes('drawable') || kinds.includes('mipmap') || kinds.includes('layout')) {
    const base = path.basename(f).replace(/\.xml$/, '');
    for (const k of kinds) resXml[k].add(base);
  }
}
const kindOf = { string: 'string', color: 'color', drawable: 'drawable', xml: 'xml', style: 'style', mipmap: 'mipmap' };
let p1 = 0;
for (const f of ktFiles) {
  const src = fs.readFileSync(f, 'utf8');
  // Abaikan android.R.* (resource bawaan framework).
  for (const m of src.matchAll(/(?:^|[^\w.])R\.(string|color|drawable|xml|style)\.([A-Za-z0-9_]+)/gm)) {
    const [, kind, name] = m;
    if (!resXml[kindOf[kind]]?.has(name)) bad(`${path.basename(f)}: R.${kind}.${name} tidak ada`);
    p1 += 1;
  }
}
console.log(`  ${p1} referensi diperiksa`);

// ------------------------------------------------------------- [2] simbol
console.log('[2] import id.acefleet.guard.* harus punya deklarasi');
const byFile = new Map(); // nama sederhana -> { file, pkg, kinds }
for (const f of ktFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const pkg = (src.match(/^package\s+([\w.]+)/m) || [])[1];
  const names = [];
  for (const m of src.matchAll(
    /^(?:@\w+(?:\([^)]*\))?\s*)*(?:public |internal |private |abstract |sealed |open |data |value |annotation |inner |enum |fun )*(?:class|object|interface|enum class)\s+([A-Za-z0-9_]+)/gm,
  )) {
    names.push(m[1]);
  }
  for (const m of src.matchAll(/^(?:internal |private |public )?(?:inline |operator |suspend |tailrec )*fun\s+(?:<[^>]+>\s*)?(?:[A-Za-z0-9_.]+\.)?([A-Za-z0-9_]+)\s*\(/gm)) {
    names.push(m[1]);
  }
  for (const m of src.matchAll(/^(?:internal |private |public )?(?:const )?val\s+([A-Za-z0-9_]+)/gm)) {
    names.push(m[1]);
  }
  for (const n of names) {
    if (!byFile.has(n)) byFile.set(n, []);
    byFile.get(n).push(`${pkg}.${n}`);
  }
}
let p2 = 0;
for (const f of ktFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/^import\s+(id\.acefleet\.guard\.[\w.]+)\s*$/gm)) {
    const fq = m[1];
    const simple = fq.split('.').pop();
    if (!byFile.has(simple)) {
      bad(`${path.basename(f)}: import ${fq} tidak ditemukan`);
      p2 += 1;
    }
  }
}
console.log(`  ${byFile.size} simbol terdaftar`);

// -------------------------------------------------------- [3] komponen
console.log('[3] android:name di manifest harus ada sumbernya');
const manifest = fs.readFileSync(path.join(root, 'AndroidManifest.xml'), 'utf8');
const manifestSyms = new Set();
let p3 = 0;
for (const m of manifest.matchAll(/android:name="(\.[\w.]+)"/g)) {
  const fq = m[1].slice(1);
  const simple = fq.split('.').pop();
  if (!byFile.has(simple)) {
    bad(`manifest: ${m[1]} (${simple}) tidak ada di sumber Kotlin`);
    p3 += 1;
  }
  manifestSyms.add(simple);
}
for (const m of manifest.matchAll(/@(string|color|drawable|xml|style|mipmap|layout)\/([A-Za-z0-9_.]+)/g)) {
  const [, kind, name] = m;
  if (!resXml[kindOf[kind]]?.has(name)) {
    bad(`manifest: @${kind}/${name} tidak ada di res/`);
    p3 += 1;
  }
}
console.log(`  ${manifestSyms.size} komponen diperiksa`);

// ------------------------------------------------------------- [4] kurung
console.log('[4] keseimbangan kurung kurawal');
let p4 = 0;
for (const f of ktFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) {
    bad(`${path.basename(f)}: kurung kurawal tidak seimbang (${depth > 0 ? '+' : ''}${depth})`);
    p4 += 1;
  }
}
console.log(`  ${ktFiles.length} file Kotlin diperiksa`);

console.log(problems ? `\n${problems} masalah ditemukan` : '\nTidak ada masalah statis.');
process.exit(problems ? 1 : 0);