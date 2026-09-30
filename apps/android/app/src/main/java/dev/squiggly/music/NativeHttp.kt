package dev.squiggly.music

import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.cert.CertificateException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import javax.net.ssl.SSLPeerUnverifiedException

/**
 * The connector's fetch (apps/android/web/http.ts). Requests run here, outside the WebView, so
 * neither CORS nor mixed-content rules apply and a plain-HTTP home server works. Redirects are
 * never followed, bodies are capped, and failures never echo the address, which carries
 * credentials.
 */
object NativeHttp {
    private val executor = Executors.newFixedThreadPool(6)
    private val active = ConcurrentHashMap<Int, HttpURLConnection>()

    fun request(call: PluginCall) {
        val id = call.getInt("id") ?: 0
        val address = call.getString("url") ?: return call.reject("Missing address.")
        val method = call.getString("method", "GET")!!.uppercase()
        val headers = call.getObject("headers", JSObject())!!
        val body = call.getString("body")
        val timeout = (call.getInt("timeoutMs") ?: 15000).coerceIn(1000, 60000)
        val maxBytes = (call.getInt("maxBytes") ?: (9 * 1024 * 1024)).coerceIn(1024, 32 * 1024 * 1024)
        executor.execute {
            var connection: HttpURLConnection? = null
            var finished = false
            try {
                val url = URL(address)
                if (url.protocol != "https" && url.protocol != "http") throw IOException("Only HTTP and HTTPS.")
                if (method != "GET" && method != "POST") throw IOException("Only GET and POST.")
                connection = (url.openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false
                    connectTimeout = timeout
                    readTimeout = timeout
                    useCaches = false
                    requestMethod = method
                    setRequestProperty("User-Agent", userAgent)
                    for (name in headers.keys()) setRequestProperty(name, headers.getString(name))
                }
                active[id] = connection
                if (body != null) {
                    connection.doOutput = true
                    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = connection.responseCode
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                val bytes = stream?.use { read(it, maxBytes) } ?: ByteArray(0)
                val names = JSObject()
                for ((name, values) in connection.headerFields) {
                    // The status line comes back under a null name.
                    if (name != null && values != null && token.matches(name)) names.put(name, values.joinToString(", "))
                }
                finished = true
                call.resolve(JSObject().put("status", status).put("headers", names).put("body", String(bytes, Charsets.UTF_8)))
            } catch (error: Exception) {
                // An untrusted certificate is told apart (the page won't offer plain HTTP instead).
                if (untrusted(error)) call.reject("The server's certificate isn't trusted.", "CERT_UNTRUSTED")
                else call.reject("The request failed.")
            } finally {
                active.remove(id)
                // A finished response has gone back to the connection pool; only a failed one is torn down.
                if (!finished) connection?.disconnect()
            }
        }
    }

    fun cancel(id: Int) {
        active.remove(id)?.disconnect()
    }

    private fun read(stream: InputStream, maxBytes: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            if (out.size() + count > maxBytes) throw IOException("The response is too large.")
            out.write(buffer, 0, count)
        }
        return out.toByteArray()
    }

    /**
     * Keep on this device (Kept.kt): the original file into [target], a `.part` file the caller
     * renames once this returns. request() can't carry audio: it returns the body as a UTF-8 String
     * and caps it at 32 MiB. The rules are request()'s own: no redirects, the same User-Agent, 15 s
     * to connect and 30 s between reads. Only a 200 with audio is taken (Subsonic errors arrive as
     * JSON or XML with a 200), never more than [budget] bytes, and exactly as many as the server
     * said it would send. The file is synced before this returns. Failures say whether the server
     * gave no answer ([KeptUnreachable]) or answered and refused ([KeptRefused]), in words written
     * here, never with the address, which carries credentials.
     */
    fun download(address: String, target: File, budget: Long, cancelled: () -> Boolean, onBytes: (Long) -> Unit): Long {
        val url = try { URL(address) } catch (error: Exception) { throw KeptRefused("That song's address isn't valid.") }
        if (url.protocol != "https" && url.protocol != "http") throw KeptRefused("That song's address isn't valid.")
        var connection: HttpURLConnection? = null
        try {
            connection = (url.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = 15000
                readTimeout = 30000
                useCaches = false
                setRequestProperty("User-Agent", userAgent)
            }
            val status = try { connection.responseCode } catch (error: IOException) {
                if (cancelled()) throw InterruptedIOException("Stopped.")
                throw KeptUnreachable("The server didn't answer.")
            }
            if (status in 502..504) throw KeptUnreachable("The server didn't answer.")
            if (status != 200) throw KeptRefused("The server refused the song.")
            val type = connection.contentType?.substringBefore(';')?.trim()?.lowercase() ?: ""
            if (type.startsWith("text/") || type == "application/json" || type == "application/xml") throw KeptRefused("The server sent an error instead of the song.")
            val declared = connection.getHeaderField("Content-Length")?.toLongOrNull()
            if (declared != null && declared > budget) throw KeptLimit()
            var count = 0L
            FileOutputStream(target).use { out ->
                connection.inputStream.use { stream ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        if (cancelled()) throw InterruptedIOException("Stopped.")
                        val read = try { stream.read(buffer) } catch (error: IOException) {
                            if (cancelled()) throw InterruptedIOException("Stopped.")
                            throw KeptRefused("The song arrived incomplete.")
                        }
                        if (read < 0) break
                        count += read
                        if (count > budget) throw KeptLimit()
                        try { out.write(buffer, 0, read) } catch (error: IOException) { throw diskError(error) }
                        onBytes(count)
                    }
                }
                if (declared != null && declared != count) throw KeptRefused("The song arrived incomplete.")
                try { out.flush(); out.fd.sync() } catch (error: IOException) { throw diskError(error) }
            }
            return count
        } finally {
            connection?.disconnect()
        }
    }

    private fun diskError(error: IOException): IOException =
        if (error.message?.contains("ENOSPC") == true || error.message?.contains("No space left") == true) KeptDiskFull() else error

    // Another name's certificate, or one that doesn't chain to a trusted authority (self-signed,
    // expired). A server that doesn't speak TLS at all fails the handshake without either.
    private fun untrusted(error: Throwable) =
        generateSequence(error) { it.cause }.take(8).any { it is SSLPeerUnverifiedException || it is CertificateException }

    private val token = Regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
    val userAgent = "Squiggly/${BuildConfig.VERSION_NAME} (Android)"
}

/** No answer: the connection failed or timed out, or a gateway said the server is down (502 to 504). */
class KeptUnreachable(message: String) : IOException(message)
/** An answer that refused the song. */
class KeptRefused(message: String) : IOException(message)
/** The song would pass the room left for kept songs. */
class KeptLimit : IOException("Past the limit.")
/** The phone's storage filled up. */
class KeptDiskFull : IOException("No space left.")
