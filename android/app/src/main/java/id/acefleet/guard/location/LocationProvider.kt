package id.acefleet.guard.location

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import android.util.Log
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import id.acefleet.guard.Logs
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import kotlin.coroutines.resume

/**
 * Pengambilan lokasi.
 *
 * Strategi sah tanpa illicit permission:
 *  - Guard berjalan sebagai foreground service bertipe `location` dengan
 *    notifikasi terlihat, jadi provider lokasi boleh diakses terus-menerus.
 *  - Izin runtime (FINE/COARSE/BACKGROUND/CAMERA) diberikan otomatis oleh
 *    Device Owner lewat DevicePolicyManager.setPermissionGrantState, sehingga
 *    tidak ada dialog yang bisa diketuk penyewa.
 *
 * Batas jujur: Android TIDAK memberi API lokasi IMEI atau lokasi saat device
 * dimatikan total. Yang bisa dilacak adalah posisi terakhir saat online.
 */
class LocationProvider(private val ctx: Context) {

    private val client: FusedLocationProviderClient =
        LocationServices.getFusedLocationProviderClient(ctx)

    fun hasPermission(): Boolean =
        ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ctx.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** Titik tunggal berakurasi tinggi (dipakai command `locate`). */
    @SuppressLint("MissingPermission")
    suspend fun current(highAccuracy: Boolean = true): Loc? {
        if (!hasPermission()) {
            Logs.w(TAG, "lokasi ditolak: izin belum diberikan")
            return null
        }
        return try {
            val priority = if (highAccuracy) {
                Priority.PRIORITY_HIGH_ACCURACY
            } else {
                Priority.PRIORITY_BALANCED_POWER_ACCURACY
            }
            val cts = CancellationTokenSource()
            val loc = suspendCancellableCoroutine<Location?> { cont ->
                client.getCurrentLocation(priority, cts.token)
                    .addOnSuccessListener { cont.resume(it) }
                    .addOnFailureListener {
                        Log.w(TAG, "getCurrentLocation gagal: ${it.message}")
                        cont.resume(null)
                    }
            }
            loc?.toLoc()
        } catch (e: Exception) {
            Log.w(TAG, "current(): ${e.message}")
            null
        }
    }

    /** Titik terakhir yang diketahui - dipakai saat masih cooldown/GPS dingin. */
    @SuppressLint("MissingPermission")
    suspend fun lastKnown(): Loc? = try {
        if (!hasPermission()) {
            null
        } else {
            suspendCancellableCoroutine { cont ->
                client.lastLocation
                    .addOnSuccessListener { cont.resume(it?.toLoc()) }
                    .addOnFailureListener { cont.resume(null) }
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "lastKnown(): ${e.message}")
        null
    }

    /**
     * Bentuk wire yang dipakai server. Field-nya persis dengan yang dibaca
     * `handleLocation()` di `src/net/hub.js`.
     */
    data class Loc(
        val lat: Double,
        val lng: Double,
        val accuracy: Float?,
        val altitude: Double?,
        val speed: Float?,
        val source: String,
        val ts: String,
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("lat", lat)
            put("lng", lng)
            put("accuracy", accuracy ?: JSONObject.NULL)
            put("altitude", altitude ?: JSONObject.NULL)
            put("speed", speed ?: JSONObject.NULL)
            put("source", source)
            put("ts", ts)
        }
    }

    companion object {
        const val TAG = "Location"
    }
}

/**
 * Konversi ke model Guard. Sengaja top-level (bukan di dalam companion object)
 * supaya bisa dipanggil dari mana saja tanpa qualification.
 */
fun Location.toLoc(): LocationProvider.Loc = LocationProvider.Loc(
    lat = latitude,
    lng = longitude,
    accuracy = if (hasAccuracy()) accuracy else null,
    altitude = if (hasAltitude()) altitude else null,
    speed = if (hasSpeed()) speed else null,
    source = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && isMock -> "mock"
        !provider.isNullOrEmpty() -> provider.orEmpty()
        else -> "fused"
    },
    ts = java.time.Instant.ofEpochMilli(time).toString(),
)