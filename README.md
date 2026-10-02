# Fleet Guard

Sistem **fleet tracking & anti-theft untuk bisnis rental HP** yang dirancang untuk
ratusan unit Android 10–16.

Tiga komponen, satu alur data dua arah, tidak ada jalur pintas:

```
APK Guard (DPC / Device Owner)  ⇄  Server broker (PC lokal)  ⇄  Bot Telegram
```

> **Aturan emas arsitektur:** APK Guard **tidak pernah** bicara langsung ke bot
> Telegram. Semua perintah masuk dari server broker, semua laporan keluar ke
> server broker. Ini yang membuat "salah kirim command ke unit yang salah" secara
> struktural mustahil, bukan sekadar dicek dengan test.

---

## Status implementasi

| Bagian | Status | Catatan |
|---|---|---|
| Server broker (Node.js, WSS + HTTP + dashboard) | Selesai & diuji | 15/15 self-test, 23/23 bot-test |
| Bot Telegram (15 command + fuzzy match) | Selesai & diuji | whitelist chat_id, RBAC, audit |
| Skema DB SQLite + PostgreSQL | Selesai | dual driver, nol dependency native |
| Onboarding massal (QR + NFC NDEF + CSV) | Selesai | `scripts/onboard.mjs` |
| APK Guard (Kotlin, Device Owner) | **Selesai & ditandatangani** | `dist/guard-1.0.0-release.apk` + `dist/guard-1.0.0-debug.apk`. Lihat [docs/06-build-apk.md](docs/06-build-apk.md) |
| Dokumentasi & infra | Selesai | `docs/`, `infra/` |

Kedua APK sudah benar-benar dikompilasi dan diverifikasi tanda tangannya,
bukan sekadar source code:

| Artefak | Package | Ukuran | Signing |
|---|---|---|---|
| `dist/guard-1.0.0-release.apk` | `id.acefleet.guard` | 1.16 MB | `CN=Fleet Guard` (R8 shrunk) |
| `dist/guard-1.0.0-debug.apk` | `id.acefleet.guard.debug` | 8.24 MB | `CN=Android Debug` |

Toolchain Android di-bootstrap manual (JDK 25 + SDK platform 36 + Gradle 9.5.0)
karena `cmdline-tools` tidak ada di mesin ini. Semua error compile Kotlin
diperbaiki berdasarkan `javap` terhadap `android.jar` API 36, bukan asumsi.

Yang **belum** bisa diverifikasi: pairing ke HP nyata, provisioning DPC lewat
ZTE, dan burn-test policy di lapangan. Semuanya butuh perangkat nyata dan
akun Android Device Provisioning Partner.

---

## Struktur folder

```
fleet-guard/
├─ server/                     # broker (jalan di PC lokal, nanti bisa pindah ke VPS)
│  ├─ src/
│  │  ├─ index.js              # entry point, bootstrap, graceful shutdown
│  │  ├─ config.js             # .env loader + defaults
│  │  ├─ eventbus.js           # event internal (lokasi, alert, media)
│  │  ├─ net/hub.js            # WebSocket device: auth challenge, media, geofence
│  │  ├─ api/http.js           # REST + SSE dashboard + /api/enroll/pair
│  │  ├─ commands/             # catalog (sumber kebenaran) + dispatcher FIFO
│  │  ├─ telegram/             # bot, resolver fuzzy, formatter, API client
│  │  ├─ db/                   # dual driver, schema sqlite/pg, semua query
│  │  └─ crypto/box.js         # AES-256-GCM, scrypt, HMAC, haversine
│  ├─ scripts/                 # onboard, admin, simulator, selftest, bottest, backup
│  ├─ public/dashboard.html    # dashboard live (login + SSE)
│  ├─ data/                    # fleetguard.db, keyring.json, media/  (RAHASIA)
│  └─ .env                     # konfigurasi (JANGAN commit)
├─ android/                    # sources APK Guard
│  ├─ app/src/main/java/id/acefleet/guard/
│  │  ├─ GuardDeviceAdminReceiver.kt   # DPC: jadi Device Owner
│  │  ├─ policy/PolicyEngine.kt        # semua DevicePolicyManager
│  │  ├─ net/GuardSocket.kt            # WSS tanpa dependency
│  │  ├─ service/GuardService.kt       # FGS: socket + watchdog + loop
│  │  ├─ service/Watchdog.kt           # siklus 500 ms
│  │  ├─ commands/CommandExecutor.kt   # 18 command
│  │  ├─ media/CaptureService.kt       # CameraX
│  │  ├─ location/LocationProvider.kt  # fused location
│  │  ├─ core/SecureStore.kt           # token di Android Keystore
│  │  └─ ui/                           # pairing + layar kios
│  └─ tools/check-sources.mjs  # pemeriksaan statis cepat
├─ docs/                       # 6 dokumen + PROTOCOL.md
└─ infra/                      # cloudflared, nginx, Caddy, systemd, autostart Windows
```

---

## Menjalankan server (PC lokal)

Prasyarat: **Node.js 22.5+ (disarankan 24 LTS)**. Tidak ada build native, tidak
ada perlu `npm rebuild`.

```powershell
cd "fleet-guard\server"
npm.cmd install
Copy-Item .env.example .env      # lalu isi TELEGRAM_BOT_TOKEN & PUBLIC_BASE_URL
node src/index.js
```

Sehat? Cek:

```powershell
curl.exe http://localhost:8787/healthz
```

### Membuat admin dashboard

```powershell
node scripts/admin.mjs add andi "Rental2026!oke" superadmin
```

### Pairing pertama unit

```powershell
node scripts/onboard.mjs --count 8 --prefix HP --nama "TOKO-A" --out out\UJI
```

Perintah itu menghasilkan `devices.csv` (berisi `device_id` + kode pairing),
`enroll-qr.png` untuk dicetak, dan `enroll-nfc.txt` (payload NDEF untuk ditulis
ke tag NFC). Detail lengkap: [docs/03-zero-touch.md](docs/03-zero-touch.md).

### Mengaktifkan chat Telegram

`chat_id` hanya diketahui setelah kamu mengirim `/start` ke bot. Bot akan
menjawab dengan instruksi persis, misalnya:

```
node scripts/admin.mjs chat andi 1234567890
```

Lalu masukkan `1234567890` ke `ADMIN_CHAT_IDS` di `.env` dan restart server.

---

## Uji

Butuh server jalan. Urutannya penting: simulator hanya bisa menghubungkan
device yang sudah terdaftar di DB, jadi seed dulu.

```powershell
node scripts/seed-test-devices.mjs               # buat HP-001..HP-004 (data UJI)
node scripts/simulator.mjs --count 4             # 4 device palsu, biarkan jalan
node scripts/selftest.mjs                        # 15 uji integrasi broker
node scripts/bottest.mjs                         # 23 uji handler bot (tanpa jaringan)
```

Setelah selesai menguji, **wajib** bersihkan supaya dashboard tidak menampilkan
data palsu:

```powershell
node scripts/seed-test-devices.mjs --clean       # hapus hanya perangkat UJI
# atau hapus semuanya (backup otomatis lebih dulu):
node scripts/purge-devices.mjs --yes --keep-admin
```

Pemeriksaan statis sumber APK (tanpa Android SDK):

```powershell
node android\tools\check-sources.mjs android\app\src\main
```

Catatan jujur: `check-sources.mjs` **tidak** memeriksa import maupun signature
API Android. Saat build pertama dicoba, checker itu lolos 100% padahal ada ~40
error compile. Untuk kode Android, uji build Gradle satu-satunya sumber
kebenaran.

---

## Peringatan yang harus dibaca sebelum produksi

1. **Token bot Telegram pernah bocor.** Kalau token ini pernah dikirim lewat
   chat/email, **wajib** `/revoke` di @BotFather lalu update `.env`. Token bot
   memberi kendali penuh atas semua unit.
2. **`data/keyring.json` adalah nyawa sistem.** Tanpa file ini, seluruh token
   device dan data terenkripsi tidak bisa dipulihkan. Backup rutin
   (`node scripts/backup.mjs`) dan simpan salinannya di luar PC ini.
3. **Anti-factory-reset bukan anti-curian.** Zero-Touch + Device Owner mencegah
   penyewa keluar dari sistem lewat factory reset biasa, tapi tidak mencegah
   unit hilang dibawa kabur. Untuk itu perlu kombinasi dengan
   **GSMA Device Check** (blocklist IMEI) dan kesepakatan insurance.
   Detail jujur: [docs/05-android-policy.md](docs/05-android-policy.md).
4. **Server harus bisa dijangkau dari internet** dengan WSS + TLS asli, bukan
   HTTP/port forwarding mentah. Pilihan dan konfigurasinya:
   [docs/04-eksposur.md](docs/04-eksposur.md).

---

## Dokumentasi

| Dokumen | Isi |
|---|---|
| [docs/01-arsitektur.md](docs/01-arsitektur.md) | Diagram, alur data, keputusan desain |
| [docs/02-database.md](docs/02-database.md) | Skema 4 tabel + aturan retensi & enkripsi |
| [docs/03-zero-touch.md](docs/03-zero-touch.md) | ZTE portal, QR 6-tap, NFC, Device Provisioning Partner API |
| [docs/04-eksposur.md](docs/04-eksposur.md) | Cloudflare Tunnel / Caddy / DDNS / TLS / hardening |
| [docs/05-android-policy.md](docs/05-android-policy.md) | Matriks lock/watchdog/reset + batas sah Android |
| [docs/06-build-apk.md](docs/06-build-apk.md) | Cara build APK pertama + toolchain & fallback |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Protokol wire Guard ⇄ broker |