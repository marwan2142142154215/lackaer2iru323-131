package id.acefleet.guard.core

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Penyimpanan rahasia berbasis Android Keystore.
 *
 * Kunci AES-GCM dibuat di dalam AndroidKeyStore (TEE pada sebagian besar
 * perangkat, tidak bisa diekspor). Yang disimpan di SharedPreferences hanya
 * ciphertext + IV, sehingga:
 *   - file preferences yang dicabut tidak langsung memberi token device,
 *   - token tidak pernah ada di dalam APK atau log,
 *   - dipulihkan otomatis setelah factory reset bila di-backup (tidak happening:
 *     backup dimatikan; setelah reset device harus pairing ulang via kode).
 */
class SecureStore(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("guard_secure", Context.MODE_PRIVATE)

    private val keyAlias = "fleet_guard_key_v1"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(keyAlias, null) as? KeyStore.SecretKeyEntry)?.secretKey?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return gen.generateKey()
    }

    fun put(name: String, value: String?) {
        if (value.isNullOrEmpty()) {
            prefs.edit().remove(name).apply()
            return
        }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val ct = c.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString("$name.iv", Base64.encodeToString(c.iv, Base64.NO_WRAP))
            .putString("$name.ct", Base64.encodeToString(ct, Base64.NO_WRAP))
            .apply()
    }

    fun get(name: String, def: String? = null): String? =
        runCatching {
            val iv = prefs.getString("$name.iv", null) ?: return def
            val ct = prefs.getString("$name.ct", null) ?: return def
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(
                Cipher.DECRYPT_MODE,
                key(),
                GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
            )
            String(c.doFinal(Base64.decode(ct, Base64.NO_WRAP)), Charsets.UTF_8)
        }.getOrDefault(def)

    /** Hapus seluruh rahasia (dipakai /hapus_data dan saat pairing gagal). */
    fun wipeSecrets() {
        prefs.edit().clear().apply()
        runCatching {
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(keyAlias)
        }
    }

    fun putPlain(name: String, value: String) = prefs.edit().putString(name, value).apply()
    fun getPlain(name: String, def: String = ""): String = prefs.getString(name, def) ?: def
    fun putLong(name: String, value: Long) = prefs.edit().putLong(name, value).apply()
    fun getLong(name: String, def: Long = 0L): Long = prefs.getLong(name, def)
    fun putBool(name: String, value: Boolean) = prefs.edit().putBoolean(name, value).apply()
    fun getBool(name: String, def: Boolean = false): Boolean = prefs.getBoolean(name, def)
}