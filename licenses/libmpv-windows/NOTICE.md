# libmpv-2.dll (Windows packages only)

Squiggly Music's Windows packages include `resources/runtime/libmpv-2.dll`, an unmodified
third-party build of the mpv media player library. The Fedora RPM does not include it; it
uses the system's `mpv-libs` package.

## Exact build

| Item | Value |
| --- | --- |
| Build project | [shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake) |
| Release | [`20260925`](https://github.com/shinchiro/mpv-winbuild-cmake/releases/tag/20260925), tag commit `05a60b3cfd04e3e3b89918f4a27f3dde2935dff2` |
| CI run | https://github.com/shinchiro/mpv-winbuild-cmake/actions/runs/36075456750 (job "Building mpv (x86_64)") |
| Archive | `mpv-dev-x86_64-20260925-git-2a4eb8067c.7z`, SHA-256 `bae4b8275f4db6ec5a6bb0c0e5d497c305a2aa9fb065097a0d86bb7b86895c7d` |
| DLL | `libmpv-2.dll`, SHA-256 `a6a72c1cdc0f7543632c3bdb1d81b221977f9ca7e81b805c49d657a35e4e56bf` |
| mpv | `v0.41.0-1072-g2a4eb8067`, commit [`2a4eb8067ca68ec19adf23daf8ccbb1a05afd6ed`](https://github.com/mpv-player/mpv/tree/2a4eb8067ca68ec19adf23daf8ccbb1a05afd6ed) |
| FFmpeg | commit [`2f4decb2dc284e9988f3bde45acbaecc91b73599`](https://github.com/FFmpeg/FFmpeg/tree/2f4decb2dc284e9988f3bde45acbaecc91b73599) (from the release's `ffmpeg-x86_64-git-2f4decb2d.7z` asset) |

The mpv build configuration, as embedded in the DLL:

```
-Ddefault_library=shared -Dprefer_static=true -Ddebug=true -Db_ndebug=true -Doptimization=3
-Db_lto=true -Db_lto_mode=thin -Dlibmpv=true -Dpdf-build=enabled -Dlua=enabled -Djavascript=enabled
-Dsdl2-gamepad=enabled -Dlibarchive=enabled -Dlibbluray=enabled -Ddvdnav=enabled -Duchardet=enabled
-Drubberband=enabled -Dlcms2=enabled -Dopenal=enabled -Dspirv-cross=enabled -Dvulkan=enabled
-Dvapoursynth=enabled -Dsubrandr=enabled -Dsixel=enabled -Dgl=enabled -Degl-angle=enabled -Dlibcurl=enabled
```

`-Dgpl` is not set, so mpv's default `gpl=true` applies. FFmpeg is configured with
`--enable-gpl --enable-version3` and without `--enable-nonfree`
([packages/ffmpeg.cmake at the tag commit](https://github.com/shinchiro/mpv-winbuild-cmake/blob/05a60b3cfd04e3e3b89918f4a27f3dde2935dff2/packages/ffmpeg.cmake)).
The full recipe for every component is in
[`packages/` at the tag commit](https://github.com/shinchiro/mpv-winbuild-cmake/tree/05a60b3cfd04e3e3b89918f4a27f3dde2935dff2/packages).

## License

- mpv built with `gpl=true` is GPL version 2 or later: see `mpv-Copyright.txt` and `mpv-LICENSE.GPL.txt`.
- FFmpeg built with `--enable-gpl --enable-version3` is GPL version 3 or later: see `ffmpeg-LICENSE.md` and `ffmpeg-COPYING.GPLv3.txt`.
- The DLL statically links the libraries listed below. Several are GPL-2.0-or-later (x264, x265, rubberband, libdvdread, libdvdnav, libdvdcss).

Taken together, the DLL is distributed under the **GNU General Public License, version 3 or later**.
The license texts for GPLv2, GPLv3, LGPLv2.1, and LGPLv3 are in this directory.

## Statically linked components

The build fetches most components from their upstream Git default branch at build time. The build
does not publish the exact revision of each component, so the versions are not recorded here.
Licenses below are the ones the upstream projects commonly publish; they were not checked against
the exact revisions built.

| Component | License (upstream) |
| --- | --- |
| mpv | GPL-2.0-or-later (this build) |
| FFmpeg | GPL-3.0-or-later (this build) |
| x264, x265, rubberband | GPL-2.0-or-later |
| libdvdread, libdvdnav, libdvdcss | GPL-2.0-or-later |
| libass | ISC |
| libplacebo, libbluray, libudfread, fribidi, lame, libsoxr, game-music-emu, vapoursynth, openal-soft, libssh, libiconv | LGPL-2.1-or-later (lame: LGPL-2.0-or-later; libssh: LGPL-2.1) |
| libzvbi | GPL-2.0-or-later / LGPL-2.0-or-later (per file) |
| uchardet | MPL-1.1 / GPL-2.0-or-later / LGPL-2.1-or-later |
| libsrt | MPL-2.0 |
| openssl | Apache-2.0 |
| vulkan loader, shaderc, SPIRV-Cross, highway | Apache-2.0 (highway: Apache-2.0 or BSD-3-Clause) |
| harfbuzz, expat, libxml2, lcms2, brotli, luajit, libbs2b, libsixel, libvpl, libva, libaribcaption, amf-headers, nvcodec-headers | MIT |
| mujs | ISC |
| freetype2 | FreeType License (FTL) or GPL-2.0 |
| fontconfig | MIT-style (fontconfig license) |
| zlib, libsdl2, libunibreak | Zlib |
| libpng | libpng license |
| libjpeg-turbo | IJG and BSD-3-Clause |
| bzip2 | bzip2 license (BSD-style) |
| xz (liblzma) | 0BSD / public domain |
| zstd | BSD-3-Clause (or GPL-2.0) |
| libvpx, libwebp, opus, ogg, vorbis, speex, libopenmpt, libmysofa, libjxl, uavs3d | BSD-3-Clause |
| aom, dav1d, libarchive, libsamplerate, xxhash | BSD-2-Clause (aom and SVT-AV1 also carry the AOMedia patent license) |
| SVT-AV1 | BSD-3-Clause-Clear |
| libzimg, graphengine | WTFPL |
| libmodplug | Public domain |
| curl | curl license (MIT-style) |
| avisynth headers | GPL-2.0-or-later with a linking exception |
| ANGLE headers | BSD-3-Clause |
| subrandr | Not determined |

## Source code

mpv and FFmpeg source at the exact commits:

- https://github.com/mpv-player/mpv/archive/2a4eb8067ca68ec19adf23daf8ccbb1a05afd6ed.tar.gz
- https://github.com/FFmpeg/FFmpeg/archive/2f4decb2dc284e9988f3bde45acbaecc91b73599.tar.gz
- Build scripts: https://github.com/shinchiro/mpv-winbuild-cmake/archive/05a60b3cfd04e3e3b89918f4a27f3dde2935dff2.tar.gz

### Written offer

For at least three years after the last date we distribute a Windows release of Squiggly Music,
the Squiggly Music maintainers will give anyone who asks, at no more than the cost of physically
performing the distribution, a complete machine-readable copy of the Corresponding Source for
`libmpv-2.dll` as distributed in that release, under the terms of the GNU General Public License,
version 3 or later. To ask, open an issue at https://github.com/parth-thakre/squiggly-music/issues
or contact the repository owner, and name the release version.
