package id.acefleet.guard.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.app.KeyguardManager
import android.os.Build
import id.acefleet.guard.Logs
import id.acefleet.guard.core.Config
import id.acefleet.guard.service.GuardService

/**
 * Deteksi penyimpangan tampilan yang mencurigakan dan penyalaan ulang service.
 *
 * Sinyal yang dipantau:
 *  - USER_PRESENT     -> penyewa baru unlock layar; pastikan policy masih berlaku.
 *  - SCREEN_ON        -> layar menyala saat unit harus terkunci -> drift.
 *  - SCREEN_OFF       -> layingan, tidak ada aksi (hemat daya).
 *  - ACTION_SHUTDOWN  -> tandai "akan mati", nanti hidup lagi setelah boot.
 */
class SystemEventReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val cfg = Config.get(context)
        when (intent.action) {
            Intent.ACTION_USER_PRESENT -> {
                Logs.i(TAG, "layar dibuka pengguna")
                // Watchdog akan menerapkan policy; service dijaga tetap hidup.
                runCatching { GuardService.ensureRunning(context) }
            }

            Intent.ACTION_SCREEN_ON -> {
                if (cfg.policyState.isLocked) {
                    // isKeyguardLocked() ada di KeyguardManager, bukan WindowManager.
                    val km = context.getSystemService(KeyguardManager::class.java)
                    val locked = km?.let { isLockedScreen(it) } ?: false
                    if (!locked) {
                        Logs.w(TAG, "DRIFT: layar menyala saat policy ${cfg.policyState}")
                        GuardService.ensureRunning(context)
                    }
                }
            }

            Intent.ACTION_SCREEN_OFF -> Unit

            Intent.ACTION_SHUTDOWN -> {
                Logs.i(TAG, "perangkat dimatikan paksa")
            }
        }
    }

    private fun isLockedScreen(km: KeyguardManager): Boolean = runCatching {
        km.isKeyguardLocked
    }.getOrDefault(true)

    companion object {
        const val TAG = "SysEvent"
    }
}