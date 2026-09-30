# Third-party notices

Squiggly Music's release packages redistribute the software below. Each installed desktop
package carries these notices in `resources/licenses/` (this file, `npm-packages.txt`, and on
Windows `libmpv-windows/`) and beside the executable (`LICENSE.electron.txt`,
`LICENSES.chromium.html`). The macOS app keeps all of them in
`Squiggly Music.app/Contents/Resources/licenses/`, `LICENSE.electron.txt` and
`LICENSES.chromium.html` included. The Android APK carries them in `assets/public/licenses/`: this
file, `npm-packages.txt` (the npm packages in its page, with their licence texts),
`android-libraries.txt` (every Android library in it, with its licence), and `apache-2.0.txt`.

Squiggly Music's own source code is released under the MIT License (see [LICENSE](LICENSE)). The components below keep their own licenses.

| Component | Version | Packages | License | Notice in the package |
| --- | --- | --- | --- | --- |
| Electron | 44.4.3 | Windows, macOS, Linux | MIT | `LICENSE.electron.txt` |
| Chromium and its third-party code, including Chromium's FFmpeg (`ffmpeg.dll` / `libffmpeg.so` / `libffmpeg.dylib`) | 152.0.7977.130 | Windows, macOS, Linux | BSD-3-Clause, with many third-party licenses; FFmpeg: LGPL-2.1-or-later | `LICENSES.chromium.html` |
| Node.js (audio-host runtime) | v22.23.3 | Windows, macOS, Linux | MIT, plus the licenses of its bundled dependencies (OpenSSL, ICU, libuv, V8, and others) | `resources/runtime/LICENSE.node.txt` |
| Koffi and its platform binary | 3.3.1 | Windows, macOS, Linux | MIT | `resources/licenses/npm-packages.txt` |
| esbuild and its platform binary (compiles extensions at load time) | 0.25.12 | Windows, macOS, Linux | MIT | `resources/licenses/npm-packages.txt` |
| libmpv (`libmpv-2.dll`), built by this repository from source (`build/libmpv`): audio-only mpv with statically linked FFmpeg, libplacebo, libass, FreeType, HarfBuzz, and FriBidi | mpv 0.41.0, FFmpeg 8.1.3 (full list in `NOTICE.md`) | Windows only | LGPL-2.1-or-later as a whole (mpv `-Dgpl=false`, FFmpeg without `--enable-gpl`); the other components are LGPL-2.1-or-later, ISC, MIT, or FTL | `resources/licenses/libmpv-windows/` |
| npm runtime packages: effect, @jellybrick/mpris-service, @jellybrick/dbus-next, fast-xml-parser and its dependencies, fast-check, pure-rand, music-metadata and its dependencies, electron-updater and its dependencies, and others | see `npm-packages.txt` | Windows, macOS, Linux | MIT, ISC, BSD-3-Clause (ieee754), BlueOak-1.0.0 (sax), Python-2.0 (argparse) | `resources/licenses/npm-packages.txt` |
| Renderer bundle: React, React DOM, scheduler (MIT), lucide-react (ISC) | see `npm-packages.txt` | Windows, macOS, Linux, Android | MIT, ISC | `resources/licenses/npm-packages.txt`; Android: `assets/public/licenses/npm-packages.txt` |
| Fonts: Familjen Grotesk, Young Serif (via @fontsource) | 5.3.0 | Windows, macOS, Linux, Android | SIL Open Font License 1.1 | `resources/licenses/npm-packages.txt`; Android: `assets/public/licenses/npm-packages.txt` |
| effect (the connector runs in the Android app's page) | 3.22.2 | Android (and the desktop, above) | MIT | `assets/public/licenses/npm-packages.txt` |
| Capacitor: `@capacitor/core` (in the page) and `@capacitor/android` (the native bridge and WebView host) | 8.5.2 | Android | MIT | `assets/public/licenses/npm-packages.txt` |
| AndroidX Media3: ExoPlayer, session, datasource, extractor, decoder, and their common modules | 1.11.1 | Android | Apache-2.0 | `assets/public/licenses/android-libraries.txt`, `apache-2.0.txt` |
| Other Android libraries: AndroidX (AppCompat, Core, Activity, Fragment, Lifecycle, Window, WebKit, Media, and others), Guava and failureaccess, the Kotlin standard library, kotlinx-coroutines, JSpecify, JetBrains annotations, Apache Cordova's Android framework (a dependency of Capacitor's) | see `android-libraries.txt` | Android | Apache-2.0 | `assets/public/licenses/android-libraries.txt`, `apache-2.0.txt` |
| Squirrel.Mac, Mantle, and ReactiveObjC, frameworks inside Electron's macOS app | as shipped with Electron 44.4.3 | macOS | MIT (upstream, not verified here) | Not yet included |
| electron-builder's `elevate.exe` and NSIS installer stub | electron-builder 26 | Windows | elevate: MIT (upstream jpassing/elevate, not verified); NSIS: zlib/libpng | Not yet included |
| electron-builder's AppImage runtime and the libraries it adds in `usr/lib`: libappindicator, libindicator, libgconf-2, libnotify, libXss, libXtst. Electron links none of them; it only looks for libnotify when an app shows notifications, which Squiggly doesn't | AppImage toolset 12.0.1 | AppImage | runtime: AppImageKit, MIT, with the compression and squashfs libraries it links statically (not listed yet); per Fedora's packages of the same libraries: libindicator GPL-3.0-only, libappindicator LGPL-2.1 and LGPL-3.0, GConf LGPL-2.0-or-later, libnotify LGPL-2.1-or-later, libXss and libXtst X11-style permissive (not verified against the bundled builds) | Not yet included |

The Linux packages do not include libmpv. The RPM depends on Fedora's `mpv-libs` and the deb
on Debian's or Ubuntu's `libmpv2` (or `libmpv1`), which the distributions ship under their own
terms. The AppImage uses whichever libmpv the system has installed.

The Flatpak manifest (`build/flatpak`, untested and not released) builds an audio-only,
LGPL-2.1-or-later libmpv from the sources pinned in `build/libmpv/sources.json` and installs
their license texts in `/app/share/licenses/dev.squiggly.music/libmpv`. Its FreeType, HarfBuzz,
FriBiDi, and GnuTLS come from the Freedesktop runtime.

The macOS app does not include libmpv either. It loads the copy the user installs from
Homebrew (`brew install mpv`) or MacPorts, which they distribute under their own terms
(Homebrew's mpv: GPL-2.0-or-later and LGPL-2.1-or-later). The notice check fails a macOS
package that contains one.

For the Android app, `scripts/android-notices.ts` writes `npm-packages.txt` from the modules
the bundler actually put in the page, and `scripts/android.mjs` writes `android-libraries.txt`
from Gradle's resolved release classpath. Both fail the build on a licence nobody has
reviewed. None of the Android libraries ship a NOTICE file that Apache-2.0 would require
passing on.

`scripts/release-notices.mjs` runs after electron-builder copies the app. It writes
`npm-packages.txt` from `package-lock.json` and the installed packages, and fails the build
when a required notice file is missing, a production package has a license outside the
reviewed list, or a shipped package is missing from the inventory.

## Source code for LGPL components

- **libmpv (Windows):** each Windows release attaches
  `Squiggly-Music-<version>-libmpv-windows-x64-source.tar`, with every source tarball the
  DLL is built from and the build recipe. The recipe is `build/libmpv` in this repository;
  it pins each source by URL and SHA-256 and the toolchain by container image digest and
  Debian snapshot date, and it reproduces the shipped DLL bit for bit. Versions, upstream
  commits, and licenses are in
  [`licenses/libmpv-windows/NOTICE.md`](licenses/libmpv-windows/NOTICE.md).
- **Chromium's FFmpeg in Electron 44.4.3:** Electron source at
  https://github.com/electron/electron/tree/v44.4.3, which pins Chromium 152.0.7977.130;
  FFmpeg is under `third_party/ffmpeg` in the Chromium source at
  https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130.

## Obligations commonly associated with these licenses

This is a summary of what these licenses usually require, not legal advice.

- **MIT, ISC, BSD, Zlib, OFL:** keep the copyright notice and license text with each copy.
- **Apache-2.0 (AndroidX, Media3, Guava, Kotlin, and the rest of the Android libraries):**
  include the license text and any NOTICE file the component carries, and state changes made
  to it. The APK includes `apache-2.0.txt`; Squiggly uses these libraries unmodified.
  `npm-packages.txt`, `LICENSE.electron.txt`, `LICENSES.chromium.html`, and
  `LICENSE.node.txt` carry them.
- **LGPL-2.1-or-later (Chromium's FFmpeg, libmpv-2.dll):** provide the license text and the
  library's source, and let users replace the library. Electron loads FFmpeg as a separate
  shared library. The audio host loads `libmpv-2.dll` at run time through libmpv's public C
  API, and users can replace it or point `SQUIGGLY_LIBMPV_PATH` at their own build. The
  source bundle is offered from the same place as the binaries (the GitHub release).
- **FreeType License (FTL):** credit FreeType in the documentation. `NOTICE.md` carries the
  credit line.
