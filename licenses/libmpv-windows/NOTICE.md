# libmpv-2.dll (Windows packages only)

Squiggly Music's Windows packages include `resources/runtime/libmpv-2.dll`, an audio-only
build of the mpv media player library that Squiggly Music builds from source. The Fedora
RPM does not include it; it uses the system's `mpv-libs` package.

The DLL is licensed as a whole under the **GNU Lesser General Public License, version 2.1
or later** (LGPL-2.1-or-later). `mpv-LICENSE.LGPL.txt` and `ffmpeg-COPYING.LGPLv2.1.txt` in
this directory hold the license text.

## Source code

Each Windows release on https://github.com/parth-thakre/squiggly-music/releases attaches
`Squiggly-Music-<version>-libmpv-windows-x64-source.tar`. It holds every source tarball
listed below, unmodified, with the build recipe (`build/libmpv` in the repository at the
release tag), so you can rebuild the DLL. The build is reproducible: the recipe records
the SHA-256 of the DLL it produces, and a rebuild gives the same file.

The app loads the DLL at run time through libmpv's public C API. To use a modified
library, replace `resources\runtime\libmpv-2.dll` with your build, or set the
`SQUIGGLY_LIBMPV_PATH` environment variable to its full path.

## Build

| Item | Value |
| --- | --- |
| DLL SHA-256 | `82456cd5631507070606a2879e68dd3003ff78b8a891840eed671734e56b9fd4` |
| Toolchain | Debian trixie image `debian:trixie-20260918-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a`, packages from snapshot.debian.org at `20260918T000000Z`: mingw-w64 GCC 14 (win32 thread model), binutils 2.44, mingw-w64 12.0.0, meson 1.7.0 |
| mpv options | `-Dgpl=false -Dlibmpv=true -Dcplayer=false -Dcplugins=enabled`, WASAPI audio output, every video output, GPU API, scripting language, disc, archive, and hardware-decoding feature disabled. C plugins stay enabled only because mpv otherwise drops the `load-scripts` option, which the app sets to `no`. |
| FFmpeg options | `--disable-autodetect --disable-everything` plus a list of audio demuxers, decoders, and parsers, the file/http/https/tcp/tls/data protocols with Windows Schannel for TLS, and a few audio filters. No `--enable-gpl`, `--enable-version3`, or `--enable-nonfree`. |

`build/libmpv/README.md` in the source bundle lists the exact components. The build
fails if FFmpeg reports a GPL, version 3, or nonfree configuration, if mpv compiles any
of the GPL-only files listed in `mpv-Copyright.txt`, or if the DLL imports anything other
than Windows system libraries.

## Components

| Component | Version | Source | License | License file |
| --- | --- | --- | --- | --- |
| mpv | 0.41.0 (commit `41f6a645068483470267271e1d09966ca3b9f413`) | https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz | LGPL-2.1-or-later (built with `-Dgpl=false`) | `mpv-Copyright.txt`, `mpv-LICENSE.LGPL.txt` |
| FFmpeg (libavcodec, libavformat, libavfilter, libavutil, libswresample, libswscale) | 8.1.3 (commit `1041abdc962f4cc4f394aa8de9dc5236c0c3b9e7`) | https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz | LGPL-2.1-or-later | `ffmpeg-LICENSE.md`, `ffmpeg-COPYING.LGPLv2.1.txt` |
| libplacebo | 7.360.1 (commit `cee9b076f2c63104ccfd497fa79c39a867293ec4`) | https://code.videolan.org/videolan/libplacebo/-/archive/v7.360.1/libplacebo-v7.360.1.tar.gz | LGPL-2.1-or-later | `libplacebo-LICENSE.txt` |
| fast_float (compiled into libplacebo) | commit `97b54ca9e75f5303507699d27c6b4f4efe4641a1` | https://github.com/fastfloat/fast_float/archive/97b54ca9e75f5303507699d27c6b4f4efe4641a1.tar.gz | MIT (offered as Apache-2.0, MIT, or BSL-1.0) | `fast_float-LICENSE-MIT.txt` |
| libass | 0.17.5 | https://github.com/libass/libass/releases/download/0.17.5/libass-0.17.5.tar.xz | ISC | `libass-COPYING.txt` |
| FreeType | 2.14.3 | https://download.savannah.gnu.org/releases/freetype/freetype-2.14.3.tar.xz | FreeType License (FTL), chosen from FTL or GPL-2.0 | `freetype-LICENSE.TXT`, `freetype-FTL.TXT` |
| HarfBuzz | 14.5.0 | https://github.com/harfbuzz/harfbuzz/releases/download/14.5.0/harfbuzz-14.5.0.tar.xz | MIT ("Old MIT") | `harfbuzz-COPYING.txt` |
| GNU FriBidi | 1.0.17 | https://github.com/fribidi/fribidi/releases/download/v1.0.17/fribidi-1.0.17.tar.xz | LGPL-2.1-or-later | `fribidi-COPYING.txt` |
| mingw-w64 C runtime (libmingw32, libmingwex) | 12.0.0 (Debian `mingw-w64` package) | Debian source package `mingw-w64` | ZPL-2.1, public domain, and permissive licenses | `mingw-w64-runtime-copyright.txt` |
| GCC runtime (libgcc, libstdc++, libatomic) | GCC 14 (Debian `gcc-mingw-w64`) | Debian source package `gcc-mingw-w64` | GPL-3.0-or-later with the GCC Runtime Library Exception, which allows distribution under any terms | None required |

Portions of this software are copyright © 2026 The FreeType Project
(https://freetype.org). All rights reserved.

These build-time inputs are in the source bundle but not in the DLL: jinja and markupsafe
(BSD-3-Clause, libplacebo's shader code generator), and Vulkan-Headers (Apache-2.0 or MIT,
type declarations for libplacebo's Vulkan stubs; Vulkan support is disabled).

mpv requires libplacebo and libass at build time. Squiggly Music uses neither: it
disables video, and it doesn't display subtitles.
