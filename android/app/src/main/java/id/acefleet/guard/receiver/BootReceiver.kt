package id.acefleet.guard.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import id.acefleet.guard.Logs
import id.acefleet.guard.service.GuardService

/**
 * Nyalakan Guard lagi setelah reboot / update paket.
 *
 * Catatan jujur soal batasan Android 12+:
 *  - `BOOT_COMPLETED` TIDAK boleh memulai foreground service langsung
 *    (ForegroundServiceStartNotAllowedException). Karena itu kita tidak
 *    memulai service di sini; kita cukup menyalakan alarm backstop yang sudah
 *    dijadwalkan sebelum reboot, dan menjadwalkan ulang.
 *  - `LOCKED_BOOT_COMPLETED` hanya berlaku untuk directBootAware, sedangkan
 *    Guard menyimpan token di Keystore yang butuh credential storage, jadi
 *    Guard sengaja `directBootAware="false"` dan bekerja setelah user unlock.
 *  - Yang diproteksi dari sini: setting "matikan dan restart" -> Guard hidup
 *    lagi dalam <15 detik. Yang TIDAK bisa dilindungi: hard power off lalu
 *    penyewa menahan tombol power sampai alarm mati.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        Logs.i(TAG, "boot event: $action")

        when (action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON",
            -> {
                // Jadwalkan ulang backstop, lalu coba start langsung (berhasil
                // di Android 10-11 dan setelah update paket di semua versi).
                GuardService.scheduleRestart(context, 10_000L)
                runCatching { GuardService.ensureRunning(context) }
                    .onSuccess { Logs.i(TAG, "service dinyalakan setelah $action") }
                    .onFailure { Logs.w(TAG, "start langsung ditolak (Android 12+): ${it.message}") }
            }
        }
    }

    companion object {
        const val TAG = "Boot"
    }
}