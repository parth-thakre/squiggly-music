# Android

The Android app connects to your Navidrome server itself, with no computer in between. It's the same interface as the desktop and browser versions, with the phone layout, running in a WebView. A native player plays the queue, so music keeps going with the screen off and the app in the background, and the notification and lock screen controls work.

It's built for the Galaxy Z Flip 7 on Android 16 (the main screen, the cover screen, and Flex Mode), has a view of its own for the cover screens of the Z Flip 5, 6, and 7, and runs on Android 7 and later.

## How it's put together

| Path | What lives there |
| --- | --- |
| `capacitor.config.ts` | Capacitor's settings: the app id `dev.squiggly.music`, the web build in `out/android-web`, the native project in `apps/android` |
| `apps/android/web/` | The page's Android half. `main.ts` is the entry (`vite build --mode android` swaps it into `index.html`); it installs `window.squigglyAndroid` (`bridge.ts`) and then loads the renderer |
| `apps/android/app/src/main/java/dev/squiggly/music/` | The native half: `SquigglyPlugin.kt` (the Capacitor plugin), `Playback.kt` (the player), `PlaybackService.kt` (the media session and foreground service), `CoverProxy.kt`, `NativeHttp.kt`, `SecureAccount.kt` |
| `scripts/android.mjs` | The build: web bundle, `cap sync`, Gradle, licence notices, APKs into `dist/android` |
| `scripts/android-notices.ts` | Lists the npm packages in the page's bundle, with their licences, for the APK |

`window.squigglyAndroid` is to the Android app what `window.squiggly` (the preload bridge) is to the desktop. Its contract is `AndroidBridge` in `packages/core/contracts.ts`.

- **Library.** `SubsonicClient`, the same connector the desktop uses, runs in the page. Its requests go through `NativeHttp.kt` rather than the WebView's fetch, because the page is served from `https://localhost`, so a WebView fetch would need the server's CORS headers and couldn't reach a plain-HTTP server at all (mixed content). Navidrome does send `Access-Control-Allow-Origin: *`, but home servers on `http://192.168.x.x:4533` are common, and reverse proxies can drop headers.
- **Sign-in.** The connect screen is the desktop's. Without `https://` or `http://`, it tries HTTPS, then HTTP, asking without credentials first (`resolveServerAddress`, shared with the desktop). The server, username, and password are sealed with AES-GCM under a key in the Android Keystore (`SecureAccount.kt`) and reconnect at launch. If the Keystore can't be used, the password stays in memory for the session only, and the connect screen says so. Disconnecting in Settings forgets it. The sealed sign-in is left out of backups and device transfers, since its key can't leave the phone anyway.
- **Covers.** Components ask for `/api/cover?id=…&size=…`, the browser build's address. `CoverProxy.kt` answers it inside the WebView, from a disk cache (64 MB, oldest first) or from `getCoverArt` with the account's credentials. Credentials and authenticated URLs never reach components.
- **Playback.** The page keeps the queue, as the browser build does (`player.ts`, mode `android`), and `Playback.kt` holds a copy in an ExoPlayer (AndroidX Media3). After every queue edit the bridge sends the few operations that make the copies match (`apps/android/web/queue.ts`), never a whole new queue, which would interrupt the song. The player moves from song to song by itself, gaplessly where the files allow (ExoPlayer prepares the next item), so the page can sleep. The page follows its reports (position twice a second while playing) for the deck, play reports, radio, and queue saves. It asks for the original file (`format=raw`). If the phone can't decode it, it asks for a 320 kbps MP3 once and says so under the deck, as the browser does. The sleep timer runs in the page and is sent to the player too (`sleepAt`, `sleepAfterPlay`), so it still pauses after the app is swiped away. An internet radio station goes to the player with its own stream address (marked `live`): no MP3 fallback, repeat one off while it plays, and the title it announces (ICY) read from ExoPlayer's metadata and reported as `stationTitle`.
- **Background.** `PlaybackService` is a Media3 `MediaSessionService`: the notification, lock screen, Bluetooth and headset buttons, and the foreground service that keeps the process alive. It holds wake and Wi-Fi locks while streaming. If you swipe the app away while it plays, the music keeps playing. Opening it again shows the queue the player still holds. Radio and play reports need the page, so they pause while it's gone.
- **The Flip.** Folding, unfolding, and the cover screen resize the page instead of restarting it. Flex Mode (half-folded) uses the viewport-segment rules in Chrome, but the WebView doesn't report segments, so `SquigglyPlugin.kt` watches the hinge with Jetpack WindowManager, and `apps/android/web/posture.css` applies the same layout to the now-playing sheet. The status bar takes the room's colour, with light or dark icons to match.
- **The cover screen.** On the Flip 5, 6, and 7 cover screens (Flex Window) the app shows its own view (`CoverScreen.tsx`) instead of the phone layout. It shows the sleeve, the title and artist, the squiggle, and large previous, play, and next buttons, with the queue and lyrics one tap away. Swiping the sleeve changes songs. With nothing playing, it offers the saved queue, Shuffle, and recent records. The view is chosen by size, so it works in a browser on the cover screen too. The window must be at most 630×700 CSS px, and the screen itself must be at most 630×700 and between 3:4 and 4:3 (`COVER_SCREEN` in `nowPlaying.ts`). Split screen, pop-up windows, the main screen, and Flex Mode keep the phone layout, because the screen behind them is a phone's. The Flip 7's cover screen is 948×1048 px at density 2.625, so the page sees 361×399 CSS px, or 542×599 at density 1.75 with a smaller display size. Its flash and lenses sit inside the screen along the bottom, from about 43% of the width to near the right edge. Android reports this as a cutout: x from 428 px, the bottom 220 px. So the view keeps the bottom fifth of the screen as a band. The sleeve fills most of the width, with the title and artist beside it. The transport sits right under the seek bar, above the band. Only Queue and Lyrics (or Back and play under the queue and lyrics) sit in the band's free left end, at its top, clear of Samsung's gesture pill. The Flip 5 and 6 panel is 748×720 px, held upright. At density 3.0 in a buffer 1.5 times its size, that gives about 374×360 CSS px; the Flip 5 on Android 13 used 1.75, which gives 427×411. The screen's bottom edge steps up about a tenth of the height from a little left of the middle, and the lenses sit in the glass below. The view leaves that strip empty. Either way, the cameras are to the bottom right as the phone is held, hinge at the top, and the bottom-left corner is free. The view tells the models apart by shape: a screen at least 1.07 times as tall as it is wide is the Flip 7 (1048/948 is 1.105; the Flip 5 and 6 are within 4% of square either way). Unfolding closes the cover view's queue or lyrics and shows the same song in the phone layout.
- **Files.** Export as M3U can't download: the WebView ignores downloads. The page checks the playlist file, builds it, and `saveFile` in `SquigglyPlugin.kt` asks where to put it with the system's document picker, then writes it there. Cancelling the picker isn't an error.
- **Back** goes back through the page's history: it closes the now-playing sheet, a menu, or the share sheet, then returns to earlier pages. `MainActivity` asks the page's router how far back it can go (`history.state.depth`), because `WebView.canGoBack()` skips entries added without a tap. At the start, Back sends the app to the background and the page stays as it was.

## Toolchain

You need Node 22.16 or newer (as for the desktop), a JDK 21, and the Android SDK. Nothing needs root. These steps put everything under `~/.local/share/squiggly-android`, which the build uses by default. Set `SQUIGGLY_ANDROID_HOME` to use another folder, or `JAVA_HOME` and `ANDROID_HOME` to use a JDK or SDK you already have.

```bash
A=~/.local/share/squiggly-android
mkdir -p $A/downloads && cd $A/downloads

# Temurin JDK 21. The SHA-256 is published beside the file and by api.adoptium.net.
curl -fLO https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz
echo "ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94  OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz" | sha256sum -c
tar -xzf OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz -C $A
ln -sfn jdk-21.0.12.1+1 $A/jdk

# Android command-line tools 22.0. The SHA-256 is the one listed on developer.android.com/studio.
curl -fLO https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip
echo "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583  commandlinetools-linux-15859902_latest.zip" | sha256sum -c
mkdir -p $A/sdk/cmdline-tools
unzip -q commandlinetools-linux-15859902_latest.zip -d $A/sdk/cmdline-tools
mv $A/sdk/cmdline-tools/cmdline-tools $A/sdk/cmdline-tools/latest

# SDK packages. sdkmanager checks each download against the checksum in Google's repository.
export JAVA_HOME=$A/jdk ANDROID_HOME=$A/sdk
yes | $A/sdk/cmdline-tools/latest/bin/sdkmanager --licenses
$A/sdk/cmdline-tools/latest/bin/sdkmanager platform-tools 'platforms;android-36' 'build-tools;36.0.0' 'build-tools;35.0.0'
```

Gradle comes from the wrapper in `apps/android`. The wrapper jar matches Gradle's published SHA-256 for 8.14.3, and `gradle-wrapper.properties` pins the distribution's SHA-256. Gradle keeps its downloads in `$A/gradle`.

## Building

```bash
npm ci
npm run android:keystore   # once: makes the release signing key
npm run android:build      # debug and release APKs
```

`android:build` builds the page (`vite build --mode android`), copies it into the native project (`cap sync android`), writes the licence notices, runs Gradle, and leaves these in `dist/android` (git-ignored):

- `squiggly-<version>-debug.apk`: debuggable, signed with the SDK's debug key. Chrome's `chrome://inspect` can attach to its WebView.
- `squiggly-<version>-release.apk`: signed with your release key. Without a key it's `-release-unsigned.apk` and won't install.
- `SHA256SUMS`

`android:debug` and `android:release` build one of them. The version is `package.json`'s. `apps/android/app/build.gradle` reads it at build time and uses it as the `versionName`, and makes the `versionCode` from it: major × 10000 + minor × 100 + patch, so 1.2.3 is 10203. `scripts/android.mjs` names the APKs with it too.

### The release key

`android:keystore` makes a 4096-bit RSA key in a PKCS12 store, with a random password, and writes the details where the build looks for them:

- `~/.local/share/squiggly-android/signing/squiggly-release.p12`: the key store
- `~/.local/share/squiggly-android/signing/release.properties`: `storeFile`, `storePassword`, `keyAlias` (`squiggly`), `keyPassword`

Both are readable by you alone and live outside the repository. Never commit them. Back them up together: Android installs an update only if it's signed with the same key, so losing the key means uninstalling to install a new build. To sign with a different key, point `SQUIGGLY_ANDROID_SIGNING` at another properties file in the same format.

Check a signature with `$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs dist/android/squiggly-<version>-release.apk`. The build runs this check itself.

## Installing

Copy the release APK to the phone and open it, allowing your file manager to install apps when Android asks. Or, with USB debugging on:

```bash
v=$(node -p "require('./package.json').version")
~/.local/share/squiggly-android/sdk/platform-tools/adb install -r dist/android/squiggly-$v-release.apk
```

The debug and release builds share an app id, but not a key, so uninstall one before installing the other.

On the Z Flip 7, apps run on the cover screen once you allow them (Settings › Advanced features › Labs › Apps allowed on cover screen, or Good Lock's MultiStar). Flex Mode needs nothing extra.

## Testing on an emulator

With KVM (`/dev/kvm`), an emulator runs headless. The "6.7in Foldable" profile folds like a Flip:

```bash
A=~/.local/share/squiggly-android
export JAVA_HOME=$A/jdk ANDROID_HOME=$A/sdk ANDROID_AVD_HOME=$A/android-user/avd
$A/sdk/cmdline-tools/latest/bin/sdkmanager emulator 'system-images;android-36;google_apis;x86_64'
echo no | $A/sdk/cmdline-tools/latest/bin/avdmanager create avd -n squiggly-flip -k 'system-images;android-36;google_apis;x86_64' -d '6.7in Foldable'
$A/sdk/emulator/emulator -avd squiggly-flip -no-window -no-audio -no-boot-anim -gpu swangle_indirect -port 5580 &
adb -s emulator-5580 install -r dist/android/squiggly-$(node -p "require('./package.json').version")-debug.apk
adb -s emulator-5580 shell am start -n dev.squiggly.music/.MainActivity
```

(`-gpu swiftshader_indirect` crashed at startup here; `swangle_indirect` works.) Useful checks:

- `adb exec-out screencap -p > shot.png` takes a screenshot.
- `adb shell dumpsys media_session` shows the session's state, position, and song.
- `adb shell dumpsys activity services dev.squiggly.music` shows whether the service is in the foreground.
- `adb emu posture 2` half-opens the hinge and `adb emu posture 3` opens it flat. On the generic "6.7in Foldable" image the device state changes, but Jetpack WindowManager reports no fold (the image has no hinge position or posture mapping), so the app stays flat. To see the Flex Mode layout there, set what the app would: `data-posture="flex"` on `<html>`, with `--fold-top` and `--fold-bottom` in CSS pixels. A real Flip reports the hinge itself.
- `adb shell wm size 948x1048` with `adb shell wm density 420` gives the page the Flip 7 cover screen's 361×399 CSS px, which shows the cover view. It doesn't add the camera cutout. `adb shell wm size reset` and `adb shell wm density reset` undo it. In a browser, a 374×360 or 361×399 window with a screen the same size does the same (the `cover-flip6` and `cover-flip7` Playwright projects).
- The debug build's WebView answers the DevTools protocol: `adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell pidof dev.squiggly.music)`, then `http://127.0.0.1:9333/json` lists the page. Playwright's `connectOverCDP` doesn't work with a WebView, but plain `Runtime.evaluate` over the page's WebSocket does.

Test against a server with an account made for testing, and keep the account's password in environment variables, never in files. To avoid writing to it, turn off Settings › Report what you play and Keep the queue in sync before playing anything. Both are on by default, and in the Android app they're stored in the page's `localStorage` under `squiggly.settings`.

`npm run check` covers the Android page's pure parts: the queue mirroring (`tests/androidQueue.test.ts`) and the MD5 the connector now uses in every build (`tests/auth.test.ts`).
