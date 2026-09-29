package dev.squiggly.music

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject

/**
 * The player. It holds its own copy of the page's queue (the page sends edits, see
 * apps/android/web/queue.ts), so it goes from song to song, gaplessly where the files allow,
 * with the screen off and the page asleep, and the notification's buttons work without the
 * page. It outlives the activity: PlaybackService wraps it in a media session, and a page that
 * loads while it plays picks up where it is (restore).
 *
 * Everything here runs on the main thread, which is the player's application thread.
 */
object Playback {
    private class Entry(val url: String, val fallbackUrl: String, val track: String)

    lateinit var player: ExoPlayer
        private set
    private lateinit var app: Context
    private val main = Handler(Looper.getMainLooper())

    // Per queue entry: the stream addresses (they carry credentials, so they stay here and in
    // the player) and the page's Track JSON.
    private val entries = HashMap<String, Entry>()
    // Entries playing the server's MP3 because the original couldn't be decoded.
    private val fallbacks = HashSet<String>()
    private var lastSeq = 0
    private var playId = 0
    private var current: String? = null
    private var error: String? = null

    /** Receives every state report while a page is listening. */
    var listener: ((JSObject) -> Unit)? = null
        set(value) { field = value; report() }

    fun init(context: Context) {
        if (::player.isInitialized) return
        app = context.applicationContext
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent(NativeHttp.userAgent)
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(30000)
        player = ExoPlayer.Builder(app)
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(app, http)))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            // Headphones unplugged: pause, as every phone player does.
            .setHandleAudioBecomingNoisy(true)
            // Streaming with the screen off needs the CPU and Wi-Fi awake while it plays.
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build()
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
                // A song repeating (repeat one, or repeat all with one song) starts over: a new play.
                if (item?.mediaId != current || reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) { current = item?.mediaId; playId++; error = null }
                report()
            }
            override fun onEvents(player: Player, events: Player.Events) {
                report()
                if (player.isPlaying) tick() else main.removeCallbacks(ticker)
            }
            override fun onPlayerError(failure: PlaybackException) = recover(failure)
        })
    }

    /** Starts (or keeps) the service that shows the notification and holds the foreground. */
    fun ensureService(context: Context) {
        // Refused while the app is in the background; the service is already running then.
        runCatching { context.startService(Intent(context, PlaybackService::class.java)) }
    }

    // Commands from the page -------------------------------------------------------------------

    fun edit(ops: JSONArray, seq: Int): List<String> {
        for (i in 0 until ops.length()) {
            val op = ops.optJSONObject(i) ?: continue
            // A malformed operation is skipped; the page compares the result and plans again.
            runCatching {
                when (op.getString("type")) {
                    "replace" -> {
                        player.playWhenReady = false
                        entries.clear(); fallbacks.clear(); error = null
                        player.setMediaItems(items(op.getJSONArray("items")), true)
                        if (player.mediaItemCount == 0) player.stop()
                    }
                    "remove" -> {
                        val from = op.getInt("from").coerceIn(0, player.mediaItemCount)
                        val to = (from + op.getInt("count")).coerceIn(from, player.mediaItemCount)
                        for (index in from until to) player.getMediaItemAt(index).mediaId.let { entries.remove(it); fallbacks.remove(it) }
                        player.removeMediaItems(from, to)
                    }
                    "insert" -> player.addMediaItems(op.getInt("at").coerceIn(0, player.mediaItemCount), items(op.getJSONArray("items")))
                    "move" -> {
                        val from = op.getInt("from"); val to = op.getInt("to")
                        if (from in 0 until player.mediaItemCount && to in 0 until player.mediaItemCount) player.moveMediaItem(from, to)
                    }
                }
            }
        }
        lastSeq = maxOf(lastSeq, seq)
        report()
        return ids()
    }

    fun load(id: String, position: Double, play: Boolean, seq: Int) {
        lastSeq = maxOf(lastSeq, seq)
        val index = ids().indexOf(id)
        if (index < 0) return report()
        // Loading an entry starts a new play, even when it's the entry already loaded.
        current = id; playId++; error = null
        if (play) ensureService(app)
        player.seekTo(index, (position * 1000).toLong().coerceAtLeast(0))
        player.playWhenReady = play
        if (player.playbackState == Player.STATE_IDLE) player.prepare()
        report()
    }

    fun play() {
        ensureService(app)
        if (player.playbackState == Player.STATE_IDLE) player.prepare()
        player.play()
    }

    fun pause() = player.pause()

    fun seek(id: String, position: Double) {
        if (player.currentMediaItem?.mediaId == id) player.seekTo((position * 1000).toLong().coerceAtLeast(0))
    }

    fun volume(value: Double) {
        player.volume = value.toFloat().coerceIn(0f, 1f)
    }

    /**
     * The page's repeat mode, so the queue wraps or a song repeats with the screen off. ExoPlayer's
     * Next (the notification's too) still moves on under repeat one. Shuffle stays with the page,
     * which reorders its queue and sends the moves, so ExoPlayer's own shuffle is never turned on.
     */
    fun repeat(mode: String) {
        player.repeatMode = when (mode) {
            "all" -> Player.REPEAT_MODE_ALL
            "one" -> Player.REPEAT_MODE_ONE
            else -> Player.REPEAT_MODE_OFF
        }
    }

    /** The queue with each entry's Track JSON, and the state, for a page that just loaded. */
    fun restore(): JSObject {
        val items = JSArray()
        for (id in ids()) entries[id]?.let { items.put(JSObject().put("id", id).put("track", it.track)) }
        return JSObject().put("items", items).put("playback", state())
    }

    // State ------------------------------------------------------------------------------------

    fun state(): JSObject {
        val state = player.playbackState
        val duration = player.duration
        return JSObject()
            .put("seq", lastSeq)
            .put("entryId", player.currentMediaItem?.mediaId ?: JSONObject.NULL)
            .put("playId", playId)
            // Waiting for data with play pressed counts as playing, as it does in the browser.
            .put("playing", player.isPlaying || (player.playWhenReady && state == Player.STATE_BUFFERING))
            .put("buffering", player.playWhenReady && state == Player.STATE_BUFFERING)
            .put("ended", state == Player.STATE_ENDED)
            .put("position", player.currentPosition / 1000.0)
            .put("duration", if (duration == C.TIME_UNSET) 0.0 else duration / 1000.0)
            .put("fallback", player.currentMediaItem?.mediaId?.let { it in fallbacks } == true)
            .put("error", error ?: JSONObject.NULL)
    }

    // Reports coalesce: one per turn of the main loop, however many player events arrived.
    private var reporting = false
    private fun report() {
        if (reporting || listener == null || !::player.isInitialized) return
        reporting = true
        main.post { reporting = false; listener?.invoke(state()) }
    }
    // While playing, the position goes to the page twice a second; it counts forward in between.
    private val ticker = object : Runnable {
        override fun run() {
            report()
            if (player.isPlaying && listener != null) main.postDelayed(this, 500)
        }
    }
    private fun tick() {
        main.removeCallbacks(ticker)
        if (listener != null) main.postDelayed(ticker, 500)
    }

    // Some originals are beyond Android's decoders (DSD, some ALAC). Like the browser build,
    // ask the server for a 320 kbps MP3 of that song, once, and carry on from the same place.
    private fun recover(failure: PlaybackException) {
        val item = player.currentMediaItem
        val id = item?.mediaId
        val entry = id?.let { entries[it] }
        val format = failure.errorCode / 1000 == 3 || failure.errorCode / 1000 == 4
        if (item != null && id != null && entry != null && format && id !in fallbacks) {
            fallbacks += id
            val index = player.currentMediaItemIndex
            val position = player.currentPosition
            player.replaceMediaItem(index, item.buildUpon().setUri(entry.fallbackUrl).build())
            player.seekTo(index, position)
            player.prepare()
            return report()
        }
        error = if (failure.errorCode / 1000 == 2) "network" else "unplayable"
        report()
    }

    private fun ids() = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }

    private fun items(list: JSONArray): List<MediaItem> = (0 until list.length()).map { i ->
        val item = list.getJSONObject(i)
        val id = item.getString("id")
        val entry = Entry(item.getString("url"), item.getString("fallbackUrl"), item.getString("track"))
        entries[id] = entry
        val coverArt = item.optNullableString("coverArt")
        val duration = if (item.isNull("duration")) null else item.optDouble("duration")
        MediaItem.Builder()
            .setMediaId(id)
            .setUri(entry.url)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(item.optString("title"))
                    .setArtist(item.optString("artist"))
                    .setAlbumTitle(item.optNullableString("album"))
                    .setArtworkUri(coverArt?.let { CoverProxy.artworkUri(it) })
                    .setDurationMs(duration?.takeIf { it.isFinite() && it > 0 }?.let { (it * 1000).toLong() })
                    .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                    .setIsPlayable(true)
                    .setIsBrowsable(false)
                    .build(),
            )
            .build()
    }

    private fun JSONObject.optNullableString(name: String): String? = if (isNull(name)) null else optString(name).takeIf { it.isNotEmpty() }
}
