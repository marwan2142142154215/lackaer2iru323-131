package id.acefleet.guard

import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.Toast
import id.acefleet.guard.core.Config
import id.acefleet.guard.policy.PolicyEngine
import id.acefleet.guard.service.GuardService
import id.acefleet.guard.ui.MainActivity

/**
 * Device Admin (DPC) Guard.
 *
 * Sifat penting:
 *  - Sekali Device Owner, app INI yang punya hak atas device (bukan Android
 *    Device Policy). Itu memberi resetPassword, force-lock, setCameraDisabled,
 *    setPackagesSuspended, startLockTask, dan memblokir factory reset.
 *  - App tidak bisa menghapus dirinya sendiri: setUninstallBlocked(true) untuk
 *    package Guard, dan setUserRestriction(DISALLOW_FACTORY_RESET).
 *  - Semua hook di sini harus idempotent dan cepat; work berat diserahkan ke
 *    GuardService.
 */
class GuardDeviceAdminReceiver : DeviceAdminReceiver() {

    // CATATAN: callback DeviceAdminReceiver menerima Intent, BUKAN ComponentName.
    // Ditulis dengan ComponentName, tidak ada satu pun yang meng-override.
    override fun onEnabled(context: Context, intent: Intent) {
        Logs.i(TAG, "Device admin aktif")
        val cfg = Config.get(context)
        runCatching {
            PolicyEngine(context).applyBaseRestrictions()
            PolicyEngine(context).apply(cfg.policyState, cfg.kioskEnabled)
        }.onFailure { Logs.e(TAG, "gagal terapkan policy awal: ${it.message}", it) }
        runCatching { GuardService.ensureRunning(context) }
            .onFailure { Logs.w(TAG, "start service ditolak: ${it.message}") }
    }

    override fun onDisabled(context: Context, intent: Intent) {
        // Device Owner tidak bisa dinonaktifkan tanpa factory reset / adb.
        // Tetap dicatat + dikirim ke server sebagai kejadian tamper.
        Logs.w(TAG, "PERINGATAN: device admin dinonaktifkan!")
        runCatching { GuardService.ensureRunning(context) }
        Toast.makeText(context, "Perlindungan Guard dilepas", Toast.LENGTH_LONG).show()
    }

    override fun onPasswordChanged(context: Context, intent: Intent) {
        Logs.i(TAG, "PIN layar kunci diubah")
        // Keeper harus tahu PIN baru supaya unit terkunci bisa dibuka lagi
        // lewat perintah /unlock dari server.
        runCatching { PolicyEngine(context).reclaimPinFromLockScreen() }
            .onFailure { Logs.w(TAG, "gagal ambil PIN baru: ${it.message}") }
    }

    // API 36: onPasswordExpiring(Context, Intent) tidak punya parameter
    // Selalu ditolak: RTC tidak boleh dipakai penyewa karena masa pin tidak
    // terbatas berarti tidak ada nagih login.
    override fun onPasswordExpiring(context: Context, intent: Intent) {
        runCatching {
            val dpm = context.getSystemService(DevicePolicyManager::class.java)
            dpm?.setPasswordExpirationTimeout(component(context), 0L)
        }
    }

    override fun onPasswordFailed(context: Context, intent: Intent) {
        Logs.w(TAG, "PIN salah (percobaan gagal)")
    }

    // API 36: tanda tangan sebenarnya membawa UserHandle.
    override fun onUserStopped(context: Context, intent: Intent, user: android.os.UserHandle) {
        Logs.w(TAG, "profil user dihentikan: $user")
    }

    /** Dipanggil sistem saat admin app gagal total: tampilkan UI pairing. */
    override fun onSystemUpdatePending(context: Context, intent: Intent, pending: Long) {
        runCatching {
            context.startActivity(
                Intent(context, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }

    companion object {
        const val TAG = "Admin"

        fun component(ctx: Context) = ComponentName(ctx, GuardDeviceAdminReceiver::class.java)

        /** True bila Guard adalah device owner aktif (bukan sekadar admin aktif). */
        fun isDeviceOwner(ctx: Context): Boolean = runCatching {
            val dpm = ctx.getSystemService(DevicePolicyManager::class.java) ?: return false
            dpm.isDeviceOwnerApp(component(ctx).packageName)
        }.getOrDefault(false)

        /**
         * True bila receiver Guard terdaftar sebagai device admin AKTIF.
         *
         * Penting karena tanpa admin aktif, semua panggilan
         * addUserRestriction / setUninstallBlocked / setPackagesSuspended gagal
         * diam-diam. Operator harus tahu unitnya belum terlindungi, bukan
         * menganggap proteksi sudah aktif.
         *
         * Device Admin bisa diaktifkan pada unit yang sudah punya akun Google,
         * jadi ini jalur proteksi dasar yang tetap tersedia di HP NON-DO.
         */
        fun isAdminActive(ctx: Context): Boolean = runCatching {
            val dpm = ctx.getSystemService(DevicePolicyManager::class.java) ?: return false
            dpm.isAdminActive(component(ctx))
        }.getOrDefault(false)

        /**
         * Ringkasan level proteksi yang benar-benar aktif di unit ini.
         * Dikirim ke server supaya dashboard menampilkan kenyataan, bukan
         * asumsi.
         */
        fun protectionLevel(ctx: Context): String = when {
            isDeviceOwner(ctx) -> "device_owner"
            isAdminActive(ctx) -> "device_admin"
            else -> "none"
        }
    }
}