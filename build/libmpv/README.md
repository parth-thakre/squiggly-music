# Squiggly Music: Windows libmpv build

This directory builds `libmpv-2.dll`, the audio library in Squiggly Music's Windows
packages. It is an audio-only build of mpv and FFmpeg, licensed as a whole under the
GNU Lesser General Public License, version 2.1 or later. Each Windows release attaches
`libmpv-windows-x64-source.tar`, which holds this directory and every source tarball
the build used, so the DLL can be rebuilt and replaced.

## Rebuild

With podman (or docker) on Linux, from a Squiggly Music checkout:

```bash
npm run libmpv:build     # writes .local/libmpv-windows/
```

From the source bundle alone, without the rest of the repository:

```bash
tar -xf libmpv-windows-x64-source.tar && cd libmpv-windows-x64-source
podman build -t squiggly-libmpv-build -f recipe/Containerfile recipe
mkdir out && podman run --rm --network=none --security-opt label=disable \
  -v "$PWD/recipe:/recipe:ro" -v "$PWD/sources:/sources:ro" -v "$PWD/out:/out" \
  squiggly-libmpv-build bash /recipe/build.sh
```

To use a modified build, replace `resources\runtime\libmpv-2.dll` in the installed app
(or set `SQUIGGLY_LIBMPV_PATH` to its full path). The app loads the DLL at run time
through libmpv's public C API, so any compatible libmpv works.

## Files

| File | Purpose |
| --- | --- |
| `sources.json` | Every source tarball: URL, version, upstream commit, SHA-256, license. The base image digest and apt snapshot date. |
| `Containerfile` | The toolchain: Debian trixie by digest, packages from snapshot.debian.org at a fixed date. `toolchain-packages.txt` in the bundle lists the exact versions. |
| `build.sh` | Verifies the tarballs, builds fribidi, FreeType, HarfBuzz, libass, libplacebo, FFmpeg, then mpv as a DLL. Writes the DLL, the license files, `build-info.json`, and the source bundle. |
| `cross-x86_64-w64-mingw32.ini` | Meson cross file (mingw-w64, win32 thread model). |
| `build.mjs`, `recipe.mjs` | Host driver: downloads and checks the sources, runs the container, writes `manifest.json`. |

No source file is patched.

## What is in the DLL

- mpv 0.41.0 with `-Dgpl=false`: libmpv only, WASAPI and null audio outputs, no video
  outputs, no Lua or JavaScript, no disc, archive, or hardware-decoding support. C plugin
  support stays in only because mpv drops the `load-scripts` option without a script
  backend, and the app sets that option to `no`.
- FFmpeg 8.1.3, LGPL configuration (no `--enable-gpl`, `--enable-version3`, or
  `--enable-nonfree`) with only these components:
  - demuxers: AAC (ADTS), AIFF, APE, ASF (WMA), CAF, DSF, IFF (DSDIFF), FLAC, Matroska/WebM,
    MP4/M4A (mov), MP3, Musepack, Ogg, TTA, W64, WAV, WavPack
  - decoders: AAC, ALAC, APE, DSD (all four layouts), DST, FLAC, MP1/MP2/MP3, Musepack, Opus,
    TTA, Vorbis, WavPack, WMA (v1, v2, Pro, Lossless), all PCM variants
  - protocols: file, http, https (TLS through Windows Schannel), tcp, tls, data
  - filters: a small set of audio filters for mpv's `af` option
  - libswresample for resampling; libswscale and libavfilter because mpv requires them
- libplacebo, libass, FreeType, HarfBuzz, and fribidi, which mpv requires at build time.
  The app never uses them (no video, no subtitles).
