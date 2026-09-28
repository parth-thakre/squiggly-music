import type { CapacitorConfig } from '@capacitor/cli';

// The Android app: the renderer's web build (`vite build --mode android`, see vite.config.ts) in
// a Capacitor WebView, with the native project in apps/android. docs/android.md covers building.
const config: CapacitorConfig = {
  appId: 'dev.squiggly.music',
  appName: 'Squiggly',
  webDir: 'out/android-web',
  // Capacitor's debug logging writes every plugin call's arguments and results to logcat,
  // which would include the password (saveAccount, loadAccount) and stream addresses with
  // their tokens. Debug builds still let Chrome's DevTools see the page's own console.
  loggingBehavior: 'none',
  android: {
    path: 'apps/android',
    // The page is the whole app; nothing remote is loaded into the WebView.
    allowMixedContent: false,
    captureInput: false,
  },
  plugins: {
    // Library requests go through CapacitorHttp.request() directly (bridge/nativeFetch.ts).
    // Leave the global fetch and XHR alone.
    CapacitorHttp: { enabled: false },
    // The page draws under the status and navigation bars and pads itself with
    // env(safe-area-inset-*), as the phone layout already does in browsers.
    SystemBars: { insetsHandling: 'css' },
  },
};

export default config;
