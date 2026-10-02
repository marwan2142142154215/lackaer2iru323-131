package id.acefleet.guard.commands

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.media.AudioManager
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.widget.Toast
import id.acefleet.guard.GuardDeviceAdminReceiver
import id.acefleet.guard.Logs
import id.acefleet.guard.core.Config
import id.acefleet.guard.core.PolicyState
import id.acefleet.guard.location.LocationProvider
import id.acefleet.guard.media.CaptureService
import id.acefleet.guard.policy.PolicyEngine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.system.exitProcess

/**
 * Penerjemah command server -> aksi device.
 *
 * Aturan penting:
 *  - TIDAK ada command yang dijalankan tanpa `cmdId` dari frame `cmd` server.
 *    Ini yang mencegah devicedie-dricken oleh frame palsu / replay.
 *  - Semua aksi dibungkus try/catch; kegagalan dikembalikan sebagai
 *    `{ok:false, error}` supaya antrean server tidak menggantung.
 *  - Command yang merusak (reboot/wipe) tetap butuh cmdId sah; konfirmasi
 *    dua langkah sudah ditangani di sisi bot.
 */
class CommandExecutor(
    private val ctx: Context,
    private val mediaSink: suspend (kind: String, bytes: ByteArray, loc: LocationProvider.Loc?) -> Unit,
    private val tracking: (intervalSec: Int, untilSec: Int) -> Unit,
) {

    private val cfg = Config.get(ctx)
    private val engine by lazy { PolicyEngine(ctx) }
    private val locations by lazy { LocationProvider(ctx) }
    private val dpm: DevicePolicyManager by lazy {
        ctx.getSystemService(DevicePolicyManager::class.java)
            ?: error("DevicePolicyManager tidak tersedia")
    }
    private val admin by lazy { GuardDeviceAdminReceiver.component(ctx) }

    /**
     * Jalankan satu command. Return data siap dikirim balik.
     * @throws IllegalStateException bila command tidak didukung/tidak sah.
     */
    suspend fun execute(cmdId: Long, type: String, payload: JSONObject): JSONObject {
        Logs.i(TAG, "cmd#$cmdId $type")
        return when (type) {
            "lock" -> lock()
            "unlock" -> unlock(payload.optInt("pinLength", 8))
            "pin" -> JSONObject().apply { put("pin", engine.currentPin() ?: "") }
            "set_kiosk" -> setKiosk(payload.optBoolean("enabled", true))
            "locate" -> locate()
            "track_start" -> trackStart(payload.optInt("intervalSec", 60), payload.optInt("untilSec", 3600))
            "track_stop" -> trackStop()
            "camera_front" -> camera("front", cmdId)
            "camera_rear" -> camera("rear", cmdId)
            "ring" -> ring(payload.optInt("seconds", 20))
            "toast" -> toast(payload.optString("text", "Hubungi admin"))
            "set_geofence" -> setGeofence(payload)
            "apply_policy" -> applyPolicy(payload.optBoolean("full", true))
            "restart_app" -> restartApp()
            "reboot" -> reboot()
            "wipe" -> wipe(payload.optBoolean("keepEnrollment", true))
            "sync_config", "sync_now" -> JSONObject().apply { put("policyState", cfg.policyState.name) }
            else -> throw IllegalArgumentException("command tidak didukung: $type")
        }
    }

    // ------------------------------------------------------------ lock -----
    private suspend fun lock(): JSONObject {
        cfg.policyState = PolicyState.LOCKED
        engine.apply(PolicyState.LOCKED, cfg.kioskEnabled)
        return JSONObject().apply {
            put("locked", true)
            put("policyState", PolicyState.LOCKED.name)
        }
    }

    private suspend fun unlock(pinLength: Int): JSONObject {
        val pin = engine.newPin(pinLength.coerceIn(6, 16))
        cfg.policyState = PolicyState.UNLOCKED
        engine.apply(PolicyState.UNLOCKED, cfg.kioskEnabled)
        return JSONObject().apply {
            put("unlocked", true)
            put("pin", pin)
            put("pinLength", pin.length)
        }
    }

    private fun setKiosk(enabled: Boolean): JSONObject {
        cfg.kioskEnabled = enabled
        cfg.policyState = if (enabled && cfg.policyState == PolicyState.LOCKED) PolicyState.KIOSK else cfg.policyState
        engine.apply(cfg.policyState, enabled)
        return JSONObject().apply {
            put("kiosk", enabled)
            put("policyState", cfg.policyState.name)
        }
    }

    // ---------------------------------------------------------- sensor -----
    private suspend fun locate(): JSONObject {
        val loc = locations.current(highAccuracy = true) ?: locations.lastKnown()
            ?: return JSONObject().apply { put("ok", false).put("reason", "tidak ada lokasi") }
        return loc.toJson()
    }

    private fun trackStart(intervalSec: Int, untilSec: Int): JSONObject {
        tracking(intervalSec.coerceIn(10, 3600), untilSec.coerceIn(60, 86400))
        return JSONObject().apply {
            put("tracking", true)
            put("intervalSec", intervalSec)
            put("untilSec", untilSec)
        }
    }

    private fun trackStop(): JSONObject {
        tracking(0, 0)
        return JSONObject().apply { put("tracking", false) }
    }

    private suspend fun camera(kind: String, @Suppress("UNUSED_PARAMETER") cmdId: Long): JSONObject {
        if (!CaptureService.hasCameraPermission(ctx)) {
            throw IllegalStateException("izin kamera belum diberikan")
        }
        val front = kind == "front"
        val bytes = withContext(Dispatchers.Main) { awaitCapture(front) }
        val loc = locations.lastKnown()
        mediaSink(kind, bytes, loc)
        return JSONObject().apply {
            put("kind", kind)
            put("bytes", bytes.size)
        }
    }

    private suspend fun awaitCapture(front: Boolean): ByteArray = suspendCancellableCoroutine { cont ->
        // Trailing lambda tidak bisa dipakai: parameter terakhir snapshot() adalah
        // timeoutMs, bukan onResult.
        CaptureService.snapshot(ctx, front, { result ->
            result.onSuccess { cont.resume(it) }
            result.onFailure { cont.resumeWith(Result.failure(it)) }
        })
    }

    private suspend fun ring(seconds: Int): JSONObject {
        val secs = seconds.coerceIn(1, 120)
        withContext(Dispatchers.Main) {
            val am = ctx.getSystemService(AudioManager::class.java)
            // setStreamVolume tidak menerima float: indeks 0..MAX (0-10 di sebagian
            // perangkat). 7 = keras tapi tidak membutukan.
            am?.setStreamVolume(AudioManager.STREAM_ALARM, 7, 0)
            runCatching {
                RingtoneManager.getRingtone(ctx, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))
                    ?.apply {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                            isLooping = true
                        }
                        play()
                    }
            }
            val vib = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                ctx.getSystemService(VibratorManager::class.java)?.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                ctx.getSystemService(Vibrator::class.java)
            }
            val pattern = longArrayOf(0, 600, 400)
            runCatching { vib?.vibrate(VibrationEffect.createWaveform(pattern, 0)) }
            Handler(Looper.getMainLooper()).postDelayed({ runCatching { RingtoneManager.getRingtone(ctx, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))?.stop() } }, secs * 1000L)
        }
        delay(500)
        return JSONObject().apply { put("rang", secs) }
    }

    private suspend fun toast(text: String): JSONObject {
        withContext(Dispatchers.Main) {
            Toast.makeText(ctx, text, Toast.LENGTH_LONG).show()
        }
        return JSONObject().apply { put("shown", text.take(120)) }
    }

    // -------------------------------------------------------- kebijakan -----
    private fun setGeofence(p: JSONObject): JSONObject {
        cfg.radiusM = p.optInt("radiusM", cfg.radiusM)
        cfg.geofenceArmed = p.optBoolean("armed", true)
        val anchor = p.optString("anchor", "server")
        if (anchor == "device") {
            // Anchor diambil dari lokasi terakhir yang diketahui di perangkat.
            cfg.anchorLat = null
            cfg.anchorLng = null
        }
        return JSONObject().apply {
            put("radiusM", cfg.radiusM)
            put("geofenceArmed", cfg.geofenceArmed)
            put("anchor", anchor)
        }
    }

    private fun applyPolicy(full: Boolean): JSONObject {
        engine.applyBaseRestrictions()
        if (full) engine.apply(cfg.policyState, cfg.kioskEnabled)
        return JSONObject().apply {
            put("applied", true)
            put("full", full)
            put("policyState", cfg.policyState.name)
        }
    }

    private fun restartApp(): JSONObject {
        // Server akan melihat koneksi putus lalu Guard reconnect otomatis.
        // Jadwalkan nyalaan ulang lewat AlarmManager supaya proses yang
        // baru tidak ditolak Android karena start dari background.
        id.acefleet.guard.service.GuardService.scheduleRestart(ctx, 3_000L)
        Handler(Looper.getMainLooper()).postDelayed({ exitProcess(0) }, 300L)
        return JSONObject().apply { put("restarting", true) }
    }

    private suspend fun reboot(): JSONObject {
        // reboot(ComponentName) - hanya boleh dipanggil oleh Device Owner.
        val result = runCatching { dpm.reboot(admin) }
        result.onFailure { Logs.w(TAG, "reboot ditolak: ${it.message}") }
        return JSONObject().apply { put("rebootRequested", result.isSuccess) }
    }

    private suspend fun wipe(keepEnrollment: Boolean): JSONObject {
        if (keepEnrollment) {
            // Reset app: hapus PIN & cache, kunci total, enrollment tetap.
            id.acefleet.guard.core.SecureStore(ctx).put("lock_pin", "")
            cfg.policyState = PolicyState.LOCKED
            engine.apply(PolicyState.LOCKED, cfg.kioskEnabled)
            return JSONObject().apply {
                put("wiped", true)
                put("scope", "app")
            }
        }
        // Hapus total perangkat - hanya device owner boleh, dan enrollment hilang.
        runCatching { dpm.wipeData(0) }
            .onFailure { Logs.e(TAG, "wipeData: ${it.message}", it) }
        return JSONObject().apply {
            put("wiped", true)
            put("scope", "device")
        }
    }

    companion object {
        const val TAG = "Cmd"
    }
}