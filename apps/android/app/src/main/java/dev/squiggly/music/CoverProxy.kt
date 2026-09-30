package dev.squiggly.music

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.media3.common.util.BitmapLoader
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.ListeningExecutorService
import com.google.common.util.concurrent.MoreExecutors
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Cover art for the page and the media notification. The page asks for
 * https://localhost/api/cover?id=…&size=… (the browser build's address, so components are the
 * same everywhere); this answers from a disk cache or fetches getCoverArt with the account's
 * credentials, which never reach the page. The notification's artwork URIs name only the cover
 * (squiggly-cover://art?id=…), since other apps can read a media session's metadata.
 */
object CoverProxy {
    private const val MAX_BYTES = 6 * 1024 * 1024
    private const val CACHE_BYTES = 64L * 1024 * 1024
    private const val MAX_AGE_MS = 30L * 24 * 60 * 60 * 1000
    // A few megabytes can describe an image of billions of pixels, and even a shrunk decode reads
    // every one. Covers bigger than this aren't decoded for the notification.
    private const val MAX_PIXELS = 8192L * 8192
    private val types = listOf("image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/bmp")

    @Volatile private var base: String? = null
    @Volatile private var account: String? = null
    private var directory: File? = null
    // Writes to the cache take turns, so the running total of its bytes stays true.
    private val cacheLock = Any()
    private var cached = 0L

    fun init(context: Context) {
        if (directory != null) return
        val dir = File(context.cacheDir, "covers").apply { mkdirs() }
        directory = dir
        Thread { synchronized(cacheLock) { trim(dir) } }.start()
    }

    /** The authenticated getCoverArt address without id and size, and a name for the account. */
    fun setServer(coverBase: String?, key: String?) {
        base = coverBase
        account = key
    }

    fun artworkUri(coverArt: String): Uri = Uri.Builder().scheme("squiggly-cover").authority("art").appendQueryParameter("id", coverArt).build()

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (url.scheme != "https" || url.host != "localhost" || url.path != "/api/cover") return null
        val id = url.getQueryParameter("id")
        val size = url.getQueryParameter("size")?.toIntOrNull()
        if (id.isNullOrEmpty() || id.length > 256 || size == null) return empty(400, "Bad Request")
        val cover = load(id, size) ?: return empty(404, "Not Found")
        return WebResourceResponse(cover.first, null, 200, "OK", mapOf("Cache-Control" to "private, max-age=86400"), ByteArrayInputStream(cover.second))
    }

    /** The cover's type and bytes, from the cache or the server. Blocks; call off the main thread. */
    fun load(id: String, requested: Int): Pair<String, ByteArray>? {
        // A kept cover first: it works with the server away, and saves asking.
        Kept.coverFor(id)?.let { return it }
        val server = base ?: return null
        val size = requested.coerceIn(32, 1200)
        val file = directory?.let { File(it, digest("$account\n$id\n$size")) }
        if (file != null && file.isFile && System.currentTimeMillis() - file.lastModified() < MAX_AGE_MS) {
            runCatching { file.readBytes() }.getOrNull()?.let { stored ->
                if (stored.size > 1 && stored[0].toInt() in types.indices) return types[stored[0].toInt()] to stored.copyOfRange(1, stored.size)
            }
        }
        val fetched = fetch("$server&id=${URLEncoder.encode(id, "UTF-8")}&size=$size") ?: return null
        if (file != null && server == base) store(file, byteArrayOf(types.indexOf(fetched.first).toByte()) + fetched.second)
        return fetched
    }

    // Through a .part file, so a reader never sees half a cover. The total counts both files
    // before and after, then trims if this write took the cache past its limit.
    private fun store(file: File, bytes: ByteArray) {
        val dir = file.parentFile ?: return
        synchronized(cacheLock) {
            val temporary = File(dir, "${file.name}.part")
            val before = file.length() + temporary.length()
            val stored = runCatching { temporary.writeBytes(bytes); temporary.renameTo(file) }.getOrDefault(false)
            if (!stored) temporary.delete()
            cached += file.length() + temporary.length() - before
            if (cached > CACHE_BYTES) trim(dir)
        }
    }

    private fun fetch(address: String): Pair<String, ByteArray>? {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(address).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = 15000
                readTimeout = 15000
                setRequestProperty("User-Agent", NativeHttp.userAgent)
            }
            // Failures arrive as a JSON envelope with HTTP 200; only images pass.
            val type = connection.contentType?.substringBefore(';')?.trim()?.lowercase()
            if (connection.responseCode != 200 || type == null || type !in types) throw IOException("Not a cover.")
            val out = ByteArrayOutputStream()
            connection.inputStream.use { stream ->
                val buffer = ByteArray(16 * 1024)
                while (true) {
                    val count = stream.read(buffer)
                    if (count < 0) break
                    if (out.size() + count > MAX_BYTES) throw IOException("Cover too large.")
                    out.write(buffer, 0, count)
                }
            }
            type to out.toByteArray()
        } catch (error: Exception) {
            connection?.disconnect()
            null
        }
    }

    // Oldest first, down to three quarters of the limit once the cache passes it, and counts
    // what's left. Hold cacheLock.
    private fun trim(dir: File) {
        val files = dir.listFiles()?.filter { it.isFile } ?: return
        var total = files.sumOf { it.length() }
        if (total > CACHE_BYTES) for (file in files.sortedBy { it.lastModified() }) {
            if (total <= CACHE_BYTES * 3 / 4) break
            val length = file.length()
            if (file.delete()) total -= length
        }
        cached = total
    }

    // The notification shows a cover at a few hundred pixels. Read the size first, refuse an
    // image too big to decode, and decode the rest shrunk by powers of two until its longer side
    // is under twice the size asked for.
    private fun decode(bytes: ByteArray, size: Int): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val longer = maxOf(bounds.outWidth, bounds.outHeight)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth.toLong() * bounds.outHeight > MAX_PIXELS) throw IOException("Unreadable cover.")
        var sample = 1
        while (longer / (sample * 2) >= size) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: throw IOException("Unreadable cover.")
    }

    private fun empty(status: Int, reason: String) =
        WebResourceResponse("text/plain", "utf-8", status, reason, emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun digest(text: String) =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

    /** Media3's artwork loader, with squiggly-cover URIs answered from here. */
    class Bitmaps(private val fallback: BitmapLoader) : BitmapLoader {
        private val executor: ListeningExecutorService = MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor())
        override fun supportsMimeType(mimeType: String) = fallback.supportsMimeType(mimeType)
        override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> = fallback.decodeBitmap(data)
        override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> {
            if (uri.scheme != "squiggly-cover") return fallback.loadBitmap(uri)
            return executor.submit<Bitmap> {
                val bytes = load(uri.getQueryParameter("id") ?: throw IOException("No cover."), 512)?.second ?: throw IOException("No cover.")
                decode(bytes, 512)
            }
        }
    }
}
