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
  years. GPL terms also raise questions about the program that loads the library; see below.

## Open questions for the maintainers

These need a decision, and possibly legal review, before a public release:

1. **Corresponding Source for libmpv.** The shinchiro build compiles most of its ~60
   components from upstream Git heads and does not record their revisions. Only mpv, FFmpeg,
   and the build scripts are pinned to exact commits. The written offer in
   `licenses/libmpv-windows/NOTICE.md` commits the maintainers to supply the complete source,
   which they can't reproduce for the other components today. Options: build libmpv in this
   repository from pinned sources and publish the source archive with each release, or pick a
   build that publishes its complete source.
2. **libdvdcss is statically linked into `libmpv-2.dll`.** It decrypts CSS-protected DVDs,
   and distributing it is legally restricted in some jurisdictions. An audio player doesn't
   need it. A custom build could leave it out, along with DVD, Blu-ray, video encoders (x264,
   x265), and other code the app doesn't use.
3. **GPL and the rest of the app.** `libmpv-2.dll` is GPL-3.0-or-later as built. The app loads
   it through Koffi in a separate Node process. Whether that makes the audio host, or the whole
   app, subject to the GPL is a legal question. An LGPL build of libmpv (`-Dgpl=false`, FFmpeg
   without `--enable-gpl`, no GPL-only libraries) would avoid it. Choosing the project's own
   license depends on the answer.
4. **Unverified component licenses.** The component table in `NOTICE.md` lists licenses the
   upstream projects commonly publish. Nobody has checked them against the revisions actually
   built, and `subrandr`'s license was not determined. The BSD/MIT-style components also
   require their own copyright notices, which are not yet collected.
5. **Patent-encumbered codecs.** Electron's default FFmpeg and the libmpv build include
   decoders for patent-encumbered formats (for example H.264 and AAC). Copyright licenses don't
   cover patents.
6. **Installer tooling.** electron-builder adds `elevate.exe` and the NSIS installer stub
   (zlib/libpng license, with bzip2 portions) to the Windows installer and portable executable.
   Neither license text is included yet.
