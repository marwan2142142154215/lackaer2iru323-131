# 03 — Zero-Touch onboarding (ZTE, Samsung KME, QR, NFC)

Tujuan: menambah ratusan unit tanpa harus meny-setup satu per satu, dan **factory reset
tidak memutus tracking**.

Empat jalur yang tersedia, dari paling otomatis sampai paling universal:

| Metode | Untuk | Prasyarat | Sentuhan per unit |
|---|---|---|---|
| **A. ZTE Zero-Touch** | semua unit ZTE | akun reseller ZTE + Android Device Provisioning Partner | nol |
| **B. Samsung KME** | unit Samsung | akun Samsung KME | nol |
| **C. QR 6-tap** | semua merek, Android 10–16 | kamera belakang | 6 ketukan |
| **D. NFC** | semua merek | 1 tag NFC per batch | 1 ketukan |

---

## 0. Prasyarat yang berlaku untuk semua metode

### 0.1 Guard harus terdaftar sebagai DPC resmi

Enrollment Android hanya bisa memasang DPC yang dikenali oleh sistem. Untuk DPC
 buatan sendiri, jalurnya:

1. Minta akses **Android Device Provisioning Partner** dari ZTE (atau Samsung
   untuk KME).
2. Daftarkan paket Guard ke Device Provisioning Partner API pada
   `androiddeviceprovisioning.googleapis.com`, dengan `dpcExtras` yang menunjuk
   ke `GUARD_DPC_COMPONENT` dan sidik jari sertifikat signing.
3. Catat **SHA-1 (base64) dari sertifikat signing Guard**. Nilai wajib benar;
   kalau tidak, device menolak enrolment dengan pesan
   `Failed to install DPC`.

Hitung sidik jari sertifikat di PowerShell:

```powershell
keytool -list -v -keystore guard.jks -alias guard | Select-String SHA1
# "SHA1: AB:CD:EF:.." -> buang titik, lalu:
$hex = (keytool -list -v -keystore guard.jks -alias guard | Select-String SHA1) -replace '.*: ','' -replace '[^A-F0-9]',''
[Convert]::ToBase64String([byte[]]($hex -split '(..)' | Where-Object { $_ } | ForEach-Object { [Convert]::ToByte($_,16) }))
```

Isi hasilnya di `.env`:

```env
GUARD_DPC_COMPONENT=id.acefleet.guard/id.acefleet.guard.GuardDeviceAdminReceiver
GUARD_DPC_SIGNATURE_SHA1=<base64 dari langkah di atas>
```

> `GUARD_DPC_COMPONENT` **harus persis** sama dengan receiver yang terdaftar di
> `AndroidManifest.xml`. Selisih satu karakter membuat provisioning gagal tanpa
> pesan yang jelas.

### 0.2 Tiga fakta yang sering disalahkaprah

1. **Android Management API (AMAPI) tidak punya endpoint
   `enterprises.androidDeviceManagement`.** Endpoint itu tidak ada (mengembalikan
   404). Konsep "AMAPI menjadi jalur perintah ke DPC" keliru.
2. **AMAPI dipakai untuk enrolment dan provisioning**, bukan sebagai jalur
   perintah pada arsitektur ini. Perintah tetap lewat server broker + bot.
3. **Satu-satunya DPC yang kompatibel penuh dengan AMAPI adalah Android Device
   Policy.** Guard mengambil alih device sebagai Device Owner; kalau nanti
   dipakai bersama MDM, set `dpcProxyMode: PROXY_ALL` agar API yang tidak
   diimplementasikan diteruskan.

### 0.3 Kenapa tetap ada kode pairing manual

`dpcExtras` adalah kanal resmi menyuntikkan konfigurasi ke DPC saat enrolment,
tetapi tidak semua OEM membacanya, dan isinya tidak bisa dipakai sebagai
sesi karena hanya dikirim sekali. Karena itu **kode pairing 8 karakter** dipakai
sebagai sumber kebenaran enrolment: bisa di-audit, bisa dicabut, dan tidak
pernah tersimpan utuh di perangkat mana pun selain sekali saat pairing.

---

## A. ZTE Zero-Touch (jalur utama)

### A.1 Pendaftaran

1. Buka <https://partner.android.com/zerotouch> lalu minta akses **reseller
   ZTE** dari ZZTE.
2. ZTE memberi: **Reseller Portal URL**, **Reseller ID**, dan **API key**
   Device Provisioning Partner.
3. Buat enterprise di Android Management API:

```bash
curl -X POST https://androidmanagement.googleapis.com/v1/enterprises \
  -H "Authorization: Bearer $GOOGLE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enterpriseName": "Rental Nusantara"}'
```

Catat `enterpriseName`; itu `enterpriseId` untuk semua panggilan berikutnya.

### A.2 Policy default

Policy ini yang dipasang ke setiap unit hasil Zero-Touch. Isi dengan
`policy_guard.json`:

```json
{
  "deviceOwnerConfiguration": {
    "admin": "id.acefleet.guard/id.acefleet.guard.GuardDeviceAdminReceiver",
    "autoStartUpMode": "ENCRYPTED_STORAGE_REQUIRED",
    "minimumApiLevel": 29,
    "maximumApiLevel": 36,
    "factoryResetDisabled": true,
    "cameraDisabled": false,
    "statusBarDisabled": false,
    "keyguardDisabled": false,
    "maximumFailedPasswordsForWipe": 30,
    "removeUserDisabled": true,
    "dpcProxyMode": "PROXY_ALL",
    "passwordPolicies": {
      "passwordHistoryLength": 0,
      "passwordExpirationTimeout": "0s",
      "passwordLength": [6, 16]
    },
    "dpcExtras": {
      "fleetguard": {
        "wsUrl": "wss://fleet.example.my.id/ws/v1/device",
        "pairUrl": "https://fleet.example.my.id/api/enroll/pair",
        "watchdogMs": 500
      }
    },
    "runtimePermissionGrantRules": [
      { "permission": "android.permission.CAMERA",                 "grantState": "GRANTED" },
      { "permission": "android.permission.ACCESS_FINE_LOCATION",   "grantState": "GRANTED" },
      { "permission": "android.permission.ACCESS_COARSE_LOCATION", "grantState": "GRANTED" },
      { "permission": "android.permission.POST_NOTIFICATIONS",     "grantState": "GRANTED" }
    ]
  },
  "applications": [
    {
      "packageName": "id.acefleet.guard",
      "installType": "FORCE_INSTALLED",
      "versionCode": 1,
      "installState": "INSTALLED"
    }
  ]
}
```

Buat / perbarui policy:

```bash
curl -X PATCH \
  "https://androidmanagement.googleapis.com/v1/enterprises/$ENTERPRISE_ID/policies/policy_guard?updateMask=deviceOwnerConfiguration,applications" \
  -H "Authorization: Bearer $GOOGLE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d @policy_guard.json
```

> Policy ini hanya untuk **bootstrap**. Kebijakan runtime (lock, suspend,
> radius, kamera) ditegakkan `PolicyEngine` di Guard lewat
> `DevicePolicyManager`, karena itu yang bisa berubah detik-ke-detik dari bot.

### A.3 Enrollment token

```bash
curl -X POST \
  "https://androidmanagement.googleapis.com/v1/enterprises/$ENTERPRISE_ID/enrollmentTokens" \
  -H "Authorization: Bearer $GOOGLE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tokenId": "batch-toko-a-2026-03",
    "tokenValue": "TOKEN_ENROLLMENT_ANDA",
    "deviceType": "ANDROID_ENTERPRISE",
    "qrCodeData": "https://fleet.example.my.id/enroll?b=BATCH-TOKO-A"
  }'
```

Simpan `tokenValue` sebagai `AMAPI_ENROLLMENT_TOKEN` di `.env`.

### A.4 Registrasi batch ke ZTE (Device Provisioning Partner API)

Semua panggilan memakai endpoint
`https://androiddeviceprovisioning.googleapis.com/v1/...` dengan header
`x-api-key: $ZTE_API_KEY`.

**a. Daftarkan konfigurasi Guard** (sekali saja per versi aplikasi)

```bash
curl -X POST \
  "https://androiddeviceprovisioning.googleapis.com/v1/partners/$ZTE_PARTNER_ID/customers/$ZTE_CUSTOMER_ID/configurations" \
  -H "x-api-key: $ZTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "guard-enrollment-v1",
    "deviceConfig": {
      "deviceOwnerConfiguration": {
        "admin": "id.acefleet.guard/id.acefleet.guard.GuardDeviceAdminReceiver",
        "signatureSha1": "'$GUARD_DPC_SIGNATURE_SHA1'",
        "dpcExtras": {
          "fleetguard": {
            "wsUrl": "wss://fleet.example.my.id/ws/v1/device",
            "pairUrl": "https://fleet.example.my.id/api/enroll/pair"
          }
        }
      }
    }
  }'
```

**b. Daftarkan batch**

```bash
curl -X POST \
  "https://androiddeviceprovisioning.googleapis.com/v1/partners/$ZTE_PARTNER_ID/customers/$ZTE_CUSTOMER_ID/batches" \
  -H "x-api-key: $ZTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "batchName": "TOKO-A-2026-03",
    "enrollmentToken": "'$AMAPI_ENROLLMENT_TOKEN'",
    "policyName": "enterprises/'$ENTERPRISE_ID'/policies/policy_guard",
    "configurationName": "guard-enrollment-v1",
    "expiresAt": "2026-06-30T23:59:59Z",
    "notes": "40 unit toko A"
  }'
```

**c. Dafarkan perangkat**

```bash
curl -X POST \
  "https://androiddeviceprovisioning.googleapis.com/v1/partners/$ZTE_PARTNER_ID/devices" \
  -H "x-api-key: $ZTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceIdentifiers": [
      { "deviceImei": "860000000000001" },
      { "deviceImei": "860000000000002" }
    ],
    "enrollmentToken": "'$AMAPI_ENROLLMENT_TOKEN'",
    "policyName": "enterprises/'$ENTERPRISE_ID'/policies/policy_guard"
  }'
```

Kalau Anda memakai **Reseller Portal ZTE** (bukan API langsung), alurnya
setara lewat UI: **Batch Management → Add Batch → pilih policy → Unduh QR
batch → cetak dan tempel di kardus**.

**d. Pantau progres**

```bash
curl "https://androiddeviceprovisioning.googleapis.com/v1/partners/$ZTE_PARTNER_ID/customers/$ZTE_CUSTOMER_ID/batches/$BATCH_ID" \
  -H "x-api-key: $ZTE_API_KEY"
```

Status per unit bergerak dari `AWAITING_ACTIVATION` → `DEVICE_ACTIVATED`.
Status `INSTALLED_BUT_DISABLED` hampir selalu berarti sidik jari sertifikat
tidak cocok.

### A.5 Yang terjadi di perangkat

1. Unit dinyalakan, muncul layar awal penyiapan.
2. Pilih **Scan QR code**, arahkan ke QR batch.
3. ZTE memverifikasi batch, lalu mengunduh Guard (`FORCE_INSTALLED`).
4. Guard memasang dirinya sebagai **Device Owner** → `DISALLOW_FACTORY_RESET`
   aktif, Guard tidak bisa di-uninstall dari UI.
5. Guard membuka layar pairing; operator mengetik **kode pairing** 8 karakter
   dari `devices.csv` (atau otomatis kalau OEM membaca `dpcExtras`).

---

## B. Samsung KME

Portal: <https://partner.samsung.com/samsung-kme>

1. Minta akses KME partner.
2. Buat **DPC configuration** di portal KME: isi `admin` dengan Guard DPC
   component dan SHA-1 sertifikat yang sama seperti bagian A.
3. Buat **Push configuration**, lampirkan AMAPI enrollment token yang sama.
4. Unit Samsung yang baru difactory reset akan menerima Guard otomatis saat
   pertama kali menyala dan tersambung Wi-Fi.

KME memakai bucket partner yang berbeda dari ZTE, jadi jalurnya mirip tapi
terpisah.

---

## C. QR 6-tap (semua merek)

### C.1 Buat batch dan kode pairing

```powershell
cd fleet-guard\server
node scripts/onboard.mjs --count 40 --prefix HP --nama "TOKO-A" --out out\TOKO-A
```

Hasil di `out\TOKO-A\`:

| File | Isi |
|---|---|
| `devices.csv` | `device_id`, `nama_device`, `pair_code`, `status` |
| `enroll-qr.png` | QR enrolment untuk ZTE / AMAPI |
| `enroll-qr.txt` | payload QR dalam teks |
| `enroll-ndef.txt` | payload NDEF untuk ditulis ke tag NFC |

Kode pairing **sekali pakai** (disimpan sebagai `pair_code_hash`), jadi tidak
bisa dipakai ulang untuk device lain.

### C.2 Prosedur di perangkat

1. **Settings → About phone → Build number**, ketuk **7 kali** untuk membuka
   Developer options.
2. Kembali ke **About phone**, ketuk **Build number** sekali lagi sampai
   muncul “You are now a developer”.
3. **Settings → System → Advanced → Developer options**.
4. Cari **Device owner provisioning**, aktifkan **Allow provisioning**.
5. Masuk ke menu provisioning, scan QR, ketuk **6 kali** untuk mengaktifkan
   mode provisioning.
6. Scan **QR enrolment AMAPI** (`enroll-qr.png`) → Guard terpasang sebagai
   Device Owner.
7. Buka Guard, masukkan **kode pairing** dari `devices.csv`.

> Android 12+ menyembunyikan sebagian menu ini. Alternatif lewat ADB:
> `adb shell settings put global development_settings_enabled 1` lalu
> `adb shell am start -a android.app.action.PROVISIONING_DEVICE_ADMIN`.

### C.3 Labels untuk jaringan

Layout label yang dipakai di operasional:

```
┌─────────────────────────────────────┐
│  HP-001  TOKO A                     │   ← nama device (dipakai bot)
│  [QR enrolment]      [kode 8 karakter] │
└─────────────────────────────────────┘
```

Kode 8 karakter dicetak di label fisik supaya reset di lapangan bisa
di-pairing ulang tanpa PC.

---

## D. NFC (paling cepat kalau punya 1 tag per batch)

1. Tulis `enroll-ndef.txt` ke tag NFC NTAG21x. Payload **cukup URL**:
   `https://fleet.example.my.id/enroll?b=TOKO-A`
2. Ketuk tag ke reader NFC; Android membuka URL di browser.
3. Guard terpasang dari enrolment AMAPI, lalu menampilkan layar pairing.
4. Operator cukup satu ketukan NFC per unit — tidak perlu scan barcode satu
   per satu.

Alternatif lebih cepat lagi: cetak **kode pairing** sebagai QR di label, lalu
cukup tap tag NFC untuk membuka Guard dan scan kode di layar.

---

## Checklist sebelum onboarding 300 unit

- [ ] SHA-1 sertifikat signing Guard sudah didaftarkan ke partner API dan sama
      persis dengan build APK produksi.
- [ ] `GUARD_DPC_COMPONENT` di `.env` cocok dengan `AndroidManifest.xml`.
- [ ] `PUBLIC_BASE_URL` memakai `https://` dan **sudah terjangkau dari luar**
      (lihat [04-eksposur.md](04-eksposur.md)).
- [ ] Certificate pinning di `network_security_config.xml` sudah diisi untuk
      build produksi.
- [ ] Policy AMAPI meng-`FORCE_INSTALLED` Guard dengan `factoryResetDisabled: true`.
- [ ] Enrollment token berumur pendek (misal 30 hari) dan tercatat di tabel
      `enrollment_batches`.
- [ ] Satu unit uji sudah di-burn: factory reset 3×, uninstall 3×, mode OFF.
- [ ] `node scripts/onboard.mjs` sudah dijalankan dan `devices.csv` disimpan
      di tempat aman (itu bahan(pairing) semua unit).

---

## Troubleshooting

| Gejala | Penyebab | Perbaikan |
|---|---|---|
| `Failed to install DPC` | SHA-1 sertifikat tidak cocok | Hitung ulang, buat configuration baru |
| DPC terpasang tapi bukan Device Owner | Masih ada profil / MDM lama | `adb shell dpm list-owners`, hapus profil lama dulu |
| Ada di portal tapi Guard tidak muncul | Batch belum `ACTIVATED` | Tunggu status batch, atau distribute ulang policy |
| Pairing otomatis tidak terjadi | `dpcExtras` tidak dibaca OEM | Ketik kode pairing manual dari `devices.csv` |
| Penyewa masih bisa factory reset | Device owner belum aktif | Cek `node scripts/admin.mjs device <nama>`, pastikan `policy_state` terisi |
| Unit keluar dari batch setelah reset | FRP aktif, batch sudah expired | Enrollment token baru + paste ulang QR batch |
| Bootloop setelah reset | Custom ROM / image rusak | Flash stock ROM; FRP tetap aktif sehingga unit masih tertaut |