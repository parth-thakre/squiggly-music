package dev.squiggly.music

import android.content.Context
import android.util.AtomicFile
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Keep on this device, on the phone: songs' original files in filesDir/kept, one file per song
 * and cover, and the index beside them (index.json). Native code owns the index, not the page,
 * because the player has to find kept files while the page is asleep or gone (Playback.items).
 *
 * The index has the desktop's shape and bounds (packages/core/kept.ts; tests/fixtures/
 * kept-index.json shows it). Two orders are never broken: a file is written, synced, and renamed
 * before its entry exists, and an entry is gone (and the index written) before its file is
 * deleted. Only names matching [FILE] and partial files are ever deleted. The index holds no
 * addresses or credentials: song addresses live in the running keep's memory only.
 *
 * Everything that touches the index runs on one thread ("kept-index"); downloads run two at a
 * time on their own threads and hand their results back to it.
 */
object Kept {
    // packages/core/kept.ts, KEPT_LIMITS.
    private const val MAX_SONGS = 20_000
    private const val MAX_CONTAINERS = 2_000
    private const val MAX_TRACKS = 5_000
    private const val MAX_COVERS = 5_000
    private const val TRACK_JSON_BYTES = 16 * 1024
    private const val NAME_CHARS = 256
    private const val READ_BYTES = 32L * 1024 * 1024
    private const val WRITE_BUDGET = 24L * 1024 * 1024
    private const val COVERS_PER_JOB = 200
    private const val HEADROOM = 256L * 1024 * 1024
    private const val COVER_ESTIMATE = 150L * 1024
    private const val ENTRY_OVERHEAD = 200L
    private const val MB = 1024L * 1024
    private val FILE = Regex("^[sc]-[0-9a-f]{32}\\.[a-z0-9]{1,8}$")
    private val KINDS = setOf("album", "playlist", "mix")
    private val COVER_TYPES = mapOf("image/jpeg" to "jpg", "image/png" to "png", "image/webp" to "webp", "image/gif" to "gif", "image/avif" to "avif", "image/bmp" to "bmp")
    private val SUFFIXES = mapOf(
        "audio/flac" to "flac", "audio/x-flac" to "flac", "audio/mpeg" to "mp3", "audio/mp3" to "mp3", "audio/mp4" to "m4a", "audio/x-m4a" to "m4a",
        "audio/ogg" to "ogg", "application/ogg" to "ogg", "audio/opus" to "opus", "audio/wav" to "wav", "audio/x-wav" to "wav", "audio/wave" to "wav",
        "audio/aiff" to "aiff", "audio/x-aiff" to "aiff", "audio/x-dsf" to "dsf", "audio/x-dff" to "dff", "audio/x-ape" to "ape", "audio/x-wavpack" to "wv",
    )

    // packages/core/kept.ts, KEPT_MESSAGES, with "phone" for the device.
    private const val AWAY = "Your server is out of reach. Keeping needs it."
    private const val INVALID = "That keep request isn't valid."
    private const val TOO_MANY = "Squiggly keeps up to 20,000 songs on a device. Forget something kept first."
    private const val INDEX_FULL = "The list of kept songs is full. Forget something kept first."
    private const val NO_DISK = "There isn't enough free space on this phone to keep these songs."
    private const val BROKEN = "The list of kept songs couldn't be read, so they were cleared."
    private const val UNKNOWN = "That isn't kept on this device."
    private fun thousands(n: Long) = String.format(java.util.Locale.US, "%,d", n)
    private fun formatBytes(bytes: Long): String {
        if (bytes <= 0) return "0 MB"
        val mb = bytes.toDouble() / MB
        if (mb < 1) return "under 1 MB"
        if (mb < 1024) return "${thousands(Math.round(mb))} MB"
        return String.format(java.util.Locale.US, "%,.1f GB", mb / 1024)
    }
    private fun limitMessage(songs: Int, needed: Long, free: Long, limitMb: Long) =
        "Keeping ${if (songs == 1) "this song" else "these ${thousands(songs.toLong())} songs"} needs about ${formatBytes(needed)}, and ${formatBytes(maxOf(0, free))} of the ${thousands(limitMb)} MB limit is free. Raise the limit in Settings, or forget something kept first."
    private fun diskFull(done: Int, total: Int) = "The disk filled up after $done of $total songs. Free some space and keep again."
    private fun limitReached(limitMb: Long, done: Int, total: Int) = "The kept songs reached the ${thousands(limitMb)} MB limit after $done of $total songs."
    private fun stoppedAnswering(done: Int, total: Int) = "The server stopped answering after $done of $total songs. Keep again to fetch the rest."
    private fun failedSongs(count: Int) = if (count == 1) "One song couldn't be kept." else "${thousands(count.toLong())} songs couldn't be kept."

    class Song(val track: String, val coverArt: String?, val file: String, val bytes: Long, val keptAt: Long)
    private class Cover(val file: String, val bytes: Long, val type: String, val keptAt: Long)
    private class Container(val kind: String, val id: String, val name: String, val artist: String?, val coverArt: String?, val trackIds: List<String>, val keptAt: Long)
    private class Pending(val id: String, val url: String, val track: String, val coverArt: String?, val size: Long?)
    private class Job(val kind: String, val id: String) {
        var name = ""; var done = 0; var total = 0; var failed = 0; var state = "waiting"; var error: String? = null
        var songs = ArrayDeque<Pending>(); var covers = ArrayDeque<String>()
        val attempts = HashMap<String, Int>()
        var working = 0; var songsWorking = 0; var estimate = 0L; var pauses = 0; var limit = 0L
        val stops = HashSet<() -> Unit>()
        @Volatile var cancelled = false
    }

    @Volatile private var dir: File? = null
    private val worker = ScheduledThreadPoolExecutor(1) { Thread(it, "kept-index") }
    private val downloads = Executors.newFixedThreadPool(2) { Thread(it, "kept-download") }

    /** Kept songs, republished by the index thread after every change, for the player's thread. */
    @Volatile private var present: Map<String, Song> = emptyMap()
    @Volatile private var coversNow: Map<String, Cover> = emptyMap()

    // The index thread's own state.
    private var account: String? = null
    private val songs = LinkedHashMap<String, Song>()
    private val covers = LinkedHashMap<String, Cover>()
    private val containers = ArrayList<Container>()
    private val jobs = ArrayList<Job>()
    private val downloading = HashSet<String>()
    private var running = 0
    private var revision = 0
    private var notice: String? = null
    private var usedBytes = 0L
    private var indexBytes = 0L
    private var dirty = false
    private var writeScheduled = false
    private var lastWrite = 0L
    private var notifyScheduled = false
    private var lastNotify = 0L

    /** Gets every progress report (throttled to 250 ms) while a page listens. */
    @Volatile var listener: ((JSObject) -> Unit)? = null

    /** Idempotent. Loads on the index thread; plugin calls queue behind the load. */
    @Synchronized fun init(context: Context) {
        if (dir != null) return
        val folder = File(context.filesDir, "kept").apply { mkdirs() }
        dir = folder
        worker.execute { load(folder) }
    }

    // Reading ------------------------------------------------------------------------------------

    private fun load(folder: File) {
        val path = File(folder, "index.json")
        var broken = false
        var root: JSONObject? = null
        try {
            if (path.exists() || File(folder, "index.json.bak").exists()) {
                val file = AtomicFile(path)
                if (file.baseFile.length() > READ_BYTES) broken = true
                else root = JSONObject(String(file.readFully(), Charsets.UTF_8))
            }
        } catch (error: Exception) { broken = true }
        if (root != null && (root.optInt("version") != 1 || root.optJSONObject("songs") == null || root.optJSONArray("containers") == null || root.optJSONObject("covers") == null)) broken = true
        if (!broken && root != null) decode(root, folder)
        if (broken) {
            path.renameTo(File(folder, "index.broken.json"))
            notice = BROKEN
            write()
        }
        recount()
        revision++
        sweep(folder)
        publish()
    }

    // Entry by entry: one bad entry is dropped, the rest stay.
    private fun decode(root: JSONObject, folder: File) {
        account = if (root.isNull("account")) null else root.optString("account").takeIf { it.length <= 2048 }
        val found = ArrayList<Pair<String, Song>>()
        val list = root.getJSONObject("songs")
        for (id in list.keys()) {
            val entry = list.optJSONObject(id) ?: continue
            val track = entry.optJSONObject("track") ?: continue
            val json = track.toString()
            val file = entry.optString("file"); val bytes = entry.optLong("bytes", -1)
            if (id.isEmpty() || id.length > 256 || track.optString("id") != id || track.optString("source") != "navidrome" || json.toByteArray().size > TRACK_JSON_BYTES) continue
            if (!present(folder, file, bytes)) continue
            val coverArt = if (track.isNull("coverArt")) null else track.optString("coverArt").takeIf { it.isNotEmpty() }
            found += id to Song(json, coverArt, file, bytes, entry.optLong("keptAt"))
        }
        found.sortByDescending { it.second.keptAt }
        for ((id, song) in found.take(MAX_SONGS)) songs[id] = song
        val coverList = root.getJSONObject("covers")
        val foundCovers = ArrayList<Pair<String, Cover>>()
        for (id in coverList.keys()) {
            val entry = coverList.optJSONObject(id) ?: continue
            val type = entry.optString("type")
            if (id.isEmpty() || id.length > 256 || type !in COVER_TYPES || !present(folder, entry.optString("file"), entry.optLong("bytes", -1))) continue
            foundCovers += id to Cover(entry.optString("file"), entry.optLong("bytes"), type, entry.optLong("keptAt"))
        }
        foundCovers.sortByDescending { it.second.keptAt }
        for ((id, cover) in foundCovers.take(MAX_COVERS)) covers[id] = cover
        val array = root.getJSONArray("containers")
        val seen = HashSet<String>()
        for (i in 0 until minOf(array.length(), MAX_CONTAINERS)) {
            val entry = array.optJSONObject(i) ?: continue
            val kind = entry.optString("kind"); val id = entry.optString("id"); val name = entry.optString("name")
            val ids = entry.optJSONArray("trackIds") ?: continue
            if (kind !in KINDS || id.isEmpty() || id.length > 256 || name.isEmpty() || name.length > NAME_CHARS || ids.length() > MAX_TRACKS || !seen.add("$kind:$id")) continue
            val trackIds = (0 until ids.length()).map { ids.optString(it) }
            if (trackIds.any { it.isEmpty() || it.length > 256 }) continue
            containers += Container(kind, id, name, nullable(entry, "artist"), nullable(entry, "coverArt"), trackIds, entry.optLong("keptAt"))
        }
    }
    private fun nullable(entry: JSONObject, name: String) = if (entry.isNull(name)) null else entry.optString(name).takeIf { it.isNotEmpty() }

    // A stored name is used only when the writer could have made it and it stays in the folder.
    private fun resolve(folder: File, file: String): File? {
        if (!FILE.matches(file)) return null
        val target = File(folder, file)
        return if (target.canonicalFile.parentFile == folder.canonicalFile) target else null
    }
    private fun present(folder: File, file: String, bytes: Long) = resolve(folder, file)?.let { it.isFile && it.length() == bytes } == true

    // Deletes partial files and kept files no entry names. Never anything else.
    private fun sweep(folder: File) {
        val named = HashSet<String>().apply { songs.values.forEach { add(it.file) }; covers.values.forEach { add(it.file) } }
        for (name in folder.list() ?: return) {
            val stray = if (name.endsWith(".part")) FILE.matches(name.removeSuffix(".part")) else FILE.matches(name) && name !in named
            if (stray) File(folder, name).delete()
        }
    }

    /** A kept song's file, when it is there with its recorded size. Lock-free; any thread. */
    fun fileFor(trackId: String): File? {
        val folder = dir ?: return null
        val song = present[trackId] ?: return null
        val file = resolve(folder, song.file) ?: return null
        return if (file.isFile && file.length() == song.bytes) file else { check(trackId); null }
    }
    /** A kept cover's type and bytes. Any thread. */
    fun coverFor(id: String): Pair<String, ByteArray>? {
        val folder = dir ?: return null
        val cover = coversNow[id] ?: return null
        val file = resolve(folder, cover.file) ?: return null
        return runCatching { cover.type to file.readBytes() }.getOrNull()
    }
    /** Drops a song whose file is gone or changed; it streams instead. */
    fun check(trackId: String) = worker.execute {
        val folder = dir ?: return@execute
        val song = songs[trackId] ?: return@execute
        if (present(folder, song.file, song.bytes)) return@execute
        songs.remove(trackId); usedBytes -= song.bytes; revision++
        markDirty(); publish()
    }

    // For the page ---------------------------------------------------------------------------------

    fun state(done: (JSObject) -> Unit) = worker.execute {
        val list = JSArray()
        for (container in containers) list.put(summary(container))
        done(JSObject().put("account", account ?: JSONObject.NULL).put("revision", revision).put("songs", songs.size)
            .put("usedBytes", usedBytes).put("containers", list).put("jobs", jobViews()).put("notice", notice ?: JSONObject.NULL))
    }
    fun presentIds(done: (JSObject) -> Unit) = worker.execute { done(JSObject().put("ids", JSONArray(songs.keys.toList()))) }
    fun container(kind: String, id: String, done: (JSObject?) -> Unit) = worker.execute {
        val container = containers.firstOrNull { it.kind == kind && it.id == id } ?: return@execute done(null)
        val tracks = JSONArray()
        for (trackId in container.trackIds) songs[trackId]?.let { tracks.put(it.track) }
        done(JSObject().put("container", summary(container)).put("trackIds", JSONArray(container.trackIds)).put("tracks", tracks))
    }
    private fun summary(container: Container): JSObject {
        var present = 0; var bytes = 0L
        for (trackId in container.trackIds) songs[trackId]?.let { present++; bytes += it.bytes }
        return JSObject().put("kind", container.kind).put("id", container.id).put("name", container.name)
            .put("artist", container.artist ?: JSONObject.NULL).put("coverArt", container.coverArt ?: JSONObject.NULL)
            .put("total", container.trackIds.size).put("present", present).put("bytes", bytes).put("keptAt", container.keptAt)
    }
    private fun jobViews(): JSArray {
        val list = JSArray()
        for (job in jobs) list.put(JSObject().put("kind", job.kind).put("id", job.id).put("name", job.name).put("done", job.done).put("total", job.total)
            .put("failed", job.failed).put("state", job.state).put("error", job.error ?: JSONObject.NULL))
        return list
    }
    private fun result(error: String?) = JSObject().put("ok", error == null).put("error", error ?: JSONObject.NULL)

    // Keeping ---------------------------------------------------------------------------------------

    /**
     * Admission, checked against what is kept now, then written, then queued. Answers before any
     * song is fetched. A request that breaks a bound is refused whole.
     */
    fun keep(request: JSONObject, done: (JSObject) -> Unit) = worker.execute {
        val folder = dir ?: return@execute done(result(INVALID))
        val kind = request.optString("kind"); val id = request.optString("id"); val name = request.optString("name")
        val artist = nullable(request, "artist"); val coverArt = nullable(request, "coverArt")
        val list = request.optJSONArray("songs")
        val limit = request.optLong("limitBytes", 4096 * MB).coerceIn(64 * MB, 1024L * 1024 * MB)
        if (kind !in KINDS || id.isEmpty() || id.length > 256 || name.isEmpty() || name.length > NAME_CHARS || (artist?.length ?: 0) > NAME_CHARS
            || (coverArt?.length ?: 0) > 256 || list == null || list.length() == 0 || list.length() > MAX_TRACKS) return@execute done(result(INVALID))
        val pending = LinkedHashMap<String, Pending>()
        for (i in 0 until list.length()) {
            val song = list.optJSONObject(i) ?: return@execute done(result(INVALID))
            val trackId = song.optString("id"); val json = song.optString("track"); val url = song.optString("url")
            val track = runCatching { JSONObject(json) }.getOrNull()
            val scheme = runCatching { URL(url).protocol }.getOrNull()
            if (trackId.isEmpty() || trackId.length > 256 || track == null || json.toByteArray().size > TRACK_JSON_BYTES || track.optString("id") != trackId
                || track.optString("source") != "navidrome" || (scheme != "http" && scheme != "https")) return@execute done(result(INVALID))
            val cover = if (track.isNull("coverArt")) null else track.optString("coverArt").takeIf { it.isNotEmpty() && it.length <= 256 }
            val size = if (song.isNull("size")) null else song.optLong("size").takeIf { it > 0 }
            if (trackId !in pending) pending[trackId] = Pending(trackId, url, track.toString(), cover, size)
        }
        val missing = pending.values.filter { it.id !in songs && it.id !in downloading }
        if (songs.size + missing.size > MAX_SONGS) return@execute done(result(TOO_MANY))
        if (indexBytes + missing.sumOf { it.track.toByteArray().size + ENTRY_OVERHEAD } > WRITE_BUDGET) return@execute done(result(INDEX_FULL))
        val coverIds = (listOfNotNull(coverArt) + pending.values.mapNotNull { it.coverArt }).distinct().filter { it !in covers }.take(COVERS_PER_JOB)
        val estimate = missing.sumOf { it.size ?: 0L } + coverIds.size * COVER_ESTIMATE
        val existing = jobs.firstOrNull { it.kind == kind && it.id == id }
        val reserved = jobs.filter { it !== existing }.sumOf { it.estimate }
        if (missing.isNotEmpty() && usedBytes + reserved + estimate > limit) return@execute done(result(limitMessage(missing.size, estimate, limit - usedBytes - reserved, limit / MB)))
        if (missing.isNotEmpty() && folder.usableSpace - estimate < HEADROOM) return@execute done(result(NO_DISK))
        // The record first, replacing an older one; songs only it listed are forgotten.
        containers.removeAll { it.kind == kind && it.id == id }
        containers += Container(kind, id, name, artist, coverArt, pending.keys.toList(), System.currentTimeMillis())
        val orphans = prune()
        revision++; notice = null
        write()
        orphans.forEach { File(folder, it).delete() }
        val job = existing ?: Job(kind, id).also { jobs += it }
        job.name = name; job.total = pending.size; job.done = pending.keys.count { it in songs }; job.failed = 0; job.error = null
        job.songs = ArrayDeque(pending.values.filter { it.id !in songs }); job.covers = ArrayDeque(coverIds); job.attempts.clear()
        job.estimate = estimate; job.limit = limit; job.pauses = 0; job.cancelled = false
        if (job.state != "keeping") job.state = "waiting"
        publish()
        done(result(null))
        pump()
    }

    fun cancel(kind: String, id: String, done: (JSObject) -> Unit) = worker.execute {
        jobs.firstOrNull { it.kind == kind && it.id == id }?.let { drop(it) }
        revision++; publish()
        done(result(null))
    }
    private fun drop(job: Job) {
        job.cancelled = true
        job.stops.toList().forEach { it() }
        job.songs.clear(); job.covers.clear()
        jobs.remove(job)
    }

    fun forget(kind: String, id: String, done: (JSObject) -> Unit) = worker.execute {
        val folder = dir ?: return@execute done(result(UNKNOWN))
        jobs.firstOrNull { it.kind == kind && it.id == id }?.let { drop(it) }
        if (containers.none { it.kind == kind && it.id == id }) return@execute done(result(UNKNOWN))
        containers.removeAll { it.kind == kind && it.id == id }
        val orphans = prune()
        revision++; notice = null
        write()
        // After the index: an open file keeps playing on Android; a queued entry whose file is
        // gone streams instead (Playback.recover).
        orphans.forEach { File(folder, it).delete() }
        publish()
        done(result(null))
    }

    fun forgetAll(done: (JSObject) -> Unit) = worker.execute {
        val folder = dir ?: return@execute done(result(null))
        jobs.toList().forEach { drop(it) }
        songs.clear(); covers.clear(); containers.clear()
        recount(); revision++; notice = null
        write()
        sweep(folder)
        publish()
        done(result(null))
    }

    /** Kept songs belong to one account: the same does nothing, the first is adopted, another forgets them. */
    fun bind(key: String, done: () -> Unit) = worker.execute {
        val folder = dir ?: return@execute done()
        if (account == key) return@execute done()
        if (account != null) {
            jobs.toList().forEach { drop(it) }
            songs.clear(); covers.clear(); containers.clear()
            recount(); revision++
        }
        account = key
        write()
        sweep(folder)
        publish()
        done()
    }

    /** The server answers again: paused keeps go on. */
    fun resume() = worker.execute {
        var any = false
        for (job in jobs) if (job.state == "paused") { job.state = "waiting"; job.attempts.clear(); any = true }
        if (any) { publish(); pump() }
    }

    /** Writes a dirty index now (the app going to the background). */
    fun flush() = worker.execute { if (dirty) write() }

    // Downloads -------------------------------------------------------------------------------------

    private fun pump() {
        while (running < 2) {
            val job = jobs.firstOrNull { (it.state == "waiting" || it.state == "keeping") && (it.songs.any { p -> p.id !in downloading } || (it.songs.isEmpty() && it.covers.isNotEmpty() && it.songsWorking == 0)) } ?: break
            val next = job.songs.firstOrNull { it.id !in downloading }
            if (next != null) { job.songs.remove(next); job.songsWorking++; start(job, { job.songsWorking-- }) { song(job, next) } }
            else { val coverId = job.covers.removeFirst(); start(job, {}) { keepCover(job, coverId) } }
        }
        finishJobs()
    }
    private fun start(job: Job, after: () -> Unit, task: () -> Unit) {
        running++; job.working++
        downloads.execute {
            try { task() } catch (error: Exception) { /* Counted by the task itself. */ }
            finally { worker.execute { running--; job.working--; after(); finishJobs(); pump() } }
        }
    }
    private fun finishJobs() {
        var changed = false
        for (job in jobs.toList()) {
            if (job.state == "paused" || job.state == "stopped" || job.songs.isNotEmpty() || job.covers.isNotEmpty() || job.working > 0) continue
            changed = true
            if (job.failed > 0) { job.state = "stopped"; job.error = failedSongs(job.failed); job.estimate = 0 } else jobs.remove(job)
            if (dirty) write()
        }
        if (changed) { revision++; publish() }
    }
    private fun stopJob(job: Job, error: String) {
        job.state = "stopped"; job.error = error; job.songs.clear(); job.covers.clear(); job.estimate = 0
        job.stops.toList().forEach { it() }
    }

    // Runs on a download thread; every change goes back to the index thread.
    private fun song(job: Job, pending: Pending) {
        val folder = dir ?: return
        var budget = 0L
        var skip = false
        var stop: (() -> Unit)? = null
        val stopped = AtomicBoolean(false)
        onIndex {
            skip = pending.id in songs || containers.none { pending.id in it.trackIds } || job.cancelled
            if (skip && pending.id in songs) job.done++
            if (!skip) {
                downloading += pending.id
                if (job.state == "waiting") job.state = "keeping"
                budget = job.limit - usedBytes
                val halt = { stopped.set(true) }
                stop = halt
                job.stops += halt
                publish()
            }
        }
        if (skip) { onIndex { publish() }; return }
        val file = name("s", pending.id, suffixFor(pending))
        val part = File(folder, "$file.part")
        val outcome: Throwable? = try {
            NativeHttp.download(pending.url, part, budget, { stopped.get() || job.cancelled }) { }
            val target = File(folder, file)
            if (!part.renameTo(target)) throw java.io.IOException("Rename failed.")
            null
        } catch (error: Throwable) { part.delete(); error }
        onIndex {
            downloading -= pending.id
            stop?.let { job.stops -= it }
            if (outcome == null) {
                val target = File(folder, file)
                if (containers.none { pending.id in it.trackIds }) { target.delete(); return@onIndex }
                songs[pending.id] = Song(pending.track, pending.coverArt, file, target.length(), System.currentTimeMillis())
                usedBytes += target.length(); indexBytes += pending.track.length + ENTRY_OVERHEAD
                job.done++; job.pauses = 0
                job.estimate = maxOf(0, job.estimate - (pending.size ?: target.length()))
                revision++
                markDirty(); publish()
                return@onIndex
            }
            if (job.cancelled || job.state == "stopped" || job.state == "paused" || job !in jobs) {
                if (job.state == "paused" && job.songs.none { it.id == pending.id }) job.songs.addFirst(pending)
                return@onIndex
            }
            when (outcome) {
                is KeptUnreachable -> {
                    job.songs.addFirst(pending)
                    if (++job.pauses > 3) stopJob(job, stoppedAnswering(job.done, job.total))
                    else for (other in jobs) if (other.state != "stopped") { other.state = "paused"; other.stops.toList().forEach { it() } }
                }
                is KeptDiskFull -> stopJob(job, diskFull(job.done, job.total))
                is KeptLimit -> stopJob(job, limitReached(job.limit / MB, job.done, job.total))
                else -> {
                    val tries = (job.attempts[pending.id] ?: 0) + 1
                    job.attempts[pending.id] = tries
                    if (tries < 2) job.songs.addFirst(pending) else job.failed++
                }
            }
            revision++; publish()
        }
    }

    private fun keepCover(job: Job, id: String) {
        val folder = dir ?: return
        var wanted = false
        onIndex { wanted = id !in covers && !job.cancelled && job.state != "stopped" && referencedCover(id) }
        if (!wanted) return
        val (type, bytes) = CoverProxy.load(id, 600) ?: return
        val ext = COVER_TYPES[type] ?: return
        val file = name("c", id, ext)
        val part = File(folder, "$file.part")
        val ok = runCatching {
            FileOutputStream(part).use { it.write(bytes); it.flush(); it.fd.sync() }
            if (!part.renameTo(File(folder, file))) throw java.io.IOException("Rename failed.")
        }.isSuccess
        if (!ok) { part.delete(); return }
        onIndex {
            if (!referencedCover(id) || usedBytes + bytes.size > job.limit) { File(folder, file).delete(); return@onIndex }
            covers[id] = Cover(file, bytes.size.toLong(), type, System.currentTimeMillis())
            usedBytes += bytes.size; revision++
            markDirty(); publish()
        }
    }

    // Runs a step on the index thread and waits for it, from a download thread.
    private fun onIndex(step: () -> Unit) { worker.submit(Runnable { step() }).get() }

    private fun suffixFor(pending: Pending): String {
        val format = runCatching { JSONObject(pending.track).optString("sourceFormat").lowercase() }.getOrDefault("")
        return if (Regex("^[a-z0-9]{1,8}$").matches(format)) format else "audio"
    }
    // Only the writer makes names: s- or c-, the first 32 hex digits of SHA-256 of the id, a suffix.
    private fun name(prefix: String, id: String, ext: String): String {
        val hash = MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }.take(32)
        return "$prefix-$hash.$ext"
    }

    // The index -------------------------------------------------------------------------------------

    private fun referencedCover(id: String) = containers.any { it.coverArt == id || it.trackIds.any { trackId -> songs[trackId]?.coverArt == id } }
    // Drops entries no container refers to, and returns their files.
    private fun prune(): List<String> {
        val listed = containers.flatMapTo(HashSet()) { it.trackIds }
        val gone = ArrayList<String>()
        for (id in songs.keys.toList()) if (id !in listed) gone += songs.remove(id)!!.file
        for (id in covers.keys.toList()) if (!referencedCover(id)) gone += covers.remove(id)!!.file
        recount()
        return gone
    }
    private fun recount() {
        usedBytes = songs.values.sumOf { it.bytes } + covers.values.sumOf { it.bytes }
        indexBytes = songs.entries.sumOf { it.value.track.length + it.key.length + ENTRY_OVERHEAD }
    }
    private fun publish() {
        present = HashMap(songs)
        coversNow = HashMap(covers)
        notifyPage()
    }
    private fun notifyPage() {
        if (notifyScheduled) return
        val wait = maxOf(0, lastNotify + 250 - System.currentTimeMillis())
        notifyScheduled = true
        worker.schedule(Runnable {
            notifyScheduled = false; lastNotify = System.currentTimeMillis()
            listener?.invoke(JSObject().put("revision", revision).put("usedBytes", usedBytes).put("jobs", jobViews()))
        }, wait, TimeUnit.MILLISECONDS)
    }
    private fun markDirty() {
        dirty = true
        if (writeScheduled) return
        writeScheduled = true
        worker.schedule(Runnable { writeScheduled = false; if (dirty) write() }, maxOf(0, lastWrite + 2000 - System.currentTimeMillis()), TimeUnit.MILLISECONDS)
    }
    // Atomic and durable (AtomicFile syncs before it renames). No addresses or credentials.
    private fun write() {
        val folder = dir ?: return
        dirty = false; lastWrite = System.currentTimeMillis()
        val songList = JSONObject()
        for ((id, song) in songs) songList.put(id, JSONObject().put("track", JSONObject(song.track)).put("file", song.file).put("bytes", song.bytes).put("keptAt", song.keptAt))
        val coverList = JSONObject()
        for ((id, cover) in covers) coverList.put(id, JSONObject().put("file", cover.file).put("bytes", cover.bytes).put("type", cover.type).put("keptAt", cover.keptAt))
        val containerList = JSONArray()
        for (c in containers) containerList.put(JSONObject().put("kind", c.kind).put("id", c.id).put("name", c.name).put("artist", c.artist ?: JSONObject.NULL)
            .put("coverArt", c.coverArt ?: JSONObject.NULL).put("trackIds", JSONArray(c.trackIds)).put("keptAt", c.keptAt))
        val text = JSONObject().put("version", 1).put("account", account ?: JSONObject.NULL).put("songs", songList).put("containers", containerList).put("covers", coverList).toString()
        val file = AtomicFile(File(folder, "index.json"))
        var stream: FileOutputStream? = null
        try {
            stream = file.startWrite()
            stream.write(text.toByteArray(Charsets.UTF_8))
            file.finishWrite(stream)
        } catch (error: Exception) {
            stream?.let { file.failWrite(it) }
            dirty = true
        }
    }
}
