package dev.squiggly.music

import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    // Back steps back through the page's own history while it has some: it closes the
    // now-playing sheet or a menu, then returns to earlier pages. The page's router records in
    // history.state how many of its entries lie behind the current one (route.ts), so ask it;
    // WebView.canGoBack() skips entries added without a tap. With nothing behind, the app goes
    // to the background, as the home gesture would, and the page stays as it was.
    private val back = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            val web = bridge?.webView ?: return run { moveTaskToBack(true) }
            web.evaluateJavascript(STEP_BACK) { went -> if (went != "true") moveTaskToBack(true) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(SquigglyPlugin::class.java)
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this, back)
    }

    private companion object {
        const val STEP_BACK = "(function(){var s=history.state;if(s&&typeof s.depth==='number'&&s.depth>0){history.back();return true}return false})()"
    }
}
