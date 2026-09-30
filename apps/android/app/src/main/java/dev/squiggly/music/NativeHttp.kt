package dev.squiggly.music

import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
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

    // Another name's certificate, or one that doesn't chain to a trusted authority (self-signed,
    // expired). A server that doesn't speak TLS at all fails the handshake without either.
    private fun untrusted(error: Throwable) =
        generateSequence(error) { it.cause }.take(8).any { it is SSLPeerUnverifiedException || it is CertificateException }

    private val token = Regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
    val userAgent = "Squiggly/${BuildConfig.VERSION_NAME} (Android)"
}
