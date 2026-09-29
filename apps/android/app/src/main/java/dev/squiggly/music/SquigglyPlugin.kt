package dev.squiggly.music

import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.core.util.Consumer
import androidx.core.view.WindowCompat
import androidx.window.java.layout.WindowInfoTrackerCallbackAdapter
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import com.getcapacitor.BridgeWebViewClient
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/**
 * The page's native half (apps/android/web/plugin.ts): HTTP for the connector, the Keystore
 * sign-in, the cover proxy, the player, and the Flip's fold.
 */
@CapacitorPlugin(name = "Squiggly")
class SquigglyPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    private var windows: WindowInfoTrackerCallbackAdapter? = null
    private var posture = JSObject().put("posture", "flat").put("top", 0).put("bottom", 0)
    private val layout = Consumer<WindowLayoutInfo> { info ->
        posture = postureOf(info)
        notifyListeners("posture", posture)
    }

    override fun load() {
        Playback.init(context)
        CoverProxy.init(context)
        // Covers for the page come from the proxy; everything else is Capacitor's as usual. This
        // runs before the WebView loads the page, so the first request already comes here.
        bridge.setWebViewClient(object : BridgeWebViewClient(bridge) {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                CoverProxy.intercept(request) ?: super.shouldInterceptRequest(view, request)
        })
        Playback.listener = { state -> notifyListeners("playback", state) }
        Playback.ensureService(context)
        windows = WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(activity)).also {
            it.addWindowLayoutInfoListener(activity, ContextCompat.getMainExecutor(context), layout)
        }
    }

    override fun handleOnDestroy() {
        Playback.listener = null
        windows?.removeWindowLayoutInfoListener(layout)
        windows = null
    }

    // HTTP -------------------------------------------------------------------------------------

    @PluginMethod
    fun http(call: PluginCall) = NativeHttp.request(call)

    @PluginMethod
    fun cancelHttp(call: PluginCall) {
        NativeHttp.cancel(call.getInt("id") ?: 0)
        call.resolve()
    }

    // Sign-in and covers -----------------------------------------------------------------------

    @PluginMethod
    fun loadAccount(call: PluginCall) {
        val canRemember = SecureAccount.available()
        val account = if (canRemember) SecureAccount.load(context)?.let { runCatching { JSONObject(it) }.getOrNull() } else null
        call.resolve(JSObject().put("canRemember", canRemember).put("account", account ?: JSONObject.NULL))
    }

    @PluginMethod
    fun saveAccount(call: PluginCall) {
        val url = call.getString("url"); val username = call.getString("username"); val password = call.getString("password")
        if (url == null || username == null || password == null) return call.reject("Incomplete sign-in.")
        val json = JSONObject().put("url", url).put("username", username).put("password", password).toString()
        call.resolve(JSObject().put("saved", SecureAccount.save(context, json)))
    }

    @PluginMethod
    fun forgetAccount(call: PluginCall) {
        SecureAccount.forget(context)
        call.resolve()
    }

    @PluginMethod
    fun setServer(call: PluginCall) {
        CoverProxy.setServer(call.getString("coverBase"), call.getString("key"))
        call.resolve()
    }

    // Player -----------------------------------------------------------------------------------
    // The player lives on the main thread; plugin calls arrive on Capacitor's own thread.

    private fun onMain(call: PluginCall, task: () -> JSObject?) = main.post {
        try { call.resolve(task() ?: JSObject()) } catch (error: Exception) { call.reject("The player refused that.") }
    }

    @PluginMethod
    fun edit(call: PluginCall) {
        val ops = call.getArray("ops") ?: return call.reject("No operations.")
        val seq = call.getInt("seq") ?: 0
        onMain(call) { JSObject().put("ids", org.json.JSONArray(Playback.edit(ops, seq))) }
    }

    @PluginMethod
    fun load(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("No entry.")
        val position = call.getDouble("position") ?: 0.0
        val play = call.getBoolean("play", true)!!
        val seq = call.getInt("seq") ?: 0
        onMain(call) { Playback.load(id, position, play, seq); null }
    }

    @PluginMethod
    fun play(call: PluginCall) { onMain(call) { Playback.play(); null } }

    @PluginMethod
    fun pause(call: PluginCall) { onMain(call) { Playback.pause(); null } }

    @PluginMethod
    fun seek(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("No entry.")
        val position = call.getDouble("position") ?: 0.0
        onMain(call) { Playback.seek(id, position); null }
    }

    @PluginMethod
    fun volume(call: PluginCall) {
        val volume = call.getDouble("volume") ?: 1.0
        onMain(call) { Playback.volume(volume); null }
    }

    @PluginMethod
    fun restore(call: PluginCall) { onMain(call) { Playback.restore() } }

    @PluginMethod
    fun repeat(call: PluginCall) {
        val mode = call.getString("mode") ?: "off"
        onMain(call) { Playback.repeat(mode); null }
    }

    // The window behind the page takes the room's colour, and the status and navigation bars'
    // icons go light on a dark room. With a WebView older than 140, Capacitor pads the window by
    // the system bars instead of letting the page draw under them, and this colour shows there.
    // (Capacitor's SystemBars.setStyle would reset the window's colour, so it isn't used.)
    @PluginMethod
    fun setWindowColour(call: PluginCall) {
        val colour = call.getString("colour")?.takeIf { Regex("^#[0-9a-fA-F]{6}$").matches(it) } ?: return call.reject("Not a colour.")
        room = android.graphics.Color.parseColor(colour) to call.getBoolean("dark", false)!!
        main.post {
            applyRoom()
            call.resolve()
        }
    }

    // The room's colour, and whether it's dark, as last set by the page.
    private var room: Pair<Int, Boolean>? = null
    private fun applyRoom() {
        val (colour, dark) = room ?: return
        val window = activity?.window ?: return
        window.decorView.setBackgroundColor(colour)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    // Folding, unfolding, and the cover screen are configuration changes. Capacitor's SystemBars
    // restyles the bars on each one and resets the window's colour, so set it again after that.
    override fun handleOnConfigurationChanged(newConfig: android.content.res.Configuration?) {
        super.handleOnConfigurationChanged(newConfig)
        main.post { applyRoom() }
    }

    // Flex Mode --------------------------------------------------------------------------------

    @PluginMethod
    fun posture(call: PluginCall) = call.resolve(posture)

    // Half-folded with the hinge across the screen (a Flip standing on its lower half): the
    // heights of the halves above and below the hinge, in CSS pixels of the WebView. The
    // WebView doesn't report viewport segments to the page itself.
    private fun postureOf(info: WindowLayoutInfo): JSObject {
        val fold = info.displayFeatures.filterIsInstance<FoldingFeature>()
            .firstOrNull { it.state == FoldingFeature.State.HALF_OPENED && it.orientation == FoldingFeature.Orientation.HORIZONTAL }
        val web = bridge?.webView
        if (fold == null || web == null || web.height == 0) return JSObject().put("posture", "flat").put("top", 0).put("bottom", 0)
        val origin = IntArray(2).also { web.getLocationInWindow(it) }
        val density = web.resources.displayMetrics.density
        val top = ((fold.bounds.top - origin[1]) / density).coerceAtLeast(0f)
        val bottom = ((origin[1] + web.height - fold.bounds.bottom) / density).coerceAtLeast(0f)
        return JSObject().put("posture", "flex").put("top", top.toDouble()).put("bottom", bottom.toDouble())
    }
}
