package id.acefleet.guard.ui

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import id.acefleet.guard.GuardDeviceAdminReceiver
import id.acefleet.guard.Logs
import id.acefleet.guard.core.Config
import id.acefleet.guard.policy.PolicyEngine
import id.acefleet.guard.service.GuardService
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Layar Guard.
 *
 * Tiga fungsi, semuanya penting untuk operasional rental:
 *  1. Pairing perangkat dengan kode 8 karakter dari server.
 *  2. Menampilkan status nyata (device owner, policy, socket, lokasi).
 *  3. Memberi izin runtime secara otomatis sebagai Device Owner
 *     (DevicePolicyManager.setPermissionGrantState) sehingga tidak ada dialog
 *     yang bisa disabotase penyewa.
 */
class MainActivity : android.app.Activity() {

    private lateinit var cfg: Config
    private lateinit var status: TextView
    private val io = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cfg = Config.get(this)
        setContentView(buildUi())
        grantPermissionsAutomatically()
        GuardService.ensureRunning(this)
        refresh()
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    // ----------------------------------------------------------------- UI ---
    private fun buildUi(): View {
        val pad = (16 * resources.displayMetrics.density).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(0xFF0D1117.toInt())
        }

        root.addView(
            TextView(this).apply {
                text = "Fleet Guard"
                textSize = 24f
                setTextColor(0xFFE6EDF3.toInt())
            },
        )

        status = TextView(this).apply {
            textSize = 13f
            setTextColor(0xFF8B949E.toInt())
            setPadding(0, pad, 0, pad)
        }
        root.addView(status)

        val codeInput = EditText(this).apply {
            hint = "Kode pairing 8 karakter"
            // setHintTextColor(int) tidak punya pasangan getter yang cocok, jadi
            // tidak bisa dipanggil sebagai properti Kotlin.
            setHintTextColor(0xFF8B949E.toInt())
            setTextColor(0xFFE6EDF3.toInt())
            isSingleLine = true
        }
        root.addView(codeInput)

        root.addView(
            Button(this).apply {
                text = "Pasangkan"
                setOnClickListener { pair(codeInput.text.toString().trim()) }
            },
        )

        root.addView(
            Button(this).apply {
                text = "Terapkan ulang policy"
                setOnClickListener {
                    runCatching {
                        PolicyEngine(this@MainActivity).applyBaseRestrictions()
                        PolicyEngine(this@MainActivity).apply(cfg.policyState, cfg.kioskEnabled)
                        grantPermissionsAutomatically()
                        toast("Policy diterapkan ulang")
                    }.onFailure { toast("Gagal: ${it.message}") }
                    refresh()
                }
            },
        )

        root.addView(
            Button(this).apply {
                text = "Mulai ulang Guard"
                setOnClickListener {
                    GuardService.ensureRunning(this@MainActivity)
                    toast("Service disuruh hidup")
                }
            },
        )

        return ScrollView(this).apply { addView(root) }
    }

    private fun refresh() {
        val owner = GuardDeviceAdminReceiver.isDeviceOwner(this)
        val lines = buildList {
            add("device_id : ${cfg.deviceId ?: "-"}")
            add("nama      : ${cfg.namaDevice}")
            add("server    : ${cfg.wsUrl}")
            add("device owner : $owner")
            add("policy    : ${cfg.policyState} (kiosk=${cfg.kioskEnabled})")
            add("geofence  : ${if (cfg.geofenceArmed) "armed ${cfg.radiusM}m" else "off"}")
            add("watchdog  : ${cfg.watchdogMs} ms")
            add("android   : ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            add("build     : ${id.acefleet.guard.BuildConfig.VERSION_NAME}")
        }
        status.text = lines.joinToString("\n")
    }

    // ------------------------------------------------------------ pairing ---
    private fun pair(code: String) {
        if (code.length < 6) {
            toast("Kode pairing terlalu pendek")
            return
        }
        toast("MemPairing…")
        io.execute {
            val result = runCatching { postPair(code) }
            runOnUiThread {
                result.onSuccess { r ->
                    cfg.deviceId = r.getString("deviceId")
                    cfg.token = r.getString("token")
                    cfg.namaDevice = r.optString("nama", cfg.namaDevice)
                    cfg.wsUrl = r.optString("wsUrl", cfg.wsUrl).takeIf { it.isNotEmpty() } ?: cfg.wsUrl
                    r.optInt("heartbeatIntervalMs", cfg.heartbeatMs).let { cfg.heartbeatMs = it }
                    Logs.i("Pair", "berhasil: ${cfg.deviceId}")
                    toast("Terdaftar sebagai ${cfg.namaDevice}")
                    grantPermissionsAutomatically()
                    runCatching { PolicyEngine(this@MainActivity).applyBaseRestrictions() }
                    GuardService.ensureRunning(this@MainActivity)
                    refresh()
                }.onFailure {
                    Logs.w("Pair", "gagal: ${it.message}")
                    toast("Gagal: ${it.message}")
                }
            }
        }
    }

    private fun postPair(code: String): JSONObject {
        val url = cfg.pairUrl
        require(url.startsWith("https://")) { "endpoint pairing harus HTTPS" }
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 10_000
            readTimeout = 15_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        try {
            conn.outputStream.use { it.write(JSONObject().put("code", code).toString().toByteArray()) }
            val code2 = conn.responseCode
            val stream = if (code2 in 200..299) conn.inputStream else conn.errorStream
            val text = BufferedReader(stream?.reader() ?: return error("respons kosong")).use { it.readText() }
            if (code2 !in 200..299) {
                val msg = runCatching { JSONObject(text).optString("error") }.getOrDefault("HTTP $code2")
                error(msg)
            }
            return JSONObject(text)
        } finally {
            conn.disconnect()
        }
    }

    // -------------------------------------------------------- permissions ---
    /**
     * Device Owner boleh memberi izin runtime sendiri lewat
     * DevicePolicyManager.setPermissionGrantState. Ini eliminates dialog izin
     * yang biasa bisa diketuk penyewa, dan tetap 100% API resmi Android.
     */
    private fun grantPermissionsAutomatically() {
        if (!GuardDeviceAdminReceiver.isDeviceOwner(this)) return
        runCatching {
            val dpm = getSystemService(DevicePolicyManager::class.java) ?: return
            val admin: ComponentName = GuardDeviceAdminReceiver.component(this)
            val wanted = mutableListOf(
                android.Manifest.permission.CAMERA,
                android.Manifest.permission.ACCESS_FINE_LOCATION,
                android.Manifest.permission.ACCESS_COARSE_LOCATION,
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                wanted += android.Manifest.permission.POST_NOTIFICATIONS
            }
            for (p in wanted) {
                runCatching {
                    // API 36: setPermissionGrantState kini 4 parameter -
                    // (admin, packageName, permission, grantState). Bentuk 3
                    // parameter sudah dihapus.
                    dpm.setPermissionGrantState(
                        admin,
                        packageName,
                        p,
                        DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED,
                    )
                }
            }
            // Lokasi background perlu runtime grant terpisah di Android 10+.
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S) {
                runCatching {
                    dpm.setPermissionGrantState(
                        admin,
                        packageName,
                        android.Manifest.permission.ACCESS_BACKGROUND_LOCATION,
                        DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED,
                    )
                }
            }
            Logs.i(TAG, "izin runtime diberikan otomatis")
        }
    }

    private fun toast(msg: String) =
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    companion object {
        const val TAG = "Main"
    }
}