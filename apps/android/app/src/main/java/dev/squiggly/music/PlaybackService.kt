package dev.squiggly.music

import android.app.PendingIntent
import android.content.Intent
import android.os.Process
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

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
        Kept.init(this)
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
            .setCallback(Controllers)
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

    /**
     * What other apps may do with the session. Any app can connect to it. The notification (and
     * through it the lock screen), the system, Bluetooth, notification listeners, and Android Auto
     * can play, pause, seek, and skip; the rest can only look. The queue belongs to the page, so
     * no controller can change it or put its own addresses in it.
     */
    private object Controllers : MediaSession.Callback {
        private val transport = Player.Commands.Builder()
            .addAllReadOnlyCommands()
            .addAll(
                Player.COMMAND_PLAY_PAUSE, Player.COMMAND_PREPARE, Player.COMMAND_STOP,
                Player.COMMAND_SEEK_TO_DEFAULT_POSITION, Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
                Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD,
                Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                Player.COMMAND_SEEK_TO_MEDIA_ITEM,
            )
            .build()

        override fun onConnectAsync(session: MediaSession, controller: MediaSession.ControllerInfo): ListenableFuture<MediaSession.ConnectionResult> {
            // Media3's defaults: trusted controllers get every command, the rest read-only ones.
            val result = MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
            if (controller.isTrusted || session.isAutomotiveController(controller) || session.isAutoCompanionController(controller)) {
                result.setAvailablePlayerCommands(transport)
            }
            return Futures.immediateFuture(result.build())
        }

        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> =
            if (controller.uid == Process.myUid()) super.onAddMediaItems(mediaSession, controller, mediaItems)
            else Futures.immediateFailedFuture(UnsupportedOperationException())
    }
}
