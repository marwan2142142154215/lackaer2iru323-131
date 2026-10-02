# 05 — Kebijakan Android: lock, watchdog, anti-reset

Bagian ini menjawab pertanyaan yang paling sering ditanyakan:
**"Kalau saya tekan power, apakah tracking-nya putus?"**

Jawaban singkat: **tidak, asalkan Guard sudah Device Owner dan enrolment-nya
Zero-Touch.** Berikut mekanismenya, per batas sistem yang nyata.

---

## 1. Fondasi: kenapa harus Device Owner, bukan Android Device Policy

| Kemampuan | Android Device Policy | Guard (DPC custom) |
|---|---|---|
| `lockNow()` | ya | ya |
| `resetPassword()` | ya | ya |
| `wipeData()` | ya | ya |
| `setCameraDisabled()` | ya | ya |
| `DISALLOW_FACTORY_RESET` | ya | ya |
| `setPackagesSuspended()` (Android 14+) | ya | ya |
| `startLockTask()` | ya | ya |
| `setUninstallBlocked()` | ya | ya |
| `setPermissionGrantState()` | ya | ya |
| Ditandatangani sendiri + Zero-Touch | n/a | ya (`dpcExtras`) |

Semua API yang dibutuhkan tersedia di kelas Device Admin standar. Yang berbeda
adalah **siapa yang memegang device**: Android Device Policy dikendalikan dari
luar lewat AMAPI, sedangkan Guard memegang device secara lokal dan juga terpasang
lewat Zero-Touch. Kombinasi keduanya yang dipakai di sini:

- **Zero-Touch / AMAPI** → memasang Guard sebagai Device Owner.
- **Guard** → menegakkan kebijakan dari device, seketika, tanpa bergantung
  pada server.
- **Server + bot** → mengubah desired state dan memberi perintah.

> Konsekuensi arsitektur: kalau server mati, Guard **tetap** mengunci unit yang
> sudah `locked` karena desired state disimpan lokal di `Config`. Yang hilang
> hanya perintah baru dan pembaruan lokasi.

---

## 2. Matriks: apa yang terjadi pada setiap kejadian

| Kejadian | Yang terjadi | Perlu koneksi server? | Waktu pulih |
|---|---|---|---|
| Penyewa tekan **power** (matikan) | Guard mati bersama proses | tidak | saat dinyalakan lagi |
| Penyewa nyalakan lagi | `BOOT_COMPLETED` → alarm backstop → service hidup | tidak | < 15 detik |
| Penyewa **matikan dan restart** | `MY_PACKAGE_REPLACED` / boot → Guard hidup lagi | tidak | < 15 detik |
| Penyewa **factory reset** dari Settings | **Ditolak** (`DISALLOW_FACTORY_RESET`) | tidak | ditolak seketika |
| Penyewa buka menu Developers lalu uninstall Guard | **Tidak bisa** (`setUninstallBlocked`) | tidak | ditolak |
| Penyewa klik "Remove account / Reset app preferences" | Ditolak | tidak | ditolak |
| `adb shell pm wipe` | Ditolak selama device owner aktif | tidak | ditolak |
| Penyewa tekan Back saat terkunci | Kembali ke layar kunci | tidak | seketika |
| Penyewa pakai aplikasi lain saat `locked` | Di-suspend (Android 14+) / terkunci (10–13) | tidak | seketika |
| Wi-Fi mati | Socket reconnect dengan backoff 1–30 detik | tidak | otomatis |
| Server mati | Policy lokal tetap jalan; perintah & lokasi tertunda | tidak | saat server hidup lagi |
| Penyewa mengganti SIM / kartu | Tidak berpengaruh pada Device Owner | tidak | tidak berubah |
| Recovery / fastboot wipe | **Tidak bisa dicegah** | tidak | unit keluar sistem |

---

## 3. Skenario "reboot paksa" secara rinci

Android 12+ melarang `startForegroundService()` dipanggil dari
`BOOT_COMPLETED` (penalti `ForegroundServiceStartNotAllowedException`). Kalau
hanya mengandalkan boot receiver, service **tidak akan** hidup di Android 12+.

Solusinya dua lapis:

```
                    ┌─────────────────────────┐
  SEBELUM reboot ──► AlarmManager.setExact    │  ← dijadwalkan saat service hidup
                    │  (backstop, 15 detik)   │
                    └───────────┬─────────────┘
                                │  alarm tetap menyala setelah reboot
                                ▼
                    ┌─────────────────────────┐
                    │ RestartReceiver          │
                    │  → startForegroundService│
                    └───────────┬─────────────┘
                                ▼
                    ┌─────────────────────────┐
                    │ GuardService             │
                    │  FGS: dataSync|location │
                    │  + specialUse            │
                    │  → Watchdog (500 ms)     │
                    └───────────┬─────────────┘
                                ▼
                    ┌─────────────────────────┐
                    │ GuardSocket reconnect    │
                    │  backoff 1s → 30s        │
                    └─────────────────────────┘
```

Kalau `startForegroundService` dari alarm juga ditolak (OEM sangat ketat),
`GuardService.onDestroy()` menjadwalkan backstop lagi, jadi tidak ada keadaan
yang benar-benar mati.

---

## 4. Skenario "dibuka paksa" (paling relevan untuk rental)

Kebutuhan: begitu unit dibuka/dibuka kuncinya, dalam **0,5 detik** kembali
terkunci.

```
t=0.000  Admin kirim /lock HP-03
t=0.080  Server kirim frame {"t":"cmd","type":"lock"}
t=0.140  Guard: PolicyEngine.apply(LOCKED)
           ├─ setPackagesSuspended(..., true)     [Android 14+]
           ├─ setCameraDisabled(true)
           ├─ lockNow()          ← layar kunci seketika
           └─ setLockTaskPackages + startLockTask
t=0.200  Guard balas {"t":"result","ok":true}
t=0.205  Bot: "HP-03 dikunci"
```

### Kenapa watchdog 500 ms perlu

`lockNow()` hanya perlu satu kali. Tapi penyewa bisa:

- menekan tombol power untuk mematikan layar, lalu menyalakannya lagi;
- menyalakan Wi-Fi/kamera lewat panel cepat saat policy masih locked;
- memaksa aplikasi Guard ditutup lewat "Force stop" di Settings.

`Watchdog` memeriksa lima hal tiap 500 ms dan **idempotent**:

| Cek | Tindakan perbaikan |
|---|---|
| Guard masih Device Owner | kirim event `tamper` ke server |
| `DISALLOW_FACTORY_RESET` masih aktif | `applyBaseRestrictions()` ulang |
| `policy_state` sesuai desired | `engine.apply(...)` ulang |
| Kamera mati saat locked | `engine.apply(...)` ulang |
| Socket tidak macet | reset socket |

Saat unit `locked`, siklus turun ke **5 detik** untuk menghemat baterai;
saat `unlocked` (penyewa sedang memakai) tetap **500 ms** supaya penyimpangan
ketahatan dalam setengah detik.

---

## 5. Matriks lock per versi Android

| Aksi | Android 10–13 (API 29–33) | Android 14–16 (API 34–36) |
|---|---|---|
| Kunci layar | `lockNow()` | `lockNow()` |
| Matikan kamera | `setCameraDisabled(true)` | idem |
| Matikan status bar | `setStatusBarDisabled(true)` | idem |
| Halaman kios | `startLockTask()` | idem |
| Bekukan aplikasi lain | **tidak ada API resmi** → kunci layar berulang | `setPackagesSuspended(..., true)` |
| Ganti PIN | `resetPassword()` | idem |
| Ganti PIN otomatis tiap unit | `resetPassword()` | idem |

### Batas yang dinyatakan terbuka untuk Android 10–13

Tidak ada API publik untuk "mematikan" satu aplikasi individual dari Device
Owner sebelum Android 14. Yang sah dan dipakai:

1. `lockNow()` setiap 500 ms dari watchdog (aplikasi di belakang tetap
   membeku karena layar terkunci),
2. `setLockTaskPackages` + `startLockTask` untuk mode kios total,
3. `setCameraDisabled(true)` supaya kamera benar-benar mati,
4. `DISALLOW_INSTALL_APPS` supaya tidak ada aplikasi baru.

Jadi pada Android 10–13, "terkunci" berarti **tidak ada yang bisa dipakai dan
tidak bisa dipasang apa pun** - bukan proses aplikasi yang dibunuh. Ini
perbedaan yang harus diketahui staf, jangan dijanjikan "aplikasi membeku
total".

---

## 6. Anti-factory-reset: yang bisa dan tidak bisa dicegah

### Yang dicegah (sah, API resmi)

| Vektor | Pencegahan |
|---|---|
| Settings → System → Reset options | `DISALLOW_FACTORY_RESET` |
| Settings → Apps → Guard → Uninstall | `setUninstallBlocked(Guard)` |
| "Force stop" Guard lalu reset | `DISALLOW_APPLY_RESTRICTION` |
| Menghapus device admin | Device Owner tidak bisa dilepas tanpa factory reset |
| `adb shell pm wipe` (ADB debugging aktif) | `DISALLOW_DEBUGGING_FEATURES` + OEM often disable ADB |

### Yang **tidak** bisa dicegah

| Vektor | Kenapa mustahil |
|---|---|
| Fastboot / recovery wipe | Di luar kendali OS; aplikasi tidak berjalan |
| Flash custom ROM | Bootloader unlock butuh Gesture/PIN yang sudah diganti Guard, tapi recovery tetap terbuka |
| Hard power-off lalu tahan tombol | Butuh battery físicamente kosong |
| IMEI diblokir di jaringan lain | Perlu blocklist operator, bukan app |

**Rekomendasi operasional untuk anti-curian sungguhan:**

1. **GSMA Device Check / IMEI blocklist** — satu-satunya cara memblokir unit
   di jaringan seluler mana pun di dunia. Direkomendasikan kerja sama dengan
   operator atau penyedia layanan Device Check.
2. **Asuransi** dengan polymorphism daftar IMEI.
3. **CCTV + catatan serah terima** untuk unit mahal.
4. Klarifikasi ke pelanggan: sistem ini mencegah **penyewa keluar dari sistem**,
   bukan mencegah **pencurian fisik**.

---

## 7. Anti-tamper tambahan

| Serangan | Penangkal |
|---|---|
| Penyewa mematikan Guard dari Settings | `DISALLOW_INSTALL_APPS` + `setUninstallBlocked` + device owner |
| Penyewa menyalakan debug USB | `DISALLOW_DEBUGGING_FEATURES` + `setStatusBarDisabled` |
| Penyewa ganti PIN lalu reset | `DISALLOW_RESET_PIN` + `setMaximumFailedPasswordsForWipe(30)` |
| Penyewa uninstall via ADB | Device owner tidak bisa di-uninstall; `adb uninstall` ditolak |
| Penyewa matiin GPS | Tidak dicegah — tapi geofence server tetap punya titik terakhir |
| Serangan ke server | TLS, WSS only, HMAC challenge, token di-hash, whitelist chat_id |

---

## 8. Detail implementasi yang penting

### 8.1 Frame `sync` = sumber kebenaran config

Setiap kali `welcome` diterima, Guard menyalin `config` dari server ke `Config`
lokal (radius, geofence, policy state, nama). Jadi admin yang melakukan `/lock`
tidak perlu menunggu frame khusus — konfigurasi ikut saat koneksi.

### 8.2 Idempotensi

Semua operasi `DevicePolicyManager` dipanggil ulang tiap 500 ms saat drift.
Karena itu semuanya harus idempotent: `setPackagesSuspended` dengan flag sama,
`lockNow()` berulang, `resetPassword` hanya saat diminta. Jangan tambahkan
operasi yang merusak data (misalnya `wipeData`) ke dalam watchdog.

### 8.3 Perbandingan HMAC harus identik

Server (`hub.js`) dan device (`GuardSocket.deviceTag`) memakai rumus yang sama:

```
tag = hex(HMAC-SHA256(token, "<nonce>.<deviceId>"))
```

Kalau salah satu berubah, semua device gagal auth. `selftest.mjs` menguji ini
termasuk kasus token palsu (harus ditolak dengan kode `4004`).

### 8.4 Background location

Android 10+ membedakan lokasi foreground vs background. Karena Guard berjalan
sebagai foreground service dengan notifikasi terlihat (tipe `location`), izin
`ACCESS_BACKGROUND_LOCATION` **tidak wajib** untuk tracking lokasi dari
foreground service. Semua izin runtime diberikan otomatis oleh Device Owner
lewat `DevicePolicyManager.setPermissionGrantState`.

---

## 9. Checklist uji lapangan

Sebelum dikumpulkan ke penyewa, jalankan per unit:

- [ ] `/status` menampilkan `is_online: true` dalam 30 detik.
- [ ] `/lokasi` mengembalikan koordinat dalam 60 detik.
- [ ] `/lock` → layar kunci dalam 1 detik; aplikasi lain tidak bisa dibuka.
- [ ] `/kamera_belakang` → foto sampai di Telegram (bukan error izin).
- [ ] `/unlock` → PIN baru diterima dan bisa dipakai untuk buka layar kunci.
- [ ] Matikan HP, nyalakan lagi → Guard aktif tanpa reset, `/status` online lagi.
- [ ] Settings → Factory reset → **tidak ada** opsi / ditolak.
- [ ] Settings → Apps → Guard → Uninstall → **tidak ada** / ditolak.
- [ ] Wi-Fi mati 10 menit → nyalakan lagi → Guard reconnect otomatis.
- [ ] Lokasi dimatikan → `/lokasi` tetap memakai titik terakhir, tidak crash.
- [ ] `/apply_policy` → admin Policies masih utuh (tanpa restart).