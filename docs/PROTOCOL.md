# PROTOCOL — Guard ⇄ Broker

Versi protokol: **`fleetguard.v1`**

Transport: **WSS** (TLS 1.2+), path `/ws/v1/device`, header
`Sec-WebSocket-Protocol: fleetguard.v1`.

Semua frame adalah JSON **teks** dengan field wajib `t` (jenis frame). Ukuran
maksimum satu frame: **6 MB** (batas atas foto 5 MB → base64).

---

## 1. Alur koneksi

```
Device                                     Server
  │                                          │
  │  TLS handshake (WSS, sertifikat valid)   │
  │ ────────────────────────────────────────>│
  │  HTTP Upgrade + Sec-WebSocket-Key        │
  │ <────────────────────────────────────────│
  │  101 Switching Protocols                  │
  │ <────────────────────────────────────────│
  │                                          │
  │        {"t":"challenge","nonce":"<hex>"} │  (server, 15 detik timeout)
  │ <────────────────────────────────────────│
  │                                          │
  │  {"t":"auth","deviceId":"HP-001-TOKO-A", │
  │   "nonce":"<hex>",                       │
  │   "tag":"<hex HMAC>"}                    │
  │ ────────────────────────────────────────>│
  │                                          │ bandingkan dengan auth_secret_hash
  │        {"t":"welcome","deviceId":…,       │  atau HMAC token tersimpan
  │         "nama":…, "serverTime":…,        │
  │         "heartbeatIntervalMs":30000,     │
  │         "config":{…}}                    │
  │ <────────────────────────────────────────│
  │                                          │
  │  {"t":"hello","status":{…}}              │  laporan lengkap
  │ ────────────────────────────────────────>│
  │        {"t":"sync","config":{…}}         │  konfirmasi config terbaru
  │ <────────────────────────────────────────│
  │  (loop: hb / loc / event / result / media)│
```

### 1.1 Autentikasi

```json
// server -> device
{"t":"challenge","nonce":"7f3a9c1e5b2d8046af1c3e5d7b9f02468"}

// device -> server
{
  "t": "auth",
  "deviceId": "HP-001-TOKO-A",
  "nonce": "7f3a9c1e5b2d8046af1c3e5d7b9f02468",
  "tag": "9c1e5d7b9f02468..."
}
```

```
tag = hex(HMAC-SHA256(token, nonce + "." + deviceId))
```

Token **tidak pernah** dikirim. Lihat implementasi:

- Server: `src/net/hub.js` → `handleAuth()`.
- Device: `android/.../net/GuardSocket.kt` → `GuardSocket.deviceTag()`.

Kalau `tag` salah → `{"t":"error","code":4004,"message":"autentikasi gagal"}`
 lalu koneksi ditutup. Device lalu menunggu `backoff` sebelum mencoba lagi.

### 1.2 Isi `config` (dikirim di `welcome` dan `sync`)

```json
{
  "radiusM": 150,
  "geofenceArmed": false,
  "policyState": "unlocked",
  "statusSewa": "tersedia",
  "namaDevice": "HP-001 TOKO A",
  "watchdogMsUnlocked": 500,
  "watchdogMsLocked": 5000,
  "mediaUrl": "https://fleet.example.my.id",
  "latestMediaId": 42
}
```

Device **menyalin** config ini ke penyimpanan lokal (`Config`), lalu/from situ
watchdog membacanya dari sana. Config server menang; config device tidak menulis
balik.

---

## 2. Frame Server → Device

| `t` | Kapan | Isi |
|---|---|---|
| `challenge` | setelah upgrade WS | `nonce` |
| `welcome` | auth berhasil | `deviceId`, `nama`, `serverTime`, `heartbeatIntervalMs`, `config` |
| `sync` | setelah `hello`, atau setelah config berubah | `config` |
| `cmd` | ada command di head antrean | `cmdId`, `type`, `payload` |
| `ping` | tiap 20 detik | `ts` |
| `ack` | konfirmasi | `for` (`ping`/`media`), `mediaId`, `bytes` |
| `error` | auth gagal / payload cacat | `code`, `message` |

### 2.1 `cmd`

```json
{
  "t": "cmd",
  "cmdId": 1284,
  "type": "lock",
  "payload": {"reason":"pembayaran telat"}
}
```

`type` harus ada di katalog server (`src/commands/catalog.js`). Device
menolak `cmd` tanpa `cmdId` positif.

### 2.2 `ping`

```json
{"t":"ping","ts":1767321000000}
```

Device menjawab:

```json
{"t":"pong","pong":1767321000000}
```

Server memakai ini untuk mengukur socket yang "hidup tapi diam".

---

## 3. Frame Device → Server

| `t` | Kapan | Field utama |
|---|---|---|
| `auth` | setelah `challenge` | `deviceId`, `nonce`, `tag` |
| `hello` | sekali setelah `welcome` | `status` |
| `hb` | tiap `heartbeatIntervalMs` | `status`, `pong` (opsional) |
| `loc` | sesuai jadwal tracking | `location` |
| `event` | tamper / boot / drift / baterai | `event`, `severity`, `detail` |
| `result` | setelah menjalankan `cmd` | `cmdId`, `ok`, `data`/`error` |
| `media` | setelah `/kamera_*` | `kind`, `mime`, `b64`, `lat`, `lng` |
| `log` | diagnostik (opsional) | `level`, `msg` |
| `pong` | jawab `ping` | `pong` |

### 3.1 `status` (dipakai `hello` dan `hb`)

```json
{
  "t": "hb",
  "status": {
    "androidVersion": "13",
    "apiLevel": 33,
    "model": "SM-A125F",
    "manufacturer": "samsung",
    "appVersion": "1.0.0",
    "policyState": "locked",
    "locked": true,
    "kiosk": false,
    "geofenceArmed": true,
    "radiusM": 150,
    "deviceOwner": true,
    "battery": 74,
    "batteryTemp": 31.5,
    "charging": false,
    "network": "cellular",
    "ramFreeMb": 812,
    "storageFreeMb": 20480,
    "bootAt": 1767300000000,
    "serviceStartAt": 1767321000000,
    "androidId": "a1b2c3d4e5f6a7b8"
  }
}
```

Semua field opsional; yang tidak ada tidak di-update. `imei` **tidak** dikirim
(Android tidak menyediakan API itu).

### 3.2 `loc`

```json
{
  "t": "loc",
  "location": {
    "lat": -6.2087634,
    "lng": 106.8455960,
    "accuracy": 8.5,
    "altitude": 15.0,
    "speed": 0.4,
    "source": "fused",
    "ts": "2026-10-02T10:15:00.000Z"
  }
}
```

Server membandingkan jarak ke titik acuan; kalau melewati `radiusM`, device
di-flag `geofence_breach`, server mengirim `sync_now` otomatis, dan bot
menerima alert level `critical`.

### 3.3 `result`

```json
{"t":"result","cmdId":1284,"ok":true,"data":{"locked":true,"policyState":"LOCKED"},"ms":142}
```

```json
{"t":"result","cmdId":1285,"ok":false,"error":"izin kamera belum diberikan","ms":8}
```

`cmdId` wajib sama persis dengan yang dikirim server. Kalau tidak cocok, hasil
diabaikan dan dicatat `result tidak cocok` (anti reply tertukar).

### 3.4 `media`

```json
{
  "t": "media",
  "kind": "front",
  "mime": "image/jpeg",
  "b64": "/9j/4AAQSkZJRgABAQ...",
  "ts": "2026-10-02T10:15:00.000Z",
  "lat": -6.2087634,
  "lng": 106.8455960
}
```

Server memverifikasi magic byte JPEG (`ffd8`), menyimpan terenkripsi ke
`data/media/`, lalu mengirim `ack`:

```json
{"t":"ack","for":"media","mediaId":88,"bytes":412331}
```

Bot kemudian mengirim foto ke admin lewat `sendPhoto` (dibaca dari
`/api/media/:id` dengan session admin, bukan langsung dari Telegram).

### 3.5 `event`

```json
{
  "t": "event",
  "event": "policy_drift",
  "severity": "critical",
  "detail": "pembatasan factory reset dilepas; sudah diterapkan ulang",
  "ts": "2026-10-02T10:15:00.000Z"
}
```

Nilai `severity`:

| Nilai | Arti | Bot |
|---|---|---|
| `info` | catatan biasa (online/offline) | tidak kirim |
| `warn` | perlu diketahui (baterai < 15%) | kirim ke admin |
| `critical` | perlindungan terganggu | kirim + tandai di dashboard |

---

## 4. Katalog command

Sumber kebenaran: `server/src/commands/catalog.js`.

| Type | TTL | Butuh online | Description |
|---|---|---|---|
| `lock` | 30 s | ya | Kunci layar + suspend app lain + matikan kamera |
| `unlock` | 60 s | ya | Buka kunci, PIN baru dikirim ke admin |
| `pin` | 30 s | ya | Ambil PIN layar kunci saat ini |
| `set_kiosk` | 30 s | ya | Mode kios: hanya Guard yang bisa dibuka |
| `locate` | 45 s | ya | Ambil lokasi sekali, akurasi tinggi |
| `track_start` | 30 s | ya | Kirim lokasi terus-menerus |
| `track_stop` | 20 s | ya | Stop pengiriman lokasi berkala |
| `camera_front` | 60 s | ya | Foto kamera depan |
| `camera_rear` | 60 s | ya | Foto kamera belakang |
| `ring` | 30 s | ya | Bunyikan alarm + getarkan |
| `toast` | 20 s | ya | Tampilkan pesan di layar penyewa |
| `set_geofence` | 30 s | tidak | Set radius (meter), 0 = matikan |
| `apply_policy` | 45 s | ya | Terapkan ulang seluruh DevicePolicyManager |
| `restart_app` | 45 s | ya | Bunuh & restart proses Guard |
| `reboot` | 30 s | ya | Reboot perangkat (destructive) |
| `wipe` | 60 s | ya | Hapus data Guard & kunci total (destructive) |
| `sync_config` | 30 s | ya | Kirim konfigurasi terbaru ke device |
| `sync_now` | 45 s | ya | Paksa device kirim stok + lokasi sekarang |

Aturan antrean (`src/commands/dispatcher.js`):

1. **Satu command in-flight per device.** Hanya head-of-line yang dikirim.
2. `attempt` naik sampai `max_attempts` (default 2) dengan backoff.
3. Lewat `expires_at` → status `expired`.
4. Maksimal `QUEUE_MAX_DEPTH` (default 40) per device; lebih dari itu ditolak.
5. `cooldownSec` per type mencegah spam (misal `lock` 3 detik).

---

## 5. Endpoint HTTP (bukan bagian WSS, tapi dipakai device)

| Method | Path | Auth | Dipakai oleh |
|---|---|---|---|
| `POST` | `/api/enroll/pair` | kode pairing 8 karakter | Guard saat pairing |
| `GET` | `/healthz` | tidak | monitoring |
| `POST` | `/api/login` | username + password | dashboard |
| `GET` | `/api/devices` | session admin | dashboard |
| `GET` | `/api/devices/:id` | session admin | dashboard |
| `POST` | `/api/devices/:id/command` | session admin | dashboard |
| `GET` | `/api/media/:id` | session admin | dashboard + bot kirim foto |
| `GET` | `/api/stream` | session admin | SSE dashboard |

### 5.1 Pairing

Request:

```json
POST /api/enroll/pair
{"code":"K7M2P9QX"}
```

Respons:

```json
{
  "deviceId": "HP-001-TOKO-A",
  "nama": "HP-001 TOKO A",
  "token": "<32 byte base64url>",
  "wsUrl": "wss://fleet.example.my.id/ws/v1/device",
  "protocol": "fleetguard.v1",
  "heartbeatIntervalMs": 30000
}
```

Kode pairing **sekali pakai**: setelah dipakai, `pair_code_hash` di-null-kan.
Percobaan gagal dicatat di `audit_log` dengan `actor_kind='device'`.
Rate limit 20 percobaan / 60 detik per IP.

Guard menyimpan `deviceId` + `token` di `SecureStore` (AES-GCM dengan kunci
Android Keystore), lalu `MainActivity` menyalakan `GuardService`.

---

## 6. Aturan interoperabilitas

Kalau versi Guard berbeda dengan versi server:

| Perubahan | Perilaku |
|---|---|
| Server menambah `type` baru | Device lama membalas `{ok:false, error:"command tidak didukung: X"}`. Bot menampilkan pesan jelas, bukan diam. |
| Device menambah field `status` | Server mengabaikan field yang tidak dikenal. |
| Server menambah field `config` | Device mengabaikan. |
| `heartbeatIntervalMs` berubah | Device mengikuti nilai server (dikirim di `welcome`). |

Tidak ada negotiate versi di level frame; versioning dilakukan lewat header
`Sec-WebSocket-Protocol`. Bila muncul perubahan yang merusak, naikkan ke
`fleetguard.v2` dan tolak handshake untuk mismatch (implementasi saat ini
hanya menerima `fleetguard.v1`, gagal lain akan ditolak).

---

## 7. Debug

**Server**:

```bash
tail -f logs/$(date +%F).log | grep hub
```

Log `hub` mencatat: `auth ok`, `device online/offline`, `gagal kirim frame`,
`media gagal`, `result tidak cocok`.

**Device** (adb):

```bash
adb logcat -s FG/Guard FG/Socket FG/Policy FG/Watchdog FG/Cmd FG/Location
```

Prefix `FG/` memudahkan memisahkan log Guard dari log sistem.

**Simulator** (untuk uji broker tanpa HP):

```bash
node scripts/simulator.mjs --count 4
node scripts/selftest.mjs
```

---

## 8. Batas dan catatan jujur

- Protokol ini **tidak** memakai TLS pinning di sisi device secara default.
  `network_security_config.xml` menyediakan `<pin-set>` yang bisa diisi untuk
  produksi; belum diisi di repo ini karena sertifikat harus milik Anda.
- Frame `media` dalam base64 menambah ukuran ±33%. Karena itu foto
  dikompresi (JPEG quality 60) sebelum dikirim.
- Tidak ada kompresi untuk frame `loc` / `hb`; ukurannya kecil (< 500 byte).
- Rate limit ada di HTTP (pairing, login) tapi tidak di level WSS; server
  menutup koneksi yang melakukan auth gagal berulang lewat backoff device.