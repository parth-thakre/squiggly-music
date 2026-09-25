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
| esbuild and its platform binary (compiles extensions at load time) | 0.25.12 | Windows, Fedora | MIT | `resources/licenses/npm-packages.txt` |
| libmpv (`libmpv-2.dll`), built by this repository from source (`build/libmpv`): audio-only mpv with statically linked FFmpeg, libplacebo, libass, FreeType, HarfBuzz, and FriBidi | mpv 0.41.0, FFmpeg 8.1.3 (full list in `NOTICE.md`) | Windows only | LGPL-2.1-or-later as a whole (mpv `-Dgpl=false`, FFmpeg without `--enable-gpl`); the other components are LGPL-2.1-or-later, ISC, MIT, or FTL | `resources/licenses/libmpv-windows/` |
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
  `npm-packages.txt`, `LICENSE.electron.txt`, `LICENSES.chromium.html`, and
  `LICENSE.node.txt` carry them.
- **LGPL-2.1-or-later (Chromium's FFmpeg, libmpv-2.dll):** provide the license text and the
  library's source, and let users replace the library. Electron loads FFmpeg as a separate
  shared library. The audio host loads `libmpv-2.dll` at run time through libmpv's public C
  API, and users can replace it or point `SQUIGGLY_LIBMPV_PATH` at their own build. The
  source bundle is offered from the same place as the binaries (the GitHub release).
- **FreeType License (FTL):** credit FreeType in the documentation. `NOTICE.md` carries the
  credit line.
