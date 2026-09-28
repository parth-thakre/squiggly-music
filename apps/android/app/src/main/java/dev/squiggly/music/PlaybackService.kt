package dev.squiggly.music

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * The media session around Playback's player: the notification, the lock screen, Bluetooth
 * and headset buttons, the Flip's cover screen widget, and the foreground service that keeps
 * playback going with the screen off. Media3 moves the service in and out of the foreground as
 * playback starts and stops. The player belongs to Playback and outlives this service.
 */
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        Playback.init(this)
        CoverProxy.init(this)
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val created = MediaSession.Builder(this, Playback.player)
            .setSessionActivity(open)
            .setBitmapLoader(CacheBitmapLoader(CoverProxy.Bitmaps(DataSourceBitmapLoader.Builder(this).build())))
            .build()
        session = created
        // The page drives the player directly, so no controller may ever connect to ask for
        // the session. Add it here so the notification follows playback from the start.
        addSession(created)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onDestroy() {
        session?.release()
        session = null
        super.onDestroy()
    }
}
