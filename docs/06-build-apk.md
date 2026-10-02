# 06 — Build APK Guard

Status jujur: **kedua APK sudah berhasil dikompilasi dan ditandatangani.**
Build hijau, diverifikasi dengan `apksigner` dan `aapt2`.

| Artefak | Package | Ukuran | Signing | Status |
|---|---|---|---|---|
| `dist/guard-1.0.0-release.apk` | `id.acefleet.guard` | 1.16 MB | `CN=Fleet Guard` (R8 shrunk) | v2 scheme |
| `dist/guard-1.0.0-debug.apk` | `id.acefleet.guard.debug` | 8.24 MB | `CN=Android Debug` | v2 scheme |

Keduanya berbeda package ID, jadi **boleh dipasang berdampingan** - penting
karena urutan wajibnya adalah uninstall debug dulu, baru pasang release.

Sidik jari sertifikat release (isi `GUARD_DPC_SIGNATURE_SHA1`):

```
01:C7:38:6E:42:A0:B2:8A:27:B2:7E:CB:6C:2C:A8:0A:13:5D:FB:95
```

---

## 1. Yang sudah terpasang di mesin ini (sudah dicek)

| Komponen | Status | Lokasi |
|---|---|---|
| JDK / JBR 25.0.3 | ✅ ada | `C:\Program Files\Android\Android Studio\jbr` |
| Android Studio | ✅ ada | `C:\Program Files\Android\Android Studio` |
| Android SDK platform | ⚠️ hanya `android-37.0` | `%LOCALAPPDATA%\Android\Sdk\platforms` |
| Build-tools | ✅ `36.0.0` | `%LOCALAPPDATA%\Android\Sdk\build-tools` |
| `platform-tools` (adb) | ❌ folder ada tapi **kosong** | — |
| `cmdline-tools` / sdkmanager | ❌ tidak ada | — |
| Gradle distribution | ✅ **sudah dipasang** (lihat §1b) | `~\.gradle-dist\gradle-9.8.0` |
| SDK platform 36 | ✅ **sudah dipasang** (lihat §1b) | `%LOCALAPPDATA%\Android\Sdk\platforms\android-36` |

Konsekuensi: `gradlew` dan `gradle-wrapper.jar` tetap tidak ada (keduanya
biner), **tapi tidak lagi dibutuhkan** — build bisa lewat CLI memakai Gradle
yang sudah diunduh.

### 1b. Apa yang di-bootstrap manual

JDK 25 sudah ada, tapi dua hal tidak bisa datang dari Android Studio bila
`cmdline-tools` tidak terpasang, jadi keduanya diunduh langsung:

| Yang diunduh | Dari | Ukuran |
|---|---|---|
| SDK Platform 36 | `dl.google.com/android/repository/platform-36_r02.zip` | 63 MB |
| Gradle 9.5.0 | `services.gradle.org/distributions/gradle-9.5.0-bin.zip` | 140 MB |

Letak terpasang:

```
C:\Users\ACE COMPUTER\AppData\Local\Android\Sdk\platforms\android-36\android.jar
C:\Users\ACE COMPUTER\.gradle-dist\gradle-9.5.0\bin\gradle.bat
```

Scriptnya: `android/tools/bootstrap-toolchain.ps1` (idempoten, meng-skip yang
sudah ada). Jalankan ulang kapan saja untuk memastikan toolchain utuh.

### Kenapa Gradle 9.5.0 dan bukan yang terbaru

Percobaan pertama memakai Gradle **9.8.0** (versi current) dan **gagal**:

```
> Plugin 'com.android.internal.application' relies on
  'org.gradle.api.problems.internal.InternalProblems', a Gradle internal API
  that was removed in Gradle 9.6.0.
```

Jadi 9.5.0 adalah batas atas yang masih kompatibel dengan AGP 8.13. Kalau
AGP nanti diperbarui ke versi yang sudah lepas dari internal API, Gradle bisa
naik lagi.

### Build lewat CLI (tanpa Android Studio)

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
cd "C:\Users\ACE COMPUTER\Documents\lacak lah\fleet-guard\android"
Copy-Item app\build\outputs\apk\debug\app-debug.apk     ..\dist\guard-1.0.0-debug.apk
Copy-Item app\build\outputs\apk\release\app-release.apk ..\dist\guard-1.0.0-release.apk
```

Hasil build ada di dua tempat:

- `android/app/build/outputs/apk/debug/app-debug.apk`
- `android/app/build/outputs/apk/release/app-release.apk`
- `dist/guard-1.0.0-debug.apk` dan `dist/guard-1.0.0-release.apk` (salinan)

Untuk release, tambahkan argumen keystore (lihat bagian 5):

```
gradle.bat assembleRelease --console=plain -PfleetStoreFile=<path.jks> -PfleetStorePassword=<pw> -PfleetKeyAlias=guard -PfleetKeyPassword=<pw>
```

Catatan: task `lintVitalAnalyzeRelease` mengunduh `lint-gradle` saat pertama
kali jalan, jadi build release tidak bisa memakai `--offline` pada eksekusi
pertama.

`JAVA_HOME` **wajib** diarahkan ke JBR Studio - itu satu-satunya JDK di mesin
ini (JDK 25.0.3). Tanpa itu Gradle tidak jalan sama sekali.

---

## 2. Versi toolchain yang dipilih, dan kenapa

| Komponen | Versi | Alasan |
|---|---|---|
| Gradle | `9.5.0` | Hanya rilis 9.x yang jalan di **JDK 25** (satu-satunya JDK di sini) **dan** masih menyediakan internal API yang dipakai AGP. 9.6+ sudah dihapus. |
| AGP | `8.13.2` | Versi AGP terbaru. Mendukung `compileSdk = 36` dan Gradle 9. |
| Kotlin | `2.2.20` | Compiler-nya JDK-25-safe (Kotlin 2.0.x belum). |
| compileSdk / targetSdk | `36` | Android 16, selaras dengan build-tools 36.0.0 yang sudah ada. |
| minSdk | `29` | Android 10. |

Versi ini sudah ditulis ke `android/build.gradle.kts` dan
`android/gradle/wrapper/gradle-wrapper.properties`.

### 2b. Realitas API 36 yang ditemukan saat compile

Hampir 40 error Kotlin pertama **bukan** bug logika, tapi asumsi API yang
salah. Semua diverifikasi dengan `javap` terhadap `android.jar` API 36 -
jangan menebak, `javap` sumber kebenarannya:

```powershell
$jar="$env:LOCALAPPDATA\Android\Sdk\platforms\android-36\android.jar"
javap -cp $jar android.app.admin.DevicePolicyManager | Select-String "resetPassword|LockTask"
javap -cp $jar android.os.UserManager | Select-String "DISALLOW_"
```

Temuan yang mengubah implementasi:

| Yang diasumsikan | Kenyataan API 36 | Yang dilakukan |
|---|---|---|
| `DevicePolicyManager.DISALLOW_RESET_PIN` | Tidak ada di mana pun | Dihapus dari kode |
| `DevicePolicyManager.DISALLOW_APPLY_RESTRICTION` | Tidak ada | Dihapus |
| `UserManager.DISALLOW_ADD_USERS` |Namanya `DISALLOW_ADD_USER` | Diganti |
| `UserManager.DISALLOW_INSTALL_UNKNOWN_APPS` |Namanya `DISALLOW_INSTALL_UNKNOWN_SOURCES` | Diganti |
| `setUninstallBlocked(admin, String[], bool)` | Terima **satu** `String` | `setUninstallBlocked(admin, packageName, true)` |
| `resetPassword(admin, pin)` | Hanya ada `resetPassword(String, int)` yang **menghapus** kredensial | Alur PIN ditulis ulang, lihat §2c |
| `isCameraDisabled(admin)` | Hanya ada `getCameraDisabled(admin)` | Diganti |
| `isUserRestriction(...)` | Tidak ada | `getUserRestrictions(admin).getBoolean(key)` |
| `setBackupAgent` | Tidak ada | Dihapus, dicatat di log |
| `ActivityManager.startLockTask/stopLockTask` | Hilang dari stub 36 | **Refleksi**, lihat §2c |
| `PowerManager.setIgnoreBatteryOptimizations` | Hanya `isIgnoring...` yang ada | Intent `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` |
| `setPermissionGrantState` 3 param | Jadi **4 param** (`+packageName`) | Ditambah argumennya |
| `AudioManager.setStreamVolume(..., 1.0f, ...)` | Indeks itu `Int`, bukan `Float` | `7` |
| `DevicePolicyManager.reboot(boolean)` | Actually `reboot(ComponentName)` | `reboot(admin)` |
| `ImageCapture.takePicture(cb, exec)` | Urutannya dibalik | `takePicture(exec, cb)` |
| `WindowManager.isKeyguardLocked` | Itu milik `KeyguardManager` | Diganti |
| `android.R.drawable.ic_menu_lock_lock` | Tidak ada | Drawable sendiri `ic_guard_lock.xml` |
| `EditText.hintTextColor` | Setter tanpa getter yang cocok | `setHintTextColor(...)` |

**Pelajaran penting:** `android/tools/check-sources.mjs` (static checker Kotlin
buatan sendiri) **lolos 100%** padahal ada ~40 error compile. Checker itu tidak
memeriksa import maupun signature API. Uji build Gradle sekarang satu-satunya
sumber kebenaran - jangan percaya static checker untuk kode Android.

### 2c. Dua keputusan desain yang berubah karena API 36

**1. Lock/unlock tidak memakai PIN lagi.**
`resetPassword(ComponentName, String)` sudah hilang, jadi DPC tidak bisa lagi
memilih PIN layar kunci. Satu-satunya overload yang tersisa,
`resetPassword(String adminPackage, int flags)`, justru **menghapus**
kredensial layar kunci.

Untuk unit rental ini justru lebih ketat: tidak ada PIN yang bisa ditebak
penyewa dan tidak ada PIN yang bisa diubah diam-diam. `/unlock` sekarang
memakai `setKeyguardDisabled(admin, true)`, dan `/set_pin` menerbitkan "kode
keeper" sebagai referensi operator - itu **bukan** PIN layar kunci, dan
docs/PROTOCOL perlu dibaca sekali agar tidak disalahartikan.

**2. Lock task dipanggil lewat refleksi.**
`DevicePolicyManager.startLockTask(ComponentName, PendingIntent)` dan
`ActivityManager.stopLockTask()` masih ada di Android 10-15 (semua unit Anda),
tapi keduanya hilang dari stub `android.jar` API 36 sehingga tidak bisa
dipanggil langsung di kode yang dikompilasi terhadap 36.

Refleksi dipakai supaya satu APK bisa dikompilasi ke API 36 sekaligus tetap
menjalankan lock task di perangkat Android 10-15. Di Android 16 keduanya
benar-benar hilang dan lock task dilewati diam-diam; lock tetap ditegakkan
lewat `lockNow()` + `setCameraDisabled()` + `setPackagesSuspended()` +
`KioskActivity`. Ini batas platform, bukan sesuatu yang bisa diOLA aplikasi.

### Rantai fallback (pakai hanya kalau build error versi)

1. **Error "internal API ... was removed in Gradle 9.6.0"**
   → turunkan Gradle ke `9.5.0` (atau lebih rendah). Ini yang terjadi saat
   mencoba 9.8.0.
2. **Error "Unsupported Java. Your build is currently configured to use Java 25"**
   → turunkan JDK, bukan naikkan Gradle.
   Android Studio: `File > Settings > Build, Execution, Deployment > Build Tools > Gradle JDK` → pilih **17**.
   Lalu turunkan `android/build.gradle.kts` ke `AGP 8.7.3` / `Kotlin 2.0.21`, dan `distributionUrl` ke `gradle-8.10.2-bin.zip`.
3. **Error AGP "Minimum supported Gradle version is X"**
   → naikkan `distributionUrl` ke `X` atau lebih baru.
4. **Error "compileSdk 36 not installed"**
   → jalankan `android\tools\bootstrap-toolchain.ps1`, atau set
   `compileSdk = 35` di `app/build.gradle.kts`.

---

## 3. Langkah build (Android Studio)

1. Buka Android Studio → **File > Open** → pilih folder
   `C:\Users\ACE COMPUTER\Documents\lacak lah\fleet-guard\android`
   (pilih folder `android`, **bukan** `fleet-guard`).
2. Tunggu sync. Studio akan:
   - membuat `gradlew` + `gradle-wrapper.jar`,
   - mengunduh Gradle 9.3.0,
   - mengunduh AGP 8.13.2 + Kotlin 2.2.20,
   - mengunduh SDK platform 36.
   Total ± 1–2 GB dan bisa makan 10–20 menit di koneksi biasa.
3. Kalau muncul dialog **"Install missing SDK component(s)"** → klik Install.
4. **Build > Build Bundle(s) / APK(s) > Build APK(s)**
   Hasil: `android/app/build/outputs/apk/debug/app-debug.apk`

`local.properties` sudah diisi otomatis menunjuk SDK di `%LOCALAPPDATA%`, jadi
tidak perlu apa-apa.

---

## 4. Smoke-test APK hasil debug

Build **debug** sudah cukup untuk menguji pairing (device owner BELUM bisa
diuji dengan debug signing — lihat §6).

1. Server jalan: `node src/index.js` di `fleet-guard/server`.
2. Generate kode pairing:
   ```
   node scripts/onboard.mjs --nama "HP-001-TOKO-A"
   ```
   Output berisi `device_id` dan **pair code** 8 karakter.
3. Install APK ke HP uji (ADB belum ada - pasang lewat `platform-tools`, atau
   kirim file APK dan buka di HP dengan "install unknown apps" diaktifkan).
4. Buka app -> masukkan pair code -> ketik nama -> app mengontak server, ambil
   `device_id` + `token`.
5. Cek di dashboard `http://localhost:8787` -> device harus `online`.

### Nama device tidak boleh mengandung spasi

`onboard.mjs` sekarang menolak nama ber-spasi. Alasannya bukan sekadar
kenyamanan: bot Telegram mem-parse `/cmd <nama> <argumen>` sebagai token
terpisah. Nama seperti `HP-001 Redmi 9` akan terpotong, setiap perintah jadi
ambigu, dan bot akan menampilkan kandidat alih-alih menjalankan - persis
kondisi yang harus dihindari karena bisa salah kirim ke unit yang keliru.

Gunakan tanda hubung: `HP-050-TOKO-B-Redmi9`.

Bug ini ditemukan `bottest.mjs`: 5 dari 23 uji gagal karena device uji
bernama `[UJI] HP-001`. Setelah nama dinormalkan, 23/23 lulus.

---

## 5. Build produksi + keystore

Build pertama **tidak butuh keystore** — `app/build.gradle.kts` sekarang
mendeteksi `-PfleetStoreFile`: kalau file tidak ada, release build jatuh ke
debug signing dan mencetak peringatan di konsol. Jadi `Build APK(s)` selalu
berhasil.

Setelah smoke-test lulus, buat keystore produksi:

```
keytool -genkeypair -v \
  -keystore C:\secure\guard-release.jks \
  -alias guard -keyalg RSA -keysize 4096 -validity 10000
```

Simpan file itu **di luar folder project** (dan di luar PC ini kalau bisa).
Keystore sekarang sudah dibuat di `android/keystore/guard-release.jks`, tapi
folder itu ada di `.gitignore` - **tidak pernah** di-commit. Kalau bocor,
rotasi semua token device dan password bot.

Password yang dipakai saat membuat keystore repo ini:
`storepass = keypass = [REDACTED-KEYSTORE-PASSWORD]`, alias `guard`.

Baris untuk build release:

```
gradle.bat assembleRelease --console=plain -PfleetStoreFile=C:/secure/guard-release.jks -PfleetStorePassword=... -PfleetKeyAlias=guard -PfleetKeyPassword=...
```

Bonus: `-PfleetWsUrl=wss://host-anda/ws/v1/device` dan
`-PfleetPairUrl=https://host-anda/api/enroll/pair` menyuntik alamat server
langsung ke dalam APK, jadi tidak perlu ketik URL di setiap unit.

### Untuk unit yang sudah ter-provisioning

Generate QR Device Provisioning Partner dan set `dpcExtras` berisi
`deviceAdminComponent`, `serverUrl`, `pairUrl`, `protocol`, `wsInsecure=0`.
Detail dan template XML ada di `docs/03-zero-touch.md`.

---

## 6. Kenapa debug APK tidak bisa jadi Device Owner

Android hanya mengizinkan **aplik yang ditandatangani dengan sertifikat
release** (atau di-debug lewat `adb shell dpm set-device-owner`) yang menjadi
Device Owner, dan **DPC yang sudah jadi Device Owner tidak boleh di-uninstall
atau di-upgrade dengan sertifikat berbeda**.

Jadi urutannya wajib:

1. Smoke-test dengan APK **debug** → pairing, lokasi, kamera, bot.
2. Setelah yakin, build APK **release** dengan keystore di atas.
3. Uninstall APK debug, pasang release. ** Device Owner tidak bisa diubah tanpa factory reset.**
4. Baru lakukan Zero-Touch provisioning dari ZTE memakai sertifikat release.

Kalau production build di-shrink (R8) bermasalah, `app/proguard-rules.pro`
saat ini memakai `-keep class id.acefleet.guard.** { *; }` — meaning seluruh
kelas Guard tidak di-minify. Itu disengaja untuk DPC: aman tapi APK lebih
besar. Persempit hanya setelah semua fiturnya teruji di lapangan.

---

## 7. Yang harus diinstal sebelum provisioning massal

`platform-tools` kosong, jadi **`adb` belum ada**. Untuk burn-test
(`docs/05-android-policy.md` §9) Anda butuh adb. Pasang lewat
`platform-tools` di SDK Manager (Android Studio → Tools > SDK Manager →
SDK Tools → centang **Android SDK Platform-Tools**), atau unduh
`platform-tools-latest-windows.zip` dan ekstrak ke
`%LOCALAPPDATA%\Android\Sdk\platform-tools`.

---

## 8. Checklist pairing unit pertama

Sudah selesai:

- [x] `assembleDebug` sukses -> `dist/guard-1.0.0-debug.apk` (8.24 MB)
- [x] `assembleRelease` sukses -> `dist/guard-1.0.0-release.apk` (1.16 MB)
- [x] Kedua APK diverifikasi `apksigner` (v2) dan `aapt2` (device-admin ada)
- [x] `selftest.mjs` 15/15 lulus, `bottest.mjs` 23/23 lulus
- [x] Server jalan, dashboard tersaji (HTTP 200, 9.5 KB)
- [x] DB bersih: `device: 0 (online 0, disewa 0, hilang 0)` - nol data simulasi

Belum bisa diselesaikan tanpa HP nyata:

- [ ] Pasang APK debug ke 1 unit -> pairing, `device_id` + `token` masuk
- [ ] Dashboard menampilkan device `online` (device sungguhan)
- [ ] `/status` dan `/lokasi` membalas di Telegram
- [ ] `/kamera_depan` mengembalikan foto yang bisa dibuka
- [ ] Wi-Fi dimatikan 10 menit -> device jadi `offline`, lalu reconnect
- [ ] Paksa reboot -> Guard aktif lagi tanpa sentuhan
- [ ] Uninstall debug, pasang release, jadikan Device Owner
- [ ] Provisioning 1 unit via Zero-Touch ZTE
- [ ] `GUARD_DPC_SIGNATURE_SHA1` diisi di `.env` (nilainya ada di bagian atas)