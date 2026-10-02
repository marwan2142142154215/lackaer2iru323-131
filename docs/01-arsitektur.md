# 01 — Arsitektur

## Gambaran besar

Ada tepat tiga pihak. Tidak ada komunikasi langsung antara APK dan bot.

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  HP SEWA  (Android 10–16)    │        │  PC / VPS  (Node.js 24 LTS) │
│                              │        │                              │
│  ┌────────────────────────┐  │        │  ┌────────────────────────┐  │
│  │ id.acefleet.guard      │  │  WSS  │  │ DeviceHub              │  │
│  │                        │  │◄──────►│  │  · challenge-response  │  │
│  │  GuardService (FGS)    │  │ /ws/v1 │  │  · 1 sesi per device   │  │
│  │   ├ GuardSocket        │  │ /device│  │  · geo-fence check     │  │
│  │   ├ Watchdog (500 ms)  │  │        │  │  · simpan media terenk. │  │
│  │   └ Heartbeat + Loc    │  │        │  └───────────┬────────────┘  │
│  │                        │  │        │              │               │
│  │  PolicyEngine (DPM)    │  │        │  ┌───────────▼────────────┐  │
│  │   suspend / camera /   │  │        │  │ CommandDispatcher (FIFO)│  │
│  │   lockNow / lockTask / │  │        │  │  head-of-line only     │  │
│  │   resetPassword        │  │        │  │  retry + TTL + cooldown│  │
│  │                        │  │        │  └───────────┬────────────┘  │
│  │  CommandExecutor       │  │        │              │               │
│  │  CaptureService        │  │        │  ┌───────────▼────────────┐  │
│  │  LocationProvider      │  │        │  │ TelegramBot            │  │
│  │  SecureStore (Keystore)│  │        │  │  DeviceResolver fuzzy  │  │
│  └────────────────────────┘  │        │  └───────────┬────────────┘  │
└──────────────────────────────┘        │              │               │
                                         │  ┌───────────▼────────────┐  │
                                         │  │ repos.js + db/         │  │
                                         │  │  devices, locations,   │  │
                                         │  │  command_log, admins   │  │
                                         │  └────────────────────────┘  │
                                         └──────────────────────────────┘
                                                        │
                                                        ▼
                                              ┌──────────────────┐
                                              │  Telegram Bot    │
                                              │  /lock /lokasi   │
                                              │  /kamera_depan … │
                                              └──────────────────┘
```

## Alur data

### 1. Autentikasi device (tanpa token lewat kabel)

```
Device                                   Server
  │                                        │
  │  WSS connect, sub-protocol fleetguard.v1│
  │ ─────────────────────────────────────> │
  │                                        │
  │        {"t":"challenge","nonce":"…"}    │
  │ <───────────────────────────────────── │
  │                                        │
  │ _deviceTag = hex(HMAC-SHA256(          │
  │      token, nonce + "." + deviceId))   │
  │ {"t":"auth","deviceId","nonce","tag"}  │
  │ ─────────────────────────────────────> │
  │                                        │ bandingkan tag dengan auth_secret_hash
  │        {"t":"welcome", config}         │ (server hanya punya hash + ciphertext)
  │ <───────────────────────────────────── │
```

Kenapa bukan "kirim token"? Karena `token` device punyaAES-256-GCM di Android
Keystore; kalau sempat dicuri log atau di-sniff lewat proxy yang salah
konfigurasi, token itu langsung jadi kunci semua perintah ke unit tersebut.
Tag HMAC sekali pakai dipatah setelah 15 detik.

### 2. Command (dua arah, tanpa jalan pintas)

```
Admin (Telegram) ──/lock HP-03──> Bot
   Bot: DeviceResolver ──> "HP-03" → device_id yang unik (margin 0,06)
   Bot: dispatcher.dispatch({deviceId, type:'lock', cmdId})
        └─ antrean FIFO per device_id; HANYA head-of-line yang dikirim
   Hub: {"t":"cmd","cmdId":123,"type":"lock","payload":{…}}  ──> Device
   Device: CommandExecutor.lock() → PolicyEngine.apply(LOCKED)
   Device: {"t":"result","cmdId":123,"ok":true,"data":{…}}  ──> Server
   Bot  : kirim foto/status ke admin
```

Kalau device offline, command **mengantre** (bukan gagal diam-diam) sampai TTL
 habis. Kalau token bot dipakai orang lain untuk `/lock`, resolver tidak akan
cocok karena whitelist `chat_id` menolak lebih dulu dan setiap aksi tercatat
di `audit_log`.

### 3. Pelacakan

Guard mengirim `loc` pada interval:

| Kondisi | Interval |
|---|---|
| Normal (tersedia untuk disewa) | 5 menit |
| `track_start` aktif | 10–3600 detik (diminta admin) |
| Unit terkunci / ditandai hilang | 60 detik |

Server melakukan pemeriksaan geofence (`haversine` dari `crypto/box.js`) dan
mengirim `sync_now` otomatis + alert Telegram kalau keluar radius.

## Keputusan desain dan alasannya

| Keputusan | Alasan |
|---|---|
| Satu broker di tengah | Mencegah salah target; satu titik audit, satu titik ROTASI kunci |
| `node:sqlite` bawaan, bukan `better-sqlite3` | Nol dependency native → jalan di Windows, tidak pain build, mudah pindah ke VPS/Postgres |
| Dual driver SQLite/Postgres | Deploy PC sekarang, migrasi VPS tanpa rewrite query |
| Head-of-line-only queue | `lock` lalu `unlock` tidak mungkin terbalik; tidak ada tabrakan dua command |
| Bot pakai `fetch` long-polling | Tidak butuh dependency bot framework; pindah ke VPS = copy folder |
| Bot memakai `this.tg` (notifier bisa ditukar) | Handler bot bisa diuji **offline** → 23 uji tanpa token asli |
| Message diproses dalam rantai promise per koneksi | Mencegah race antara `auth` dan `hello` yang pernah ditemukan waktu testing |
| Command hanya lewat frame `cmd` | Device mengabaikan frame tanpa `cmdId` → tidak bisa dieksekusi frame palsu |
| APK tanpa library WebSocket | APK memegang Device Owner; permukaan serangan yang belum dipercaya harus minimum |
| `setPackagesSuspended` hanya Android 14+ | API suspend resmi tidak ada di Android 10–13; jails itu tidak dicatat sebagai "terkunci penuh" |

## Batas yang diketahui (dinyatakan terbuka)

- Android **tidak** menyediakan API untuk membaca IMEI tanpa izin privileged OEM.
  Data IMEI tidak dikirim Guard.
- Factory reset dari recovery/fastboot tidak bisa dicegah oleh app mana pun.
- Hard power-off lalu penyewa menahan tombol power sampai mati tidak bisa dicegah.
- Guard butuh izin lokasi yang diberikan Device Owner; tanpa itu, `/lokasi`
  mengembalikan "izin belum diberikan" (bukan crash).
- Home/etalase yang tidak punya internet → Guard tetap menahan policy, tapi
  lokasi & command baru menunggu sampai koneksi kembali.

## Beban & skala

Untuk 300 unit aktif:

| Sumber | Beban |
|---|---|
| Koneksi WSS | 300 koneksi persisten, ±40 KB/menit/device saat heartbeat 30 detik |
| Payload | ±2 MB per foto; foto hanya diambil saat ada perintah, bukan streaming |
| SQLite | ±15 write/menit dengan 300 unit (masih sangat aman; migrasi ke Postgres di 1500+) |
| RAM server | ±120 MB (Node + buffer foto) |
| Migrasi ke Postgres | diperlukan bila > 1500 unit atau > 3 penamoa |

Kalau ragu, naikkan `HEARTBEAT_INTERVAL_MS` ke 60–120 detik: conexiones persisten
adalah yang mahal, bukan heartbeat-nya.