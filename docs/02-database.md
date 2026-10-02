# 02 — Database

Empat tabel inti yang diminta, ditambah tabel pendukung yang benar-benar dipakai
(`sessions`, `audit_log`, `media`, `enrollment_batches`, `device_events`).

Skema SQLite ada di [`server/src/db/schema.sqlite.sql`](../server/src/db/schema.sqlite.sql),
versi PostgreSQL di [`schema.pg.sql`](../server/src/db/schema.pg.sql). Keduanya
dipakai otomatis oleh driver yang dipilih lewat `DATABASE_URL`.

---

## Ringkasan

| Tabel | Isi | Retensi |
|---|---|---|
| `devices` | identitas, status sewa, policy, lokasi terakhir, token (terenkripsi) | permanen |
| `location_history` | jejak lokasi berkala + hasil geofence | `LOCATION_RETENTION_DAYS` (default 180) |
| `command_log` | semua perintah: siapa, ke device mana, hasilnya apa | permanen |
| `admin_users` | akun dashboard + peran + lockout | permanen |
| `sessions` | token dashboard (hashed) | dicabut otomatis setelah `SESSION_TTL_MS` |
| `audit_log` | jejak siapa melakukan apa, dari IP mana | permanen |
| `media` | metadata foto (file-nya di `data/media`, terenkripsi) | manual |
| `enrollment_batches` | rekaman batch onboarding (QR/NFC/ZTE) | permanen |
| `device_events` | tamper, boot, drift policy, baterai kritis | 90 hari (janitor) |

---

## 1. `devices`

```sql
device_id            TEXT PRIMARY KEY        -- HP-001-TOKO-A, dibuat saat onboarding
nama_device          TEXT NOT NULL UNIQUE    -- "HP-001 TOKO A"  ← yang diketik admin
nama_norm            TEXT NOT NULL           -- "hp001tokoa"       ← untuk fuzzy match
status_sewa          TEXT NOT NULL           -- tersedia|disewa|hilang|maintenance
nama_penyewa         TEXT

policy_state         TEXT NOT NULL           -- unlocked|locked|kiosk|factory
is_locked            INTEGER NOT NULL
geofence_armed       INTEGER NOT NULL
radius_meter         INTEGER NOT NULL        -- default 150

last_location_lat    TEXT                    -- terenkripsi
last_location_lng    TEXT                    -- terenkripsi
last_location_acc    REAL
last_location_time   TEXT
last_location_source TEXT

battery_level  battery_temp  charging  network_type  signal_dbm
storage_free_mb  ram_free_mb

is_online  last_seen_at  last_boot_at
app_version  android_version  api_level  model  manufacturer
serial_number  android_id  imei

auth_secret_hash   TEXT NOT NULL UNIQUE    -- HMAC-SHA256(pepper, token) untuk lookup
auth_secret_enc    TEXT NOT NULL           -- token device, AES-256-GCM
pair_code_hash     TEXT UNIQUE             -- kode pairing 8 char, sekali pakai
token_issued_at    revoked_at

batch_id  enrolled_at  created_at  updated_at
```

### Kenapa ada dua kolom rahasia?

Device harus bisa **membuktikan** kepemilikan token tanpa pernah mengirim token
itu sendiri. Maka server butuh dua bentuk:

- `auth_secret_hash` — untuk mencari device berdasarkan token (challenge global
  bisa dicocokkan tanpa membandingkan semua baris).
- `auth_secret_enc` — untuk menghitung HMAC challenge saat device menyambung.

`auth_secret_enc` memakai AES-256-GCM dengan `DATA_KEY` dari `data/keyring.json`.
Kalau file itu hilang, semua device harus di-pair ulang.

> Kolom `imei` sengaja **tidak diisi** oleh Guard. Android tidak memberi API IMEI
> untuk aplikasi biasa maupun Device Owner. Don't isi manual dari sumber tak
> resmi; pakai blocklist operator/GSMA Device Check untuk kebutuhan anti-curian.

### Normalisasi nama

`nama_device` unik tapi admin akan mengetik dengan Various ejaan:
`HP-001 TOKO A`, `hp-001 toko a`, `hp001tokoa`. Karena itu ada `nama_norm`:

```
lowercase → NFKD → buang diakritik → buang semua non [a-z0-9]
"HP-001 TOKO A"  →  "hp001tokoa"
```

Bot memakai `nama_norm` sebagai lapisan pertama fuzzy match (lihat
`src/telegram/device-resolver.js`).

---

## 2. `location_history`

```sql
id            INTEGER PRIMARY KEY AUTOINCREMENT
device_id     TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE
lat           TEXT NOT NULL        -- terenkripsi
lng           TEXT NOT NULL        -- terenkripsi
accuracy      REAL
speed         REAL
altitude      REAL
battery       INTEGER
source        TEXT                 -- gps | network | fused | mock
geofence_dist REAL                 -- meter dari titik acuan
geofence_breach INTEGER NOT NULL   -- 1 = keluar radius saat baris ini masuk
ts            TEXT NOT NULL
```

Index: `(device_id, ts DESC)` untuk `/riwayat_lokasi`, `(ts)` untuk janitor.

**Enkripsi lat/lng** membuat laporan hanya bisa lewat `repos.js`
(`locationsRepo.listByDevice`) yang mendekripsi di memori. Konsekuensinya: laporan
SQL manual dengan `LIKE 'lat…'` tidak akan menemukan apa pun. Itu disengaja.

---

## 3. `command_log`

```sql
id           INTEGER PRIMARY KEY AUTOINCREMENT
device_id    TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE
command_type TEXT NOT NULL        -- harus ada di CATALOG (src/commands/catalog.js)
payload_enc  TEXT
issued_by    TEXT NOT NULL        -- bot:<username> | staff:<user> | system:geofence
status       TEXT NOT NULL        -- pending|sent|acked|failed|expired|cancelled
attempt      INTEGER NOT NULL     -- jumlah percobaan kirim
max_attempts INTEGER NOT NULL     -- default 2
result_enc   TEXT
error        TEXT
created_at   sent_at   completed_at   expires_at   queue_pos
```

`command_log` adalah **bukti**, bukan hanya log: dari sini bisa dibuktikan
bahwa `/lock` pada 14:03 untuk HP-03 benar-benar sampai ke HP-03.

Status belang:

| Status | Arti |
|---|---|
| `pending` | Masih antre, device offline atau command sebelumnya belum selesai |
| `sent` | Sudah dikirim ke device, menunggu `result` |
| `acked` | Device membalas `ok:true` |
| `failed` | Device membalas `ok:false` atau tidak ada koneksi saat retry habis |
| `expired` | Lewat TTL (device offline terlalu lama) |
| `cancelled` | Dibatalkan admin / device dihapus |

`issued_by` diisi bot dengan username Telegram, bukan chat_id, supaya audit
terbaca manusia.

---

## 4. `admin_users`

```sql
username           TEXT NOT NULL UNIQUE
password_hash      TEXT NOT NULL     -- scrypt(N=16384,r=8,p=1) + salt per-user
role               TEXT NOT NULL     -- superadmin | staff
telegram_chat_id   TEXT UNIQUE
telegram_username  TEXT
is_active          INTEGER
failed_logins      INTEGER
locked_until       TEXT
last_login_at  last_login_ip  created_at  updated_at
```

Peran:

| Kemampuan | staff | superadmin |
|---|:--:|:--:|
| `/status /lokasi /riwayat_lokasi /kamera_*` | ya | ya |
| `/lock /unlock /tandai_* /set_radius /sound /rename` | ya | ya |
| Lihat dashboard | ya | ya |
| Tambah/hapus admin, rotasi token pairing | tidak | ya |

`failed_logins` + `locked_until` memberi lockout sementara setelah beberapa
percobaan gagal (lihat `http.js`).

---

## Tabel pendukung

### `sessions`
Token dashboard disimpan sebagai SHA-256 (`token_hash` sebagai primary key).
Kalau database dicuri, token sesi tidak langsung bisa dipakai.

### `audit_log`
```sql
actor, actor_kind (telegram|dashboard|system|device), action, target, detail_enc, ip, ok
```
Semua aksi bot, semua percobaan login, dan **percobaan pairing gagal** masuk ke
sini. `actor_kind='device'` dipakai untuk pairing supaya bisa dibedakan dari
aktor manusia.

### `media`
Metadata foto; bytes-nya ada di `data/media/<nama>.enc` dengan format
`FGENC001|<magic>|<iv>|<ciphertext>|<tag>` (AES-256-GCM). Disajikan hanya lewat
`GET /api/media/:id` yang butuh session admin — tidak ada file statis yang
terbuka langsung.

### `enrollment_batches`
Mencatat batch onboarding: metode (`qr|nfc|zte|kme`), payload QR, path file
NDEF, policy name, token AMAPI. Gunanya untuk audit "unit mana yang belum pernah
dikenai lewat Zero-Touch".

### `device_events`
Tamper, boot, drift policy, baterai kritis — dengan `severity` info/warn/critical
supaya bot bisa membedakan "cukup dicatat" dari "kirim alarm sekarang".

---

## Enkripsi di rest

Semua yang sensitif melewati `src/crypto/box.js`:

| Data | Algoritma | Kapan dienkripsi |
|---|---|---|
| Token device (`auth_secret_enc`) | AES-256-GCM | saat pairing |
| Lokasi (`lat`, `lng`) | AES-256-GCM | sebelum masuk `location_history` |
| Payload & hasil command | AES-256-GCM | sebelum masuk `command_log` |
| File foto | AES-256-GCM | sebelum ditulis ke disk |
| Detail audit | AES-256-GCM | sebelum masuk `audit_log` |
| Password admin | scrypt | saat `admin.mjs add` |
| Sesi dashboard | SHA-256 | saat login |

Format ciphertext yang dipakai seragam: `v1:<iv_b64url>:<ct_b64url>:<tag_b64url>`.

`DATA_KEY` dan `PEPPER` dibuat otomatis di `data/keyring.json` saat server
pertama kali jalan. **File itu wajib ikut di-backup** — lihat
`node scripts/backup.mjs`.

---

## Janitor (retensi otomatis)

Dijalankan dari `src/index.js` (interval harian):

1. Hapus `location_history` lebih tua dari `LOCATION_RETENTION_DAYS`.
2. Hapus `device_events` lebih tua dari 90 hari.
3. Hapus `sessions` yang sudah `expires_at`.
4. Cancel `command_log` berstatus `pending` yang sudah lewat TTL tanpa pernah terkirim.

## Migrasi ke PostgreSQL

```bash
# .env
DATABASE_URL=postgres://fleetguard:PASSWORD@localhost:5432/fleetguard
```

Lalu:

```bash
npm i pg
node src/index.js
```

Skema `schema.pg.sql` dijalankan otomatis. Untuk memindahkan data dari SQLite:

```bash
node scripts/backup.mjs                 # dump sqlite lama
sqlite3 data/fleetguard.db .dump | psql -d fleetguard   # atau pakai tool GUI
```

Tidak ada kode yang perlu diubah: query ditulis dengan placeholder `?` dan
driver Postgres menerjemahkannya ke `$1..$n`, sambil melewati placeholder yang
berada di dalam string SQL.