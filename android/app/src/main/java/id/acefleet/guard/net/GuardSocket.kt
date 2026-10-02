package id.acefleet.guard.net

import android.util.Base64
import id.acefleet.guard.Logs
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.Socket
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.SSLSocket

/**
 * Klien WebSocket device ke server broker.
 *
 * Ditulis tanpa dependency WebSocket eksternal: yang dipakai hanya
 * `javax.net.ssl.SSLSocket` + framing RFC 6455 yang sangat sederhana
 * (teks saja, tanpa frame terfragmentasi dari server). Alasannya APK tetap
 * ramping dan surfaceWare yang belum dipercaya (library pihak ketiga)
 * sekecil mungkin - Guard memegang Device Owner dan kunci semua unit.
 *
 * Handshake-nya persis sama dengan sisi server:
 *
 *   S->D  {"t":"challenge","nonce":"..."}
 *   D->S  {"t":"auth","deviceId":"...","nonce":"...","tag":"hex(HMAC-SHA256(token, nonce+'.'+deviceId))"}
 *   S->D  {"t":"welcome",...} | {"t":"cmd",...} | {"t":"ping"} | {"t":"sync"}
 *
 * Catatan implementasi yang penting:
 *  - Body frame dibaca dari InputStream (bukan Reader). Membaca lewat
 *    InputStreamReader akan merusak byte non-UTF8 saat mask diterapkan.
 *  - Reader hanya dipakai untuk blok header HTTP saat handshake.
 *  - Token device tidak pernah keluar perangkat dalam bentuk mentah.
 */
class GuardSocket(
    private val url: String,
    private val deviceId: String,
    private val token: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onOpen()
        fun onAuthenticated(welcome: JSONObject)
        fun onFrame(frame: JSONObject)
        fun onClosed(reason: String)
    }

    private var sock: Socket? = null
    private var out: OutputStream? = null
    private var input: InputStream? = null

    @Volatile
    var running = false
        private set

    @Synchronized
    fun start() {
        if (running) return
        running = true
        Thread({ ioLoop() }, "guard-ws").apply { isDaemon = true }.start()
    }

    @Synchronized
    fun stop() {
        running = false
        runCatching { sock?.close() }
        sock = null
    }

    fun send(frame: JSONObject): Boolean = sendText(frame.toString())

    // writeFrame tidak mengembalikan status, jadi suksesnya ditentukan dari
    // tidak adanya exception.
    private fun sendText(text: String): Boolean = try {
        writeFrame(OP_TEXT, text.toByteArray(Charsets.UTF_8))
        true
    } catch (e: Exception) {
        Logs.w(TAG, "send gagal: ${e.message}")
        false
    }

    // --------------------------------------------------------------- IO ----
    private fun ioLoop() {
        var backoff = 1_000L
        while (running) {
            try {
                connectAndRead()
                backoff = 1_000L
            } catch (e: Exception) {
                if (running) {
                    Logs.w(TAG, "ws error: ${e.message}")
                    listener.onClosed(e.message ?: "error")
                }
            } finally {
                runCatching { sock?.close() }
                sock = null
                out = null
                input = null
            }
            if (!running) break
            try {
                Thread.sleep(backoff)
            } catch (_: InterruptedException) {
                return
            }
            backoff = (backoff * 2).coerceAtMost(MAX_BACKOFF_MS)
        }
    }

    private fun connectAndRead() {
        val u = URI(url)
        check(u.scheme.equals("wss", ignoreCase = true)) {
            "hanya wss:// yang diizinkan (dapat ${u.scheme})"
        }
        val port = if (u.port > 0) u.port else 443

        val s = SSLSocketFactoryHolder.create(u.host, port)
        s.tcpNoDelay = true
        s.soTimeout = 0 // read blocking; keepalive ditangani server lewat ping
        s.startHandshake()
        sock = s
        out = s.getOutputStream()
        val raw = BufferedInputStream(s.getInputStream(), 32 * 1024)
        input = raw

        handshake(u, raw)
        listener.onOpen()
        readLoop(raw)
    }

    private fun handshake(u: URI, raw: InputStream) {
        val keyBytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val key = Base64.encodeToString(keyBytes, Base64.NO_WRAP)
        val path = (u.rawPath ?: "/").ifEmpty { "/" } + (u.rawQuery?.let { "?$it" } ?: "")
        val host = if (u.port > 0 && u.port != 443) "${u.host}:${u.port}" else u.host
        val req = buildString {
            append("GET $path HTTP/1.1\r\n")
            append("Host: $host\r\n")
            append("Upgrade: websocket\r\n")
            append("Connection: Upgrade\r\n")
            append("Sec-WebSocket-Key: $key\r\n")
            append("Sec-WebSocket-Protocol: $PROTOCOL\r\n")
            append("Sec-WebSocket-Version: 13\r\n")
            append("\r\n")
        }
        out?.write(req.toByteArray(Charsets.US_ASCII))
        out?.flush()

        // Header HTTP dibaca lewat reader terpisah; setelah baris kosong
        // server belum mengirim frame apa pun, jadi tidak ada byte yang hilang.
        val reader = BufferedReader(InputStreamReader(raw, Charsets.US_ASCII))
        val status = reader.readLine() ?: error("tidak ada respons handshake")
        check(status.contains(" 101")) { "upgrade ditolak: $status" }
        while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
        }
    }

    private fun readLoop(raw: InputStream) {
        while (running) {
            val b0 = raw.read()
            if (b0 < 0) error("socket ditutup server")
            val opcode = b0 and 0x0F
            val masked = (b0 and 0x80) != 0
            var len = raw.read()
            if (len < 0) error("stream terputus")
            len = len and 0xFF
            if (len == 126) {
                val a = raw.read()
                val b = raw.read()
                if (a < 0 || b < 0) error("stream terputus")
                len = (a shl 8) or b
            } else if (len == 127) {
                var big = 0L
                repeat(8) {
                    val b = raw.read()
                    if (b < 0) error("stream terputus")
                    big = (big shl 8) or b.toLong()
                }
                if (big > MAX_FRAME.toLong()) error("frame terlalu besar: $big")
                len = big.toInt()
            }
            if (len > MAX_FRAME) error("frame terlalu besar: $len")

            val mask = if (masked) ByteArray(4).also { readFully(raw, it) } else null
            val payload = ByteArray(len).also { if (len > 0) readFully(raw, it) }
            if (mask != null) {
                for (i in payload.indices) {
                    payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
                }
            }

            when (opcode) {
                OP_CLOSE -> error("server menutup koneksi (code ${payload.size})")
                OP_PING -> writeFrame(OP_PONG, ByteArray(0))
                OP_PONG -> Unit
                OP_TEXT -> onText(String(payload, Charsets.UTF_8))
                else -> Unit // binary/continuation diabaikan; server hanya kirim teks
            }
        }
    }

    private fun onText(text: String) {
        val frame = try {
            JSONObject(text)
        } catch (e: Exception) {
            Logs.w(TAG, "frame bukan JSON, diabaikan: ${text.take(120)}")
            return
        }
        when (frame.optString("t")) {
            "challenge" -> {
                val nonce = frame.optString("nonce")
                if (nonce.isEmpty()) {
                    Logs.w(TAG, "challenge tanpa nonce")
                    return
                }
                sendText(authFrame(nonce).toString())
            }

            "welcome" -> listener.onAuthenticated(frame)
            else -> listener.onFrame(frame)
        }
    }

    private fun readFully(raw: InputStream, buf: ByteArray) {
        var off = 0
        while (off < buf.size) {
            val n = raw.read(buf, off, buf.size - off)
            if (n < 0) error("stream terputus")
            off += n
        }
    }

    private fun writeFrame(opcode: Int, payload: ByteArray) {
        val o = out ?: error("belum terhubung")
        synchronized(o) {
            o.write(0x80 or opcode)
            when {
                payload.size < 126 -> o.write(payload.size)
                payload.size <= 0xFFFF -> {
                    o.write(126)
                    o.write((payload.size shr 8) and 0xFF)
                    o.write(payload.size and 0xFF)
                }

                else -> {
                    o.write(127)
                    val big = payload.size.toLong()
                    for (i in 7 downTo 0) o.write(((big shr (8 * i)) and 0xFF).toInt())
                }
            }
            o.write(payload)
            o.flush()
        }
    }

    private fun authFrame(nonce: String): JSONObject = JSONObject().apply {
        put("t", "auth")
        put("deviceId", deviceId)
        put("nonce", nonce)
        put("tag", deviceTag(token, nonce, deviceId))
    }

    companion object {
        const val TAG = "Socket"
        const val PROTOCOL = "fleetguard.v1"

        /** 6 MB: foto JPEG 1,5 MB menjadi ~2 MB base64, masih aman. */
        const val MAX_FRAME = 6 * 1024 * 1024
        private const val MAX_BACKOFF_MS = 30_000L

        private const val OP_CONT = 0x0
        private const val OP_TEXT = 0x1
        private const val OP_BINARY = 0x2
        private const val OP_CLOSE = 0x8
        private const val OP_PING = 0x9
        private const val OP_PONG = 0xA

        /**
         * Persis sama dengan deviceTag() di sisi server:
         * hex(HMAC-SHA256(token, "<nonce>.<deviceId>")).
         */
        fun deviceTag(token: String, nonce: String, deviceId: String): String {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(token.toByteArray(Charsets.UTF_8), "HmacSHA256"))
            return mac.doFinal("$nonce.$deviceId".toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
        }

        fun sha256(b: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

        /** Dipisah supaya titik integrasi TLS mudah diuji/diganti. */
        private object SSLSocketFactoryHolder {
            fun create(host: String, port: Int): SSLSocket =
                javax.net.ssl.SSLSocketFactory.getDefault().createSocket(host, port) as SSLSocket
        }
    }
}