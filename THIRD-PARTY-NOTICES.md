# Third-party notices

Squiggly Music's release packages redistribute the software below. Each installed package
carries these notices in `resources/licenses/` (this file, `npm-packages.txt`, and on
Windows `libmpv-windows/`) and beside the executable (`LICENSE.electron.txt`,
`LICENSES.chromium.html`).

Squiggly Music's own source code is released under the MIT License (see [LICENSE](LICENSE)). The components below keep their own licenses.

| Component | Version | Packages | License | Notice in the package |
| --- | --- | --- | --- | --- |
| Electron | 44.4.3 | Windows, Fedora | MIT | `LICENSE.electron.txt` |
| Chromium and its third-party code, including Chromium's FFmpeg (`ffmpeg.dll` / `libffmpeg.so`) | 152.0.7977.130 | Windows, Fedora | BSD-3-Clause, with many third-party licenses; FFmpeg: LGPL-2.1-or-later | `LICENSES.chromium.html` |
| Node.js (audio-host runtime) | v22.23.3 | Windows, Fedora | MIT, plus the licenses of its bundled dependencies (OpenSSL, ICU, libuv, V8, and others) | `resources/runtime/LICENSE.node.txt` |
| Koffi and its platform binary | 3.3.1 | Windows, Fedora | MIT | `resources/licenses/npm-packages.txt` |
| libmpv (`libmpv-2.dll`, shinchiro/mpv-winbuild-cmake `20260925`) with statically linked FFmpeg and about 60 other libraries | mpv `2a4eb8067c`, FFmpeg `2f4decb2d` | Windows only | GPL-3.0-or-later as a whole (mpv GPLv2+, FFmpeg `--enable-gpl --enable-version3`) | `resources/licenses/libmpv-windows/` |
| npm runtime packages: effect, @jellybrick/mpris-service, @jellybrick/dbus-next, fast-xml-parser and its dependencies, fast-check, pure-rand, and others | see `npm-packages.txt` | Windows, Fedora | MIT | `resources/licenses/npm-packages.txt` |
| Renderer bundle: React, React DOM, scheduler (MIT), lucide-react (ISC) | see `npm-packages.txt` | Windows, Fedora | MIT, ISC | `resources/licenses/npm-packages.txt` |
| Fonts: Familjen Grotesk, Young Serif (via @fontsource) | 5.3.0 | Windows, Fedora | SIL Open Font License 1.1 | `resources/licenses/npm-packages.txt` |
| electron-builder's `elevate.exe` and NSIS installer stub | electron-builder 26 | Windows | elevate: MIT (upstream jpassing/elevate, not verified); NSIS: zlib/libpng | Not yet included |

The Fedora RPM does not include libmpv. It depends on Fedora's `mpv-libs` package, which
Fedora distributes under its own terms.

`scripts/release-notices.mjs` runs after electron-builder copies the app. It writes
`npm-packages.txt` from `package-lock.json` and the installed packages, and fails the build
when a required notice file is missing, a production package has a license outside the
reviewed list, or a shipped package is missing from the inventory.

## Source code for GPL and LGPL components

- **libmpv (Windows):** exact mpv, FFmpeg, and build-script commits, the build configuration,
  the list of statically linked components, and a written offer for the Corresponding Source are in
  [`licenses/libmpv-windows/NOTICE.md`](licenses/libmpv-windows/NOTICE.md).
- **Chromium's FFmpeg in Electron 44.4.3:** Electron source at
  https://github.com/electron/electron/tree/v44.4.3, which pins Chromium 152.0.7977.130;
  FFmpeg is under `third_party/ffmpeg` in the Chromium source at
  https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.130.

## Obligations commonly associated with these licenses

This is a summary of what these licenses usually require, not legal advice.

- **MIT, ISC, BSD, Zlib, OFL:** keep the copyright notice and license text with each copy.
  `npm-packages.txt`, `LICENSE.electron.txt`, `LICENSES.chromium.html`, and
  `LICENSE.node.txt` carry them.
- **LGPL-2.1 (Chromium's FFmpeg):** provide the license text and the library's source, and
  let users replace the library. Electron loads FFmpeg as a separate shared library.
- **GPL-3.0-or-later (libmpv-2.dll):** provide the license text, and either ship the complete
  Corresponding Source with the binary or include a written offer valid for at least three
  years.
