package id.acefleet.guard

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.util.Log
import id.acefleet.guard.core.DefaultEndpoints
import id.acefleet.guard.service.GuardService

/**
 * Inisialisasi aplikasi. Sengaja minimal: semua logika berat (socket, watchdog,
 * policy) hidup di [GuardService] supaya ada SATU proses yang bisa diawasi.
 */
class App : Application() {

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        // Endpoint default disuntik sekali di sini supaya Config (dan UI pairing)
        // selalu punya tujuan yang valid walau service belum pernah jalan.
        DefaultEndpoints.install(BuildConfig.DEFAULT_WS_URL, BuildConfig.DEFAULT_PAIR_URL)
        Logs.i(TAG, "Guard start ver=${BuildConfig.VERSION_NAME} api=${android.os.Build.VERSION.SDK_INT}")

        // Device Owner bisa memanggil startForegroundService sendiri; tetap
        // dibungkus try/catch supaya tidak ada yang crash saat background.
        runCatching { GuardService.ensureRunning(this) }
            .onFailure { Logs.w(TAG, "Gagal start service dari onCreate: ${it.message}") }
    }

    private fun createNotificationChannel() {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val ch = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel_name),
            NotificationManager.IMPORTANCE_LOW, // LOW: notif tetap tampil, tidak bunyi
        ).apply {
            description = getString(R.string.notif_channel_desc)
            setShowBadge(false)
            enableVibration(false)
        }
        nm.createNotificationChannel(ch)
    }

    companion object {
        const val TAG = "Guard"
        const val CHANNEL_ID = "guard_tracking"

        @Volatile
        lateinit var instance: App
            private set
    }
}

/** Pembungkus Log dengan prefix + tetapkan agar mudah di-filter di logcat. */
object Logs {
    private const val P = "FG/"
    fun i(tag: String, m: String) = Log.i(P + tag, m)
    fun w(tag: String, m: String) = Log.w(P + tag, m)
    fun e(tag: String, m: String, t: Throwable? = null) = Log.e(P + tag, m, t)
}