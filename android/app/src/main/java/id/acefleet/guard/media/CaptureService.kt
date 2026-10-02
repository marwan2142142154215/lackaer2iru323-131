package id.acefleet.guard.media

import android.app.Notification
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.ResultReceiver
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import id.acefleet.guard.App
import id.acefleet.guard.Logs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Layanan sekali-pakai untuk ambil satu foto (kamera depan / belakang).
 *
 * CameraX butuh LifecycleOwner, jadi foto diambil lewat service berumur pendek.
 * Hasil dikembalikan ke pemanggil lewat [ResultReceiver] dengan bundel berisi
 * JPEG (quality 60, maksimal ~1.5 MB supaya muat dalam WSS frame 6 MB).
 */
class CaptureService : LifecycleService() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        val front = intent?.getBooleanExtra(EXTRA_FRONT, false) ?: false
        val receiver = intent?.getParcelableExtra<android.os.Parcelable>(EXTRA_RECEIVER) as? ResultReceiver
        startForeground(NOTIF_ID, notification())
        lifecycleScope.launch {
            val result = runCatching { capture(front) }
            result.onSuccess { bytes ->
                receiver?.send(
                    RESULT_OK,
                    Bundle().apply { putByteArray(EXTRA_BYTES, bytes) },
                )
            }.onFailure {
                Logs.e(TAG, "capture gagal: ${it.message}", it)
                receiver?.send(RESULT_ERROR, Bundle().apply { putString(EXTRA_ERROR, it.message) })
            }
            stopSelf(startId)
        }
        return START_NOT_STICKY
    }

    private fun notification(): Notification =
        androidx.core.app.NotificationCompat.Builder(this, App.CHANNEL_ID)
            .setContentTitle("Fleet Guard")
            .setContentText("Mengambil foto…")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()

    private suspend fun capture(front: Boolean): ByteArray = withContext(Dispatchers.Main) {
        val provider = awaitProvider()
        val selector =
            if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
        require(provider.hasCamera(selector)) { "kamera tidak tersedia di perangkat" }

        val ic = ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setJpegQuality(60)
            .build()
        // Preview dummy supaya pipeline berjalan di perangkat tanpa preview UI.
        val preview = Preview.Builder().build()
        provider.unbindAll()
        // Penting: di dalam withContext, `this` berarti CoroutineScope, bukan
        // service. bindToLifecycle butuh LifecycleOwner, jadi harus disebut
        // eksplisit sebagai this@CaptureService (yangextends LifecycleService).
        provider.bindToLifecycle(this@CaptureService, selector, ic, preview)

        suspendCancellableCoroutine { cont ->
            val cb = object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(image: ImageProxy) {
                    try {
                        val buf = image.planes[0].buffer
                        val bytes = ByteArray(buf.remaining())
                        buf.get(bytes)
                        image.close()
                        cont.resume(compress(bytes))
                    } catch (e: Exception) {
                        image.close()
                        cont.resumeWithException(e)
                    }
                }

                override fun onError(e: ImageCaptureException) {
                    cont.resumeWithException(IllegalStateException("kamera: ${e.message}", e))
                }
            }
            // Urutan parameter CameraX: (Executor, OnImageCapturedCallback).
            ic.takePicture(ContextCompat.getMainExecutor(this@CaptureService), cb)
        }
    }

    /** JPEG -> JPEG (rekompresi kecil) supaya frame tidak terlalu besar. */
    private fun compress(jpeg: ByteArray): ByteArray {
        val bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) ?: return jpeg
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 60, out)
        bmp.recycle()
        return out.toByteArray()
    }

    private suspend fun awaitProvider(): ProcessCameraProvider =
        suspendCancellableCoroutine { cont ->
            val f = ProcessCameraProvider.getInstance(this)
            f.addListener({
                try {
                    cont.resume(f.get())
                } catch (e: Exception) {
                    cont.resumeWithException(e)
                }
            }, ContextCompat.getMainExecutor(this))
        }

    companion object {
        const val TAG = "Capture"
        const val EXTRA_FRONT = "front"
        const val EXTRA_RECEIVER = "receiver"
        const val EXTRA_BYTES = "bytes"
        const val EXTRA_ERROR = "error"
        const val RESULT_OK = 1
        const val RESULT_ERROR = 2
        const val NOTIF_ID = 42

        fun hasCameraPermission(ctx: Context): Boolean =
            ctx.checkSelfPermission(android.Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED

        /**
         * Panggil dari service/command executor. Callback dipanggil di thread
         * apa pun - pemanggil wajib menanganinya dengan benar.
         */
        @Suppress("unused")
        fun snapshot(
            ctx: Context,
            front: Boolean,
            onResult: (Result<ByteArray>) -> Unit,
            timeoutMs: Long = 25_000,
        ) {
            val rc = object : ResultReceiver(null) {
                override fun onReceiveResult(resultCode: Int, data: Bundle?) {
                    // getByteArray() nullable, sedangkan onResult butuh Result<ByteArray>
                    // (non-null). Angkat null-check ke sini.
                    val bytes = data?.getByteArray(EXTRA_BYTES)
                    if (resultCode == RESULT_OK && bytes != null) {
                        onResult(Result.success(bytes))
                    } else {
                        onResult(Result.failure(IllegalStateException(data?.getString(EXTRA_ERROR) ?: "gagal")))
                    }
                }
            }
            val i = Intent(ctx, CaptureService::class.java)
                .putExtra(EXTRA_FRONT, front)
                .putExtra(EXTRA_RECEIVER, rc)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(i)
                } else {
                    ctx.startService(i)
                }
            } catch (e: Exception) {
                Log.w(TAG, "startForegroundService ditolak: ${e.message}")
                onResult(Result.failure(e))
            }
        }
    }
}