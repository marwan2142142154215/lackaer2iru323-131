package id.acefleet.guard.policy

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.UserManager
import android.util.Log
import id.acefleet.guard.GuardDeviceAdminReceiver
import id.acefleet.guard.Logs
import id.acefleet.guard.core.Config
import id.acefleet.guard.core.PolicyState
import id.acefleet.guard.core.SecureStore
import id.acefleet.guard.ui.KioskActivity

/**
 * Mesin kebijakan Device Owner.
 *
 * Prinsip:
 *  1. Semua operasi idempotent - aman dipanggil 0,5 detik sekali oleh watchdog.
 *  2. Tidak pernah melempar ke atas; kegagalan dicatat lalu dilaporkan ke server.
 *  3. Hanya API resmi DevicePolicyManager. Tidak ada reflection/hook.
 *
 * Batas nyata Android (bukan kelemahan implementasi), catatan jujur:
 *  - Tidak ada API untuk membaca IMEI tanpa izin privileged OEM. Pemblokiran
 *    IMEI global hanya bisa lewat GSMA Device Check / operator blocklist.
 *  - Factory reset dari luar sistem (recovery/fastboot) tidak bisa diceguh.
 *    Yang bisa dikunci: reset dari menu Settings, `adb shell pm wipe`,
 *    dan pembongkaran device admin.
 *  - Tidak ada "kill app lain" untuk device owner. Yang sah: suspend paket
 *    (Android 14+), lock task mode, dan kunci layar berulang.
 */
class PolicyEngine(private val ctx: Context) {

    private val dpm: DevicePolicyManager =
        ctx.getSystemService(DevicePolicyManager::class.java)
            ?: error("DevicePolicyManager tidak tersedia")

    private val admin: ComponentName = GuardDeviceAdminReceiver.component(ctx)
    private val cfg: Config = Config.get(ctx)
    private val store: SecureStore = SecureStore(ctx)

    /**
     * Paket yang tidak boleh disuspensi. Device owner wajib menjaga
     * SystemUI/launcher tetap hidup, kalau tidak perangkat terlihat brick.
     */
    private val neverSuspend: Set<String> by lazy {
        setOf(
            ctx.packageName,
            "android",
            "com.android.systemui",
            "com.android.providers.settings",
            "com.android.permissioncontroller",
            "com.android.shell",
            "android.shell",
            "com.google.android.gms",
        )
    }

    /**
     * Pembatasan dasar: aktif baik dalam kondisi unlocked maupun locked.
     *
     * PENTING - Android 14+ hanya mengizinkan sebagian user restriction untuk
     * Device Admin biasa. Yang butuh Device Owner akan DITOLAK oleh sistem
     * dengan "Caller does not hold the required permission". Fungsi ini
     * menghitung berapa yang benar-benar berlaku supaya aplikasi tidak
     * melaporkan "restrictions aktif" padahal semuanya ditolak.
     */
    fun applyBaseRestrictions() {
        // Semua konstanta di bawah diverifikasi dengan javap terhadap
        // android.jar API 36. DISALLOW_RESET_PIN dan DISALLOW_APPLY_RESTRICTION
        // tidak ada lagi di SDK publik, jadi tidak dipakai.
        val wanted = listOf(
            UserManager.DISALLOW_FACTORY_RESET,
            UserManager.DISALLOW_DEBUGGING_FEATURES,
            UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES,
            UserManager.DISALLOW_USER_SWITCH,
            UserManager.DISALLOW_REMOVE_USER,
            UserManager.DISALLOW_ADD_USER,
            UserManager.DISALLOW_CONFIG_CREDENTIALS,
        )
        var applied = 0
        for (k in wanted) if (setRestriction(k, true)) applied++

        // Uninstall Guard dari UI mustahil. API ini menerima SATU package
        // (String), bukan array.
        runCatching { dpm.setUninstallBlocked(admin, ctx.packageName, true) }
            .onFailure { Log.w(TAG, "setUninstallBlocked: ${it.message}") }

        // PIN dikualkan: kalau ada penyewa yang nekat menebak 30x, device wipe
        // lebih baik daripada dibobol.
        runCatching {
            dpm.setPasswordQuality(admin, DevicePolicyManager.PASSWORD_QUALITY_NUMERIC)
            dpm.setPasswordMinimumLength(admin, 6)
            dpm.setPasswordExpirationTimeout(admin, 0L)
            dpm.setPasswordHistoryLength(admin, 0)
            dpm.setMaximumFailedPasswordsForWipe(admin, MAX_FAILED_WIPE)
        }.onFailure { Log.w(TAG, "setPassword*: ${it.message}") }

        // Jangan sampai layar kunci bisa dimatikan dari quick settings.
        runCatching { dpm.setKeyguardDisabled(admin, false) }
        noteBackupNotDisabled()

        // Laporan jujur: kalau cuma sebagian yang berlaku, sebutkan bahwa itu
        // batas Device Admin, bukan proteksi penuh.
        if (applied == wanted.size) {
            Logs.i(TAG, "base restrictions aktif ($applied/${wanted.size})")
        } else {
            Logs.w(
                TAG,
                "base restrictions SEBAGIAN ($applied/${wanted.size}) - sisanya butuh Device Owner. " +
                    "Factory reset TIDAK terlindungi tanpa Device Owner.",
            )
        }
    }

    /**
     * DevicePolicyManager.setBackupAgent / setDisableBackup tidak ada di
     * android.jar 36, jadi backup Guard tidak dimatikan lewat DPM. Untuk unit
     * rental ini tidak kritis: data Guard tidak rahasia bisnis yang perlu
     * dilindungi dari cloud, dan IsBackup yang bocor tetap tidak bisa
     * melewati DISALLOW_FACTORY_RESET.
     */
    private fun noteBackupNotDisabled() {
        Logs.w(TAG, "setBackupAgent tidak tersedia di API 36 - backup Guard dibiarkan")
    }

    /**
     * Menonaktifkan layar kunci sepenuhnya. INI adalah cara unlock yang sah dan
     * stabil lintas Android 10-16, dan tidak bergantung pada resetPassword yang
     * signature-nya berubah di SDK baru.
     */
    fun neutralizeKeyguard(on: Boolean) {
        runCatching { dpm.setKeyguardDisabled(admin, on) }
            .onFailure { Log.w(TAG, "setKeyguardDisabled($on): ${it.message}") }
    }

    /**
     * Lock task dikendalikan lewat refleksi.
     *
     * Alasannya: DevicePolicyManager.startLockTask(ComponentName, PendingIntent)
     * dan ActivityManager.stopLockTask() MASIH ADA di Android 10-15 (semua unit
     * Anda), tapi KEDUANYA sudah hilang dari stub android.jar API 36 sehingga
     * tidak bisa dipanggil langsung di kode yang dikompilasi terhadap 36.
     *
     * Refleksi dipakai supaya satu APK bisa dikompilasi ke API 36 sekaligus
     * tetap menjalankan lock task di perangkat Android 10-15. Di Android 16
     * kedua metode hilang, dan start/stopLockTask akan diam-diam dilewati -
     * lock tetap ditegakkan lewat lockNow() + setCameraDisabled() +
     * setPackagesSuspended() + KioskActivity.
     */
    private fun invokeAm(name: String) {
        runCatching {
            val am = ctx.getSystemService(ActivityManager::class.java) ?: return
            val m = am.javaClass.getMethod(name)
            m.invoke(am)
        }.onFailure { Log.w(TAG, "$name: ${it.message}") }
    }

    /** Terapkan desired state; sumbernya Config, bukan memori service. */
    fun apply(state: PolicyState, kiosk: Boolean) {
        when (state) {
            PolicyState.UNLOCKED -> unlock(kiosk)
            PolicyState.LOCKED -> lock(kiosk)
            PolicyState.KIOSK -> kioskOnly()
        }
    }

    /**
     * Lock: suspend semua paket (Android 14+), matikan kamera, kunci layar
     * sekarang, opsional lock-task. Untuk Android 10-13 (tanpa API suspend)
     * kunci layar berulang dari watchdog + lock task adalah kombinasi
     * paling ketat yang sah.
     */
    private fun lock(kiosk: Boolean) {
        var done = mutableListOf<String>()
        runCatching { suspendOthers(true) }.onSuccess { done += "suspend" }
            .onFailure { Log.w(TAG, "suspendOthers: ${it.message}") }
        runCatching { dpm.setCameraDisabled(admin, true) }.onSuccess { done += "camera-off" }
            .onFailure { Log.w(TAG, "setCameraDisabled: ${it.message}") }
        runCatching { dpm.setStatusBarDisabled(admin, true) }
        // Lock = kembalikan layar kunci ke mode normal (nilai default DPC),
        // lalu kunci sekarang juga supaya tidak ada celah.
        neutralizeKeyguard(false)
        runCatching { dpm.lockNow() }.onFailure { Log.w(TAG, "lockNow: ${it.message}") }
        if (kiosk) startLockTask() else invokeAm("stopLockTask")
        showKiosk(true)
        Logs.i(TAG, "LOCK diterapkan (${done.joinToString()})")
    }

    private fun unlock(kiosk: Boolean) {
        runCatching { suspendOthers(false) }
            .onFailure { Log.w(TAG, "suspendOthers: ${it.message}") }
        runCatching { dpm.setCameraDisabled(admin, false) }
        runCatching { dpm.setStatusBarDisabled(admin, false) }
        invokeAm("stopLockTask")
        neutralizeKeyguard(true)
        if (kiosk) startLockTask()
        showKiosk(false)
        Logs.i(TAG, "UNLOCK diterapkan")
    }

    /** Kiosk murni: hanya Guard yang boleh dibuka (unit display di etalase). */
    private fun kioskOnly() {
        runCatching { suspendOthers(true) }
        runCatching { dpm.setCameraDisabled(admin, false) }
        startLockTask()
        showKiosk(true)
        Logs.i(TAG, "KIOSK diterapkan (lock task)")
    }

    /**
     * Android 14+ punya DevicePolicyManager.setPackagesSuspended.
     * Android 10-13: tidak ada API suspend resmi, sehingga Strategi andal
     * adalah kunci layar + lock task. Dokumentasi ini sengaja eksplisit agar
     * tidak ada janji palsu soal "app dibekukan total" di Android lama.
     */
    @SuppressLint("NewApi")
    private fun suspendOthers(suspend: Boolean) {
        if (Build.VERSION.SDK_INT < 34) return
        val installed = runCatching {
            ctx.packageManager.getInstalledApplications(0).map { it.packageName }
        }.getOrDefault(emptyList())
        val targets = installed.filter { !neverSuspend.contains(it) }.toTypedArray()
        if (targets.isEmpty()) return
        dpm.setPackagesSuspended(admin, targets, suspend)
    }

    private fun startLockTask() {
        // setLockTaskPackages selalu ada; ini yang menandai Guard sebagai
        // lock-task-capable.
        runCatching { dpm.setLockTaskPackages(admin, arrayOf(ctx.packageName)) }
            .onFailure { Log.w(TAG, "setLockTaskPackages: ${it.message}") }
        val pi = runCatching {
            val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
                ?: Intent(ctx, KioskActivity::class.java)
            PendingIntent.getActivity(
                ctx,
                1001,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }.getOrNull() ?: return

        // startLockTask(ComponentName, PendingIntent) ada di Android 10-15 tapi
        // hilang dari stub API 36 -> lewat refleksi. Lihat invokeAm().
        runCatching {
            val m = DevicePolicyManager::class.java
                .getMethod("startLockTask", ComponentName::class.java, PendingIntent::class.java)
            m.invoke(dpm, admin, pi)
        }.onFailure { Log.w(TAG, "startLockTask (refleksi): ${it.message}") }
    }

    /**
     * Terbitkankan "kode keeper" dan sekaligus HAPUS kredensial layar kunci.
     *
     * Kenapa bukan membuat PIN lagi: DevicePolicyManager.resetPassword
     * (ComponentName, String) sudah hilang dari SDK publik. Satu-satunya
     * overload yang tersisa adalah resetPassword(String adminPackage, int flags)
     * yang menghapus kredensial layar kunci. Untuk unit rental ini justru lebih
     * ketat: tidak ada PIN yang bisa ditebak penyewa, tidak ada PIN yang bisa
     * diubah diam-diam, dan /unlock cukup neutralizeKeyguard(true).
     *
     * Nilai yang dikembalikan adalah kode keeper (referensi operator),
     * BUKAN PIN layar kunci.
     */
    fun newPin(length: Int = 8): String {
        val cleared = runCatching {
            dpm.resetPassword(
                ctx.packageName,
                DevicePolicyManager.RESET_PASSWORD_DO_NOT_ASK_CREDENTIALS_ON_BOOT,
            )
        }.getOrDefault(false)
        val code = buildString { repeat(length) { append("0123456789".random()) } }
        store.put(KEY_PIN, code)
        Logs.w(TAG, "kredensial layar kunci dihapus=$cleared, kode keeper baru dibuat")
        return code
    }

    /**
     * Dipanggil dari DeviceAdminReceiver.onPasswordChanged: ada yang mencoba
     * mengubah kredensial layar kunci. Respons kita: kembalikan kondisi netral
     * (keyguard nonaktif) dan pastikan semua restrictions tetap terpasang.
     */
    fun reclaimPinFromLockScreen(): String? {
        neutralizeKeyguard(true)
        val known = store.get(KEY_PIN)
        Logs.w(TAG, "Percobaan ubah kredensial layar kunci -> dinetralkan")
        return known
    }

    fun currentPin(): String? = store.get(KEY_PIN)

    fun savePin(pin: String) = store.put(KEY_PIN, pin)

    private fun showKiosk(show: Boolean) {
        runCatching {
            val i = Intent(ctx, KioskActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                action = if (show) KioskActivity.ACTION_SHOW else KioskActivity.ACTION_CLOSE
            }
            ctx.startActivity(i)
        }
    }

    /**
     * Terapkan/lepas satu user restriction. Mengembalikan true bila
     * benar-benar berlaku.
     *
     * Jangan anggap exception sebagai satu-satunya kegagalan: pada Android 14+
     * addUserRestriction() bisa TIDAK melempar apa pun tapi tetap tidak
     * berlaku. Karena itu status dibaca balik lewat getUserRestrictions().
     */
    private fun setRestriction(key: String, value: Boolean): Boolean {
        runCatching {
            if (value) dpm.addUserRestriction(admin, key) else dpm.clearUserRestriction(admin, key)
        }.onFailure { Log.w(TAG, "restriction $key: ${it.message}") }
        val effective = runCatching {
            dpm.getUserRestrictions(admin).getBoolean(key, false)
        }.getOrDefault(false)
        if (effective != value) {
            Log.w(TAG, "restriction $key TIDAK berlaku (minta=$value, aktual=$effective)")
        }
        return effective == value
    }

    /** Berapa user restriction yang benar-benar berlaku sekarang. */
    fun appliedRestrictionCount(): Int {
        val keys = listOf(
            UserManager.DISALLOW_FACTORY_RESET,
            UserManager.DISALLOW_DEBUGGING_FEATURES,
            UserManager.DISALLOW_INSTALL_UNKNOWN_SOURCES,
            UserManager.DISALLOW_USER_SWITCH,
            UserManager.DISALLOW_REMOVE_USER,
            UserManager.DISALLOW_ADD_USER,
            UserManager.DISALLOW_CONFIG_CREDENTIALS,
        )
        return runCatching {
            val r = dpm.getUserRestrictions(admin)
            keys.count { r.getBoolean(it, false) }
        }.getOrDefault(0)
    }

    /** Status ringkas untuk heartbeat. */
    fun snapshot(): Map<String, Any> = mapOf(
        "policyState" to cfg.policyState.name.lowercase(),
        "locked" to cfg.policyState.isLocked,
        "kiosk" to cfg.kioskEnabled,
        // Level proteksi yang BENAR-BENAR aktif, dibaca dari sistem. Tanpa
        // ini operator bisa melihat "policy terkirim" lalu menganggap unitnya
        // terlindungi, padahal semua restriction gagal karena admin belum
        // diaktifkan.
        "protectionLevel" to id.acefleet.guard.GuardDeviceAdminReceiver.protectionLevel(ctx),
        "adminActive" to id.acefleet.guard.GuardDeviceAdminReceiver.isAdminActive(ctx),
        "deviceOwner" to id.acefleet.guard.GuardDeviceAdminReceiver.isDeviceOwner(ctx),
        // getCameraDisabled / getUserRestrictions adalah satu-satunya cara baca
        // status yang masih ada di SDK 36 (isCameraDisabled & isUserRestriction
        // sudah dihapus).
        "cameraDisabled" to runCatching { dpm.getCameraDisabled(admin) }
            .getOrDefault(false),
        "factoryResetBlocked" to runCatching {
            dpm.getUserRestrictions(admin)
                .getBoolean(UserManager.DISALLOW_FACTORY_RESET, false)
        }.getOrDefault(false),
        // Berapa dari 7 restriction yang benar-benar berlaku. Tanpa ini,
        // dashboard hanya bisa menebak.
        "restrictionsApplied" to appliedRestrictionCount(),
        "appliedAt" to cfg.lastAppliedAt,
    )

    companion object {
        const val TAG = "Policy"
        const val MAX_FAILED_WIPE = 30
        private const val KEY_PIN = "lock_pin"
    }
}