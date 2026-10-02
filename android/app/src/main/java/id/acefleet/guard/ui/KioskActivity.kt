package id.acefleet.guard.ui

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import id.acefleet.guard.R
import id.acefleet.guard.core.Config

/**
 * Layar kios yang muncul saat unit sedang LOCKED / KIOSK.
 *
 * Yang ditampilkan sengaja dibuat seadanya: tidak ada tombol, tidak ada
 * jalan keluar, tidak ada status bar. Navigasinya:
 *  - Di mode KIOSK, app ini dijalankan dengan `startLockTask`, jadi user
 *    tidak bisa keluar dari Guard atau membuka aplikasi lain.
 *  - Di mode LOCKED (bukan kios), layar kunci sistem yang mengunci; layar ini
 *    hanya memberitahu penyewa untuk menghubungi toko.
 */
class KioskActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (intent?.action == ACTION_CLOSE) {
            finish()
            return
        }

        // Layar penuh + tetap menyala (unit etalase / kios).
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = immersiveFlags()

        val pad = (32 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(0xFF0D1117.toInt())
        }

        root.addView(
            TextView(this).apply {
                text = getString(R.string.kiosk_title)
                textSize = 30f
                gravity = Gravity.CENTER
                setTextColor(Color.WHITE)
            },
        )
        root.addView(
            TextView(this).apply {
                text = getString(R.string.kiosk_body)
                textSize = 16f
                gravity = Gravity.CENTER
                setTextColor(Color.parseColor("#8B949E"))
                setPadding(0, pad, 0, 0)
            },
        )
        root.addView(
            TextView(this).apply {
                text = Config.get(this@KioskActivity).namaDevice
                textSize = 14f
                gravity = Gravity.CENTER
                setTextColor(Color.parseColor("#58A6FF"))
                setPadding(0, pad / 2, 0, 0)
            },
        )
        setContentView(root)
    }

    override fun onBackPressed() {
        // Tidak ada jalan keluar dari layar kios.
    }

    @Suppress("DEPRECATION")
    private fun immersiveFlags(): Int =
        View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION

    companion object {
        const val ACTION_SHOW = "id.acefleet.guard.KIOSK_SHOW"
        const val ACTION_CLOSE = "id.acefleet.guard.KIOSK_CLOSE"
    }
}