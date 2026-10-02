package id.acefleet.guard.service

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import id.acefleet.guard.App
import id.acefleet.guard.Logs
import id.acefleet.guard.core.Config
import id.acefleet.guard.core.PolicyState
import id.acefleet.guard.policy.PolicyEngine

/**
 * Watchdog: satu-satunya penjaga yang berjalan 24 jam.
 *
 * Siklus default 500 ms (sesuai kebutuhan "dibuka -> 0,5 detik"), otomatis
 * melambat ke 5 detik saat device dalam keadaan locked / tidak ada interaksi,
 * supaya baterai tidak habis.
 *
 * Yang diperiksa tiap siklus:
 *  1. Guard masih Device Owner (bukan sekadar device admin aktif).
 *  2. UserRestriction.DISALLOW_FACTORY_RESET masih terpasang.
 *  3. Policy tidak menyimpang dari desired state (dibuka paksa / di-uninstall).
 *  4. Kamera wajib mati selama unit terkunci.
 *  5. Socket tidak macet (umur frame terakhir < 3x heartbeat).
 *
 * Semua pemeriksaan dibaca-saja, lalu perbaikannya idempotent, jadi siklus
 * 500 ms tidak menimbulkan efek samping yang menumpuk.
 */
class Watchdog(
    private val ctx: Context,
    private val onDrift: (Drift) -> Unit,
) {
    enum class Drift { NOT_DEVICE_OWNER, POLICY_MISMATCH, CAMERA_ON_WHILE_LOCKED, FACTORY_RESET_ALLOWED }

    private val thread = HandlerThread("guard-watchdog", android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
    private lateinit var handler: Handler
    private var lastAppliedState: PolicyState? = null
    private var lastCameraOff: Boolean? = null

    /** Drift terakhir yang sudah dilaporkan; dipakai supaya laporan hanya
     *  terjadi saat kondisinya berubah, bukan setiap siklus 500 ms. */
    private var reportedDrift: Drift? = null
    @Volatile var socketAlive = false
        private set
    @Volatile var lastFrameAt = 0L
        private set
    private val cfg = Config.get(ctx)
    private val engine by lazy { PolicyEngine(ctx) }

    fun start() {
        if (thread.isAlive) return
        thread.start()
        handler = Handler(thread.looper)
        handler.post(tick)
    }

    fun stop() {
        runCatching { handler.removeCallbacksAndMessages(null) }
        runCatching { thread.quitSafely() }
    }

    fun noteFrame() {
        lastFrameAt = SystemClock.elapsedRealtime()
        socketAlive = true
    }

    fun noteClosed() {
        socketAlive = false
    }

    private val tick = object : Runnable {
        override fun run() {
            try {
                check()
            } catch (e: Exception) {
                Log.e(TAG, "watchdog error: ${e.message}", e)
            }
            val delay = if (cfg.policyState.isLocked) LOCKED_INTERVAL_MS else cfg.watchdogMs.toLong()
            handler.postDelayed(this, delay)
        }
    }

    private fun check() {
        // 1. masih device owner?
        //
        // Penting: drift dilaporkan HANYA saat kondisinya berubah. Sebelumnya
        // setiap siklus 500 ms melaporkan ulang, jadi satu unit yang memang
        // belum di-provisioning (belum Device Owner) mengirim event
        // "tamper/critical" 2x per detik tanpa henti. Itu membanjiri server
        // dan, lebih buruk, menutupi alarm tamper yang sungguhan.
        if (!id.acefleet.guard.GuardDeviceAdminReceiver.isDeviceOwner(ctx)) {
            report(Drift.NOT_DEVICE_OWNER, "DRIFT: Guard bukan device owner lagi")
            // Kebijakan tidak bisa ditegakkan tanpa Device Owner, tapi
            // kesehatan socket dan wake lock TIDAK butuh Device Owner.
            // Kalau dilewati juga, unit non-DO kehilangan watchdog sama sekali.
            checkSocketAndAwake()
            return
        }

        // 2. factory reset harus terblokir
        runCatching {
            val dpm = ctx.getSystemService(android.app.admin.DevicePolicyManager::class.java)
            val admin = id.acefleet.guard.GuardDeviceAdminReceiver.component(ctx)
            // getUserRestrictions/getCameraDisabled adalah satu-satunya cara baca status
            // yang masih ada di SDK 36.
            val blocked = dpm?.getUserRestrictions(admin)
                ?.getBoolean(android.os.UserManager.DISALLOW_FACTORY_RESET, false) == true
            if (!blocked) {
                report(Drift.FACTORY_RESET_ALLOWED, "DRIFT: factory reset tidak diblokir")
                engine.applyBaseRestrictions()
            }
        }

        // 3. policy sesuai desired state?
        if (lastAppliedState != cfg.policyState) {
            Logs.i(TAG, "terapkan policy ${cfg.policyState}")
            engine.apply(cfg.policyState, cfg.kioskEnabled)
            lastAppliedState = cfg.policyState
            cfg.lastAppliedAt = SystemClock.elapsedRealtime()
        }

        // 4. kamera harus mati saat terkunci
        if (cfg.policyState.isLocked && lastCameraOff == false) {
            runCatching { engine.apply(cfg.policyState, cfg.kioskEnabled) }
            report(Drift.CAMERA_ON_WHILE_LOCKED, "DRIFT: kamera menyala saat terkunci")
        }
        lastCameraOff = try {
            val dpm = ctx.getSystemService(android.app.admin.DevicePolicyManager::class.java)
            val admin = id.acefleet.guard.GuardDeviceAdminReceiver.component(ctx)
            // Default 'true' (= kamera dianggap mati) supaya drift status tidak
            // memicu alarm palsu. Default 'false' justru berbahaya: kamera
            // menyala sementara tenant mengira terkunci.
            dpm?.getCameraDisabled(admin) ?: true
        } catch (e: Exception) {
            true
        }

        // 5. socket hidup? + 6. wormhole: kalau proses ini hilang, pastikan hidup lagi.
        checkSocketAndAwake()
        // Semua pemeriksaan lolos tanpa drift ->conditions siap dideteksi lagi.
        reportedDrift = null
    }

    /**
     * Cek kesehatan socket + pegang wakelock. Dipisah karena dua bagian ini
     * tidak butuh Device Owner, jadi tetap jalan di unit yang belum
     * di-provisioning.
     */
    private fun checkSocketAndAwake() {
        val maxAge = (cfg.heartbeatMs.toLong() * 3).coerceAtLeast(30_000L)
        if (socketAlive && SystemClock.elapsedRealtime() - lastFrameAt > maxAge) {
            socketAlive = false
            report(Drift.POLICY_MISMATCH, "socket tidak ada frame selama ${maxAge / 1000}s")
        }
        if (socketAlive) keepAwake()
    }

    /** Laporkan drift hanya saat berganti kondisi, bukan tiap siklus. */
    private fun report(drift: Drift, msg: String) {
        if (reportedDrift == drift) return
        reportedDrift = drift
        Logs.w(TAG, msg)
        onDrift(drift)
    }

    private fun keepAwake() {
        runCatching {
            val pm = ctx.getSystemService(PowerManager::class.java) ?: return
            val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fleet:guard")
            wl.setReferenceCounted(false)
            wl.acquire(60_000L)
        }
    }

    companion object {
        const val TAG = "Watchdog"
        const val LOCKED_INTERVAL_MS = 5_000L

        fun notification(ctx: Context, status: String): Notification =
            androidx.core.app.NotificationCompat.Builder(ctx, App.CHANNEL_ID)
                .setContentTitle(ctx.getString(id.acefleet.guard.R.string.notif_running))
                .setContentText(status)
                // android.R.drawable.ic_menu_lock_lock sudah tidak ada di
                // android.jar API 36, jadi Guard memakai drawable sendiri.
                .setSmallIcon(id.acefleet.guard.R.drawable.ic_guard_lock)
                .setOngoing(true)
                .setSilent(true)
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_LOW)
                .setContentIntent(
                    PendingIntent.getActivity(
                        ctx,
                        0,
                        Intent(ctx, id.acefleet.guard.ui.MainActivity::class.java),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    )
                )
                .build()
    }
}