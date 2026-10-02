package id.acefleet.guard.service

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.StatFs
import android.provider.Settings
import android.util.Log
import id.acefleet.guard.App
import id.acefleet.guard.BuildConfig
import id.acefleet.guard.GuardDeviceAdminReceiver
import id.acefleet.guard.Logs
import id.acefleet.guard.commands.CommandExecutor
import id.acefleet.guard.core.Config
import id.acefleet.guard.core.DefaultEndpoints
import id.acefleet.guard.core.PolicyState
import id.acefleet.guard.location.LocationProvider
import id.acefleet.guard.net.GuardSocket
import id.acefleet.guard.policy.PolicyEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.Base64

/**
 * Otak Guard: satu foreground service yang menjalankan socket, watchdog,
 * heartbeat, dan pengiriman lokasi.
 *
 * Semua aturan kelangsungan hidup:
 *  1.BOOT_COMPLETED / MY_PACKAGE_REPLACED -> start service lagi.
 *  2. Android 12+ melarang start FGS dari BOOT_COMPLETED, jadi ada
 *     backstop: AlarmManager exact yang menyalakan service lagi dalam 15 detik.
 *  3. Watchdog 0,5 detik memverifikasi policy terus-menerus.
 *  4. Socket punya reconnect backoff 1s..30s, jadi WI-FI mati/nyala aman.
 */
class GuardService : Service() {

    private val cfg by lazy { Config.get(this) }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var socket: GuardSocket? = null
    private var watchdog: Watchdog? = null
    private var executor: CommandExecutor? = null
    private val locations by lazy { LocationProvider(this) }
    private var lastCommandAt = 0L
    private var bootAt = System.currentTimeMillis()
    private var serviceStartAt = System.currentTimeMillis()

    @Volatile
    private var trackingUntil = 0L

    @Volatile
    private var trackingIntervalSec = 0

    // ------------------------------------------------------------ lifecycle --
    override fun onCreate() {
        super.onCreate()
        DefaultEndpoints.install(BuildConfig.DEFAULT_WS_URL, BuildConfig.DEFAULT_PAIR_URL)
        bootAt = readBootAt()
        serviceStartAt = System.currentTimeMillis()
        Logs.i(TAG, "service dibuat device=${cfg.deviceId ?: "unpaired"}")

        // Alarm backstop: kalau proses dibunuh sistem, service hidup lagi.
        scheduleRestart(this, BACKSTOP_MS)
        requestBatteryExemption()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Wajib dalam 5 detik atau sistem menjatuhkan startForegroundService.
        runCatching { promoteToForeground("memulai…") }
            .onFailure { Logs.e(TAG, "startForeground ditolak: ${it.message}", it) }

        when (intent?.action) {
            ACTION_RESTART -> Logs.i(TAG, "restart terjadwal")
        }

        ensurePipeline()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Logs.w(TAG, "service dimatikan oleh sistem - akan dinyalakan ulang lewat alarm")
        watchdog?.stop()
        socket?.stop()
        scope.cancel()
        scheduleRestart(this, BACKSTOP_MS)
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Geser ke depan: mencegah OS mematikan proses saat user swipe app.
        runCatching {
            val i = Intent(applicationContext, GuardService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(i)
            } else {
                startService(i)
            }
        }
        super.onTaskRemoved(rootIntent)
    }

    // ------------------------------------------------------------ pipeline --
    private fun ensurePipeline() {
        if (socket != null) return

        val engine = PolicyEngine(this)
        runCatching { engine.applyBaseRestrictions() }

        executor = CommandExecutor(
            ctx = this,
            mediaSink = { kind, bytes, loc -> sendMedia(kind, bytes, loc) },
            tracking = { interval, until ->
                trackingIntervalSec = interval
                trackingUntil = System.currentTimeMillis() + until * 1000L
            },
        )

        watchdog = Watchdog(this) { drift -> onDrift(drift) }.also {
            it.start()
            it.noteFrame()
        }

        val id = cfg.deviceId
        val token = cfg.token
        if (id.isNullOrEmpty() || token.isNullOrEmpty()) {
            Logs.w(TAG, "belum pairing - Guard dalam mode menunggu")
            return
        }

        val s = GuardSocket(cfg.wsUrl, id, token, object : GuardSocket.Listener {
            override fun onOpen() {
                Logs.i(TAG, "socket terbuka")
            }

            override fun onAuthenticated(welcome: JSONObject) {
                Logs.i(TAG, "auth ok: ${welcome.optString("nama")}")
                welcome.optInt("heartbeatIntervalMs", cfg.heartbeatMs).let { cfg.heartbeatMs = it }
                applyServerConfig(welcome.optJSONObject("config"))
                sendHello()
            }

            override fun onFrame(frame: JSONObject) = handleFrame(frame)

            override fun onClosed(reason: String) {
                Logs.w(TAG, "socket tutup: $reason")
                watchdog?.noteClosed()
            }
        })
        socket = s
        s.start()

        startHeartbeat()
        startLocationLoop()
    }

    // ------------------------------------------------------------- frames ---
    private fun send(obj: JSONObject) {
        val s = socket ?: return
        if (!s.send(obj)) Logs.w(TAG, "frame gagal terkirim: ${obj.optString("t")}")
    }

    private fun handleFrame(frame: JSONObject) {
        watchdog?.noteFrame()
        when (frame.optString("t")) {
            "welcome" -> {
                cfg.namaDevice = frame.optString("nama", cfg.namaDevice)
                cfg.heartbeatMs = frame.optInt("heartbeatIntervalMs", cfg.heartbeatMs)
                applyServerConfig(frame.optJSONObject("config"))
                sendHello()
            }

            "sync" -> applyServerConfig(frame.optJSONObject("config"))
            "ping" -> send(JSONObject().apply { put("t", "pong"); put("pong", frame.optLong("ts", 0L)) })
            "ack" -> Logs.i(TAG, "ack ${frame.optString("for")}")
            "cmd" -> onCommand(frame)
            else -> Logs.i(TAG, "frame tak dikenal: ${frame.optString("t")}")
        }
    }

    /** Server adalah sumber kebenaran config; Config device hanya cermin. */
    private fun applyServerConfig(c: JSONObject?) {
        if (c == null) return
        c.optInt("radiusM", -1).takeIf { it >= 0 }?.let { cfg.radiusM = it }
        if (c.has("geofenceArmed")) cfg.geofenceArmed = c.optBoolean("geofenceArmed", false)
        c.optString("policyState", "").takeIf { it.isNotEmpty() }?.let { s ->
            runCatching { cfg.policyState = PolicyState.valueOf(s.uppercase()) }
        }
        c.optString("namaDevice", "").takeIf { it.isNotEmpty() }?.let { cfg.namaDevice = it }
        c.optInt("watchdogMsUnlocked", 0).takeIf { it >= 100 }?.let { cfg.watchdogMs = it }
        Logs.i(TAG, "config sinkron: ${cfg.snapshot()}")
    }

    private fun sendHello() {
        val st = statusSnapshot()
        send(JSONObject().apply {
            put("t", "hello")
            put("status", st)
        })
    }

    // ------------------------------------------------------------ commands --
    private fun onCommand(frame: JSONObject) {
        val cmdId = frame.optLong("cmdId", 0L)
        val type = frame.optString("type")
        val payload = frame.optJSONObject("payload") ?: JSONObject()
        val ex = executor
        if (cmdId <= 0L || type.isEmpty() || ex == null) {
            Logs.w(TAG, "cmd tidak valid diabaikan: $frame")
            return
        }
        scope.launch {
            lastCommandAt = System.currentTimeMillis()
            val started = System.currentTimeMillis()
            try {
                val data = ex.execute(cmdId, type, payload)
                send(JSONObject().apply {
                    put("t", "result")
                    put("cmdId", cmdId)
                    put("ok", true)
                    put("data", data)
                    put("ms", System.currentTimeMillis() - started)
                })
            } catch (e: Exception) {
                Logs.e(TAG, "cmd $type gagal: ${e.message}", e)
                send(JSONObject().apply {
                    put("t", "result")
                    put("cmdId", cmdId)
                    put("ok", false)
                    put("error", e.message ?: e.javaClass.simpleName)
                })
            }
        }
    }

    private suspend fun sendMedia(kind: String, bytes: ByteArray, loc: LocationProvider.Loc?) {
        val locField = locations.lastKnown() ?: loc
        send(
            JSONObject().apply {
                put("t", "media")
                put("kind", if (kind == "front") "front" else "rear")
                put("mime", "image/jpeg")
                put("b64", Base64.getEncoder().encodeToString(bytes))
                put("ts", java.time.Instant.now().toString())
                locField?.let {
                    put("lat", it.lat)
                    put("lng", it.lng)
                }
            },
        )
    }

    // -------------------------------------------------------------- events --
    private fun onDrift(drift: Watchdog.Drift) {
        when (drift) {
            Watchdog.Drift.POLICY_MISMATCH -> {
                // Socket yang macet: restart pipeline.
                Logs.w(TAG, "socket macet -> reset socket")
                socket?.stop()
                socket = null
                scope.launch { delay(500); ensurePipeline() }
            }

            Watchdog.Drift.NOT_DEVICE_OWNER -> sendEvent(
                "tamper",
                "critical",
                "Guard bukan device owner lagi - perlindungan hilang",
            )

            Watchdog.Drift.FACTORY_RESET_ALLOWED -> sendEvent(
                "policy_drift",
                "critical",
                "pembatasan factory reset dilepas; sudah diterapkan ulang",
            )

            Watchdog.Drift.CAMERA_ON_WHILE_LOCKED -> sendEvent(
                "policy_drift",
                "high",
                "kamera menyala saat unit terkunci",
            )
        }
    }

    fun sendEvent(event: String, severity: String, detail: String) {
        send(JSONObject().apply {
            put("t", "event")
            put("event", event)
            put("severity", severity)
            put("detail", detail)
            put("ts", java.time.Instant.now().toString())
        })
    }

    // ------------------------------------------------------------- loops ----
    private fun startHeartbeat() {
        scope.launch {
            while (isActive) {
                delay(cfg.heartbeatMs.toLong().coerceAtLeast(5_000L))
                if (!cfg.isEnrolled) continue
                send(JSONObject().apply {
                    put("t", "hb")
                    put("status", statusSnapshot())
                })
            }
        }
    }

    /**
     * Loop lokasi. Interval normal 5 menit; saat `track_start` aktif jadi
     * lebih cepat; saat unit terkunci jadi 60 detik supaya jejak tetap jelas.
     */
    private fun startLocationLoop() {
        scope.launch {
            // Titik pertama dikirim LANGSUNG, tidak setelah menunggu satu
            // interval penuh. Kalau tidak, unit yang baru dipasang terlihat
            // "online tapi tanpa lokasi" selama 5 menit, dan unit yang sudah
            // terkunci selama 60 detik - terlalu lama untuk operasi yang sedang
            // dikejar.
            var first = true
            while (isActive) {
                val tracking = trackingIntervalSec > 0 && System.currentTimeMillis() < trackingUntil
                val interval = when {
                    tracking -> trackingIntervalSec.toLong()
                    cfg.policyState.isLocked -> 60L
                    else -> 300L
                }
                if (!first) delay(interval * 1000L)
                first = false
                if (!cfg.isEnrolled) continue
                val loc = locations.current(highAccuracy = tracking || cfg.policyState.isLocked)
                    ?: locations.lastKnown()
                if (loc == null) {
                    Logs.w(TAG, "lokasi tidak tersedia")
                    continue
                }
                send(JSONObject().apply {
                    put("t", "loc")
                    put("location", loc.toJson())
                })
            }
        }
    }

    // ------------------------------------------------------------- status ---
    private fun statusSnapshot(): JSONObject {
        val st = JSONObject()
        st.put("androidVersion", Build.VERSION.RELEASE ?: "?")
        st.put("apiLevel", Build.VERSION.SDK_INT)
        st.put("model", Build.MODEL)
        st.put("manufacturer", Build.MANUFACTURER)
        st.put("appVersion", BuildConfig.VERSION_NAME)
        st.put("policyState", cfg.policyState.name.lowercase())
        st.put("locked", cfg.policyState.isLocked)
        st.put("kiosk", cfg.kioskEnabled)
        st.put("geofenceArmed", cfg.geofenceArmed)
        st.put("radiusM", cfg.radiusM)
        st.put("deviceOwner", GuardDeviceAdminReceiver.isDeviceOwner(this))
        st.put("bootAt", bootAt)
        st.put("serviceStartAt", serviceStartAt)
        st.put("lastCommandAt", lastCommandAt.takeIf { it > 0 } ?: 0L)
        st.put("androidId", Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID))

        // Baterai
        runCatching {
            val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
            if (level >= 0) st.put("battery", (level * 100.0 / scale).toInt())
            val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            st.put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL)
            st.put("batteryTemp", ((intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10.0))
        }
        if (st.optInt("battery", 100) <= 15) {
            sendEvent("battery_low", "warn", "baterai ${st.optInt("battery")}%")
        }

        // Jaringan
        runCatching {
            val cm = getSystemService(ConnectivityManager::class.java)
            val caps = cm?.getNetworkCapabilities(cm.activeNetwork)
            st.put("network", when {
                caps == null -> "offline"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                else -> "lain"
            })
        }

        // Memori & storage
        runCatching {
            val am = getSystemService(android.app.ActivityManager::class.java)
            val mi = android.app.ActivityManager.MemoryInfo()
            am?.getMemoryInfo(mi)
            st.put("ramFreeMb", (mi.availMem / 1048576L).toInt())
            val sf = StatFs(filesDir.absolutePath)
            st.put("storageFreeMb", (sf.availableBytes / 1048576L).toInt())
        }
        return st
    }

    // ------------------------------------------------------------ helpers ---
    // SpecialUse hanya ada di API 34; karena konstantanya di-inline, aman
    // dipanggil di Android 10-13 (nilainya tidak dibaca runtime).
    @SuppressLint("InlinedApi")
    private fun promoteToForeground(text: String) {
        val notif = Watchdog.notification(this, text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Android 14+ (API 34) melempar SecurityException kalau FGS naik
            // dengan tipe LOCATION sementara permission lokasi belum di-grant
            // saat runtime. Guard lalu ikut mati setiap kali naik ke foreground.
            // Jadi tipe LOCATION hanya ikut kalau izinnya benar-benar ada.
            //
            // Kenapa izinnya bisa belum ada: setPermissionGrantState hanya
            // berhasil kalau app sudah Device Owner. Unit yang belum jadi
            // Device Owner (mis. masih ada akun Google di HP) harus lewat
            // dialog izin biasa dulu.
            var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            val fine = checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
            val coarse = checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED
            if (fine || coarse) {
                type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            }
            startForeground(NOTIF_ID, notif, type)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun readBootAt(): Long = System.currentTimeMillis()

    /**
     * Cabut Guard dari daftar "hemat baterai" tanpa membuka dialog.
     * Ini penting: Android bisa mematikan app yang tidak di-whitelist saat
     * layar mati, dan itu akan memutus socket pada mode lyingan.
     *
     * CATATAN API: PowerManager.setIgnoreBatteryOptimizations() tidak ada di
     * android.jar API 36 (yang tersedia hanya isIgnoringBatteryOptimizations),
     * jadi satu-satunya rute sah adalah membuka layar konfirmasi sistem.
     * Persetujuan tetap butuh satu sentuh pengguna - itu batasan platform,
     * bukan kelemahan Guard. Tanpa persetujuan, unit yang sedang replyingan
     * bisa dibunuh sistem dan socket terputus.
     */
    private fun requestBatteryExemption() {
        runCatching {
            val pm = getSystemService(PowerManager::class.java) ?: return
            if (pm.isIgnoringBatteryOptimizations(packageName)) return
            @Suppress("BatteryLife")
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    android.net.Uri.parse("package:$packageName"),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            Logs.i(TAG, "minta pengecualian optimasi baterai (perlu persetujuan pengguna)")
        }.onFailure { Logs.w(TAG, "permintaan battery exemption gagal: ${it.message}") }
    }

    companion object {
        const val TAG = "Service"
        const val NOTIF_ID = 1
        const val ACTION_RESTART = "id.acefleet.guard.RESTART"
        private const val BACKSTOP_MS = 15_000L

        /** Dipanggil dari App/AdminReceiver/BootReceiver. Aman dipanggil berulang. */
        fun ensureRunning(ctx: Context) {
            val i = Intent(ctx, GuardService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i)
            } else {
                ctx.startService(i)
            }
        }

        /**
         * Backstop untuk Android 12+: start FGS dari BOOT_COMPLETED ditolak,
         * tapi AlarmManager yang disetel SEBELUM reboot tetap menyala.
         */
        fun scheduleRestart(ctx: Context, delayMs: Long) {
            runCatching {
                val am = ctx.getSystemService(AlarmManager::class.java) ?: return
                val pi = PendingIntent.getBroadcast(
                    ctx,
                    900,
                    Intent(ctx, RestartReceiver::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
                    am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, android.os.SystemClock.elapsedRealtime() + delayMs, pi)
                } else {
                    am.setExactAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP,
                        android.os.SystemClock.elapsedRealtime() + delayMs,
                        pi,
                    )
                }
            }.onFailure { Log.w(TAG, "scheduleRestart: ${it.message}") }
        }
    }
}

/** Receiver kecil yang hanya meneruskan alarm backstop ke service. */
class RestartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        Logs.i("Service", "alarm backstop menyala")
        runCatching { GuardService.ensureRunning(context) }
            .onFailure { Logs.w("Service", "backstop ditolak: ${it.message}") }
    }
}