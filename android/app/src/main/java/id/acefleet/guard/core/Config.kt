package id.acefleet.guard.core

import android.content.Context

/**
 * State Guard yang dibutuhkan socket, policy engine, dan UI.
 *
 * "Desired state" (policyState, radiusM, geofenceArmed) disimpan di sini dan
 * selalu menjadi acuan: kalau perangkat nyata menyimpang (dibuka paksa,
 * permission dicabut, service dibunuh), watchdog akan menerapkan ulang nilai
 * dari objek ini. Tidak ada state policy yang hidup hanya di memori.
 */
class Config private constructor(private val store: SecureStore) {

    // ---- identitas / enrollment -------------------------------------------
    var deviceId: String?
        get() = store.get(KEY_ID)
        set(v) = store.put(KEY_ID, v)

    var token: String?
        get() = store.get(KEY_TOKEN)
        set(v) = store.put(KEY_TOKEN, v)

    var wsUrl: String
        get() = store.get(KEY_WS) ?: defaultWsUrl
        set(v) = store.put(KEY_WS, v)

    var pairUrl: String
        get() = store.get(KEY_PAIR) ?: defaultPairUrl
        set(v) = store.put(KEY_PAIR, v)

    var namaDevice: String
        get() = store.get(KEY_NAMA) ?: "(belum terdaftar)"
        set(v) = store.put(KEY_NAMA, v)

    val isEnrolled: Boolean get() = !deviceId.isNullOrEmpty() && !token.isNullOrEmpty()

    // ---- desired state policy (ditulis server, dibaca watchdog) ----------
    var policyState: PolicyState
        get() = runCatching { PolicyState.valueOf(store.getPlain(KEY_POLICY, "UNLOCKED")) }
            .getOrDefault(PolicyState.UNLOCKED)
        set(v) = store.putPlain(KEY_POLICY, v.name)

    var kioskEnabled: Boolean
        get() = store.getBool(KEY_KIOSK, false)
        set(v) = store.putBool(KEY_KIOSK, v)

    var radiusM: Int
        get() = store.getLong(KEY_RADIUS, 150L).toInt()
        set(v) = store.putLong(KEY_RADIUS, v.toLong())

    var geofenceArmed: Boolean
        get() = store.getBool(KEY_GEOFENCE, false)
        set(v) = store.putBool(KEY_GEOFENCE, v)

    var anchorLat: Double?
        get() = store.getPlain(KEY_ANCHOR_LAT, "").toDoubleOrNull()
        set(v) = store.putPlain(KEY_ANCHOR_LAT, v?.toString() ?: "")

    var anchorLng: Double?
        get() = store.getPlain(KEY_ANCHOR_LNG, "").toDoubleOrNull()
        set(v) = store.putPlain(KEY_ANCHOR_LNG, v?.toString() ?: "")

    // ---- runtime (tidak dienkripsi, tidak sensitif) -----------------------
    var watchdogMs: Int
        get() = store.getLong(KEY_WATCHDOG, 500L).toInt()
        set(v) = store.putLong(KEY_WATCHDOG, v.toLong())

    var heartbeatMs: Int
        get() = store.getLong(KEY_HEARTBEAT, 30_000L).toInt()
        set(v) = store.putLong(KEY_HEARTBEAT, v.toLong())

    /** StatusTerakhir yang dikirim ke server via {t:'result'} atau {t:'event'}. */
    var lastAppliedAt: Long
        get() = store.getLong(KEY_APPLIED, 0L)
        set(v) = store.putLong(KEY_APPLIED, v)

    fun snapshot(): String =
        "id=$deviceId nama=$namaDevice policy=$policyState kiosk=$kioskEnabled " +
            "geofence=$geofenceArmed/${radiusM}m watchdog=${watchdogMs}ms"

    companion object {
        const val KEY_ID = "device_id"
        const val KEY_TOKEN = "device_token"
        const val KEY_WS = "ws_url"
        const val KEY_PAIR = "pair_url"
        const val KEY_NAMA = "nama_device"
        const val KEY_POLICY = "policy_state"
        const val KEY_KIOSK = "kiosk_enabled"
        const val KEY_RADIUS = "radius_meter"
        const val KEY_GEOFENCE = "geofence_armed"
        const val KEY_ANCHOR_LAT = "anchor_lat"
        const val KEY_ANCHOR_LNG = "anchor_lng"
        const val KEY_WATCHDOG = "watchdog_ms"
        const val KEY_HEARTBEAT = "heartbeat_ms"
        const val KEY_APPLIED = "last_applied_at"

        @Volatile
        private var instance: Config? = null

        fun get(context: Context): Config =
            instance ?: synchronized(this) {
                instance ?: Config(SecureStore(context.applicationContext)).also { instance = it }
            }
    }
}

enum class PolicyState {
    UNLOCKED, // normal, penyewa bebas memakai
    LOCKED, // layanewala: semua app disuspensi, kamera mati
    KIOSK, // hanya Guard yang boleh dibuka
    ;

    val isLocked: Boolean get() = this != UNLOCKED
}

private var defaultWsUrl: String = "wss://localhost/ws/v1/device"
private var defaultPairUrl: String = "https://localhost/api/enroll/pair"

/** Dipanggil sekali dari App untuk menyuntik URL bawaan dari BuildConfig. */
object DefaultEndpoints {
    fun install(ws: String, pair: String) {
        if (ws.isNotBlank()) defaultWsUrl = ws
        if (pair.isNotBlank()) defaultPairUrl = pair
    }
}