#!/usr/bin/env bash
# Builds an audio-only, LGPL-2.1-or-later libmpv-2.dll for Windows x64 from the tarballs
# pinned in sources.json. Runs inside the Containerfile image with no network:
#
#   /recipe   this directory (read-only)
#   /sources  the downloaded tarballs (read-only)
#   /out      output: libmpv-2.dll, build-info.json, licenses/, the source bundle
#
# Normally started by build.mjs (`npm run libmpv:build`). To run it by hand:
#   podman build -t squiggly-libmpv-build -f build/libmpv/Containerfile build/libmpv
#   podman run --rm --network=none --security-opt label=disable \
#     -v "$PWD/build/libmpv:/recipe:ro" -v "$PWD/.local/downloads:/sources:ro" -v "$PWD/out-dir:/out" \
#     squiggly-libmpv-build bash /recipe/build.sh
#
# Licensing constraints this script keeps (see licenses/libmpv-windows/NOTICE.md):
# - FFmpeg: no --enable-gpl, --enable-version3, or --enable-nonfree; no external libraries
#   except Windows' own Schannel for TLS.
# - mpv: -Dgpl=false, which makes mpv LGPL-2.1-or-later and removes its GPL-only code.
# - Every other linked library is LGPL-2.1-or-later or permissive (ISC, MIT, FTL).
set -euo pipefail

RECIPE=/recipe SRC=/sources OUT=/out
WORK=/build PREFIX=/build/prefix
HOST=x86_64-w64-mingw32
JOBS=$(nproc)
json() { python3 -c "import json,sys; d=json.load(open('$RECIPE/sources.json')); print($1)"; }

export SOURCE_DATE_EPOCH=$(json "d['sourceDateEpoch']")
export TZ=UTC LC_ALL=C.UTF-8
export PKG_CONFIG_LIBDIR=$PREFIX/lib/pkgconfig PKG_CONFIG_PATH=
# Map build paths out of debug strings and __FILE__, so the output does not depend on them.
CFLAGS_COMMON="-O2 -pipe -ffile-prefix-map=$WORK/src/=src/ -fno-ident"
CROSS=$RECIPE/cross-x86_64-w64-mingw32.ini
mkdir -p "$WORK/src" "$PREFIX" "$OUT"

echo "== Verifying sources"
json "'\n'.join(s['sha256']+'  '+s['file'] for s in d['sources'])" > "$WORK/SHA256SUMS"
(cd "$SRC" && sha256sum --strict -c "$WORK/SHA256SUMS")

unpack() { # unpack <name> [<destination>]
  local file dest=${2:-$WORK/src/$1}
  file=$(json "next(s['file'] for s in d['sources'] if s['name']=='$1')")
  mkdir -p "$dest"
  tar -xf "$SRC/$file" -C "$dest" --strip-components=1 --no-same-owner
}

meson_build() { # meson_build <name> [meson options...]
  local name=$1; shift
  echo "== Building $name"
  meson setup "$WORK/build-$name" "$WORK/src/$name" --cross-file "$CROSS" \
    --prefix "$PREFIX" --libdir lib --buildtype release --default-library static \
    --wrap-mode nodownload -Db_ndebug=true -Dc_args="$CFLAGS_COMMON" -Dcpp_args="$CFLAGS_COMMON" "$@"
  ninja -C "$WORK/build-$name" -j "$JOBS"
  ninja -C "$WORK/build-$name" install >/dev/null
}

# Private static dependencies only: no DLLs, no import libraries.
unpack fribidi
meson_build fribidi -Ddocs=false -Dbin=false -Dtests=false -Ddeprecated=false

unpack freetype
meson_build freetype -Dbrotli=disabled -Dbzip2=disabled -Dharfbuzz=disabled -Dpng=disabled \
  -Dzlib=disabled -Dtests=disabled

unpack harfbuzz
meson_build harfbuzz -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled \
  -Dchafa=disabled -Dpng=disabled -Dzlib=disabled -Dicu=disabled -Draster=disabled -Dvector=disabled \
  -Dgpu=disabled -Dgpu_demo=disabled -Dsubset=disabled -Dtests=disabled -Dintrospection=disabled \
  -Ddocs=disabled -Dutilities=disabled

# mpv requires libass even with subtitles unused. DirectWrite is a Windows system API.
unpack libass
meson_build libass -Dfontconfig=disabled -Ddirectwrite=enabled -Dcoretext=disabled -Dasm=disabled \
  -Dlibunibreak=disabled -Drequire-system-font-provider=false -Dtest=disabled -Dcompare=disabled \
  -Dprofile=disabled -Dfuzz=disabled -Dcheckasm=disabled

# mpv requires libplacebo. Every GPU backend is off; only the CPU-side library is built.
unpack libplacebo
for sub in fast_float jinja markupsafe Vulkan-Headers; do
  rm -rf "$WORK/src/libplacebo/3rdparty/$sub"; unpack "$sub" "$WORK/src/libplacebo/3rdparty/$sub"
done
meson_build libplacebo -Dvulkan=disabled -Dopengl=disabled -Dd3d11=disabled -Dglslang=disabled \
  -Dshaderc=disabled -Dlcms=disabled -Ddovi=disabled -Dlibdovi=disabled -Dunwind=disabled \
  -Dxxhash=disabled -Ddemos=false -Dtests=false -Dbench=false -Dfuzz=false

# C++ libraries: static consumers linked by the C driver need libstdc++ explicitly.
python3 - "$PKG_CONFIG_LIBDIR"/libplacebo.pc "$PKG_CONFIG_LIBDIR"/harfbuzz.pc <<'EOF'
import sys
for path in sys.argv[1:]:
    lines = open(path).read().splitlines()
    private = [i for i, line in enumerate(lines) if line.startswith('Libs.private:')]
    if private: lines[private[0]] += ' -lstdc++'
    else: lines.append('Libs.private: -lstdc++')
    open(path, 'w').write('\n'.join(lines) + '\n')
EOF

echo "== Building FFmpeg"
unpack ffmpeg
FFMPEG_DEMUXERS=aac,aiff,ape,asf,caf,dsf,flac,iff,matroska,mov,mp3,mpc,mpc8,ogg,tta,w64,wav,wv
FFMPEG_DECODERS=aac,aac_latm,alac,ape,dsd_lsbf,dsd_lsbf_planar,dsd_msbf,dsd_msbf_planar,dst,flac,mp1,mp1float,mp2,mp2float,mp3,mp3float,mpc7,mpc8,opus,tta,vorbis,wavpack,wmalossless,wmapro,wmav1,wmav2,'pcm_*'
FFMPEG_PARSERS=aac,aac_latm,flac,mpegaudio,opus,vorbis
FFMPEG_PROTOCOLS=file,http,https,httpproxy,tcp,tls,data
FFMPEG_FILTERS=acompressor,aformat,alimiter,anull,aresample,bass,dynaudnorm,equalizer,highpass,loudnorm,lowpass,pan,treble,volume
mkdir -p "$WORK/build-ffmpeg"
(cd "$WORK/build-ffmpeg" && "$WORK/src/ffmpeg/configure" \
  --prefix="$PREFIX" --target-os=mingw32 --arch=x86_64 --enable-cross-compile \
  --cross-prefix=$HOST- --cc=$HOST-gcc-win32 --cxx=$HOST-g++-win32 \
  --pkg-config=pkgconf --pkg-config-flags=--static --extra-cflags="$CFLAGS_COMMON" \
  --enable-static --disable-shared \
  --disable-autodetect --disable-everything --disable-programs --disable-doc --disable-debug \
  --disable-avdevice --enable-w32threads --enable-network --enable-schannel \
  --enable-demuxer=$FFMPEG_DEMUXERS --enable-decoder="$FFMPEG_DECODERS" --enable-parser=$FFMPEG_PARSERS \
  --enable-protocol=$FFMPEG_PROTOCOLS --enable-filter=$FFMPEG_FILTERS --enable-bsf=null)
# Refuse a GPL, version3, or nonfree configuration even if the flags above change.
if grep -qE '^#define CONFIG_(GPL|VERSION3|NONFREE) 1' "$WORK/build-ffmpeg/config.h"; then
  echo "FFmpeg is configured with GPL, version3, or nonfree components." >&2; exit 1
fi
grep -q 'LGPL version 2.1 or later' "$WORK/build-ffmpeg/config.h"
make -C "$WORK/build-ffmpeg" -j "$JOBS" >/dev/null
make -C "$WORK/build-ffmpeg" install >/dev/null

echo "== Building mpv"
# C plugins stay enabled only so mpv defines the load-scripts option, which the app sets
# to "no" (with config=no). mpv omits that option when no script backend is built.
unpack mpv
meson setup "$WORK/build-mpv" "$WORK/src/mpv" --cross-file "$CROSS" \
  --prefix "$PREFIX" --libdir lib --buildtype release --wrap-mode nodownload -Db_ndebug=true \
  --default-library shared -Dprefer_static=true \
  -Dc_args="$CFLAGS_COMMON" \
  -Dc_link_args="-static -Wl,--no-insert-timestamp -Wl,-Map=$WORK/libmpv.map" \
  -Dgpl=false -Dlibmpv=true -Dcplayer=false -Dtests=false -Dfuzzers=false -Dbuild-date=false \
  -Dwin32-threads=enabled -Dwasapi=enabled \
  -Dcplugins=enabled \
  -Dcdda=disabled -Ddvbin=disabled -Ddvdnav=disabled -Diconv=disabled \
  -Djavascript=disabled -Djpeg=disabled -Dlcms2=disabled -Dlibarchive=disabled -Dlibavdevice=disabled \
  -Dlibbluray=disabled -Dlua=disabled -Drubberband=disabled -Dsdl2-gamepad=disabled -Duchardet=disabled \
  -Duwp=disabled -Dvapoursynth=disabled -Dzimg=disabled -Dzlib=disabled \
  -Dopenal=disabled -Djack=disabled -Dsdl2-audio=disabled -Dpipewire=disabled -Dpulse=disabled \
  -Dcaca=disabled -Dd3d11=disabled -Ddirect3d=disabled -Degl=disabled -Degl-angle=disabled \
  -Degl-angle-lib=disabled -Degl-angle-win32=disabled -Dgl=disabled -Dgl-win32=disabled \
  -Dgl-dxinterop=disabled -Dplain-gl=disabled -Dsdl2-video=disabled -Dshaderc=disabled -Dsixel=disabled \
  -Dspirv-cross=disabled -Dvulkan=disabled -Dd3d-hwaccel=disabled -Dd3d9-hwaccel=disabled \
  -Dgl-dxinterop-d3d9=disabled -Dcuda-hwaccel=disabled -Dcuda-interop=disabled -Dvaapi=disabled \
  -Dwin32-smtc=disabled -Dhtml-build=disabled -Dmanpage-build=disabled -Dpdf-build=disabled
ninja -C "$WORK/build-mpv" -j "$JOBS"
# mpv's Copyright file lists the sources that stay GPL-only. Fail if any was compiled.
python3 - "$WORK/build-mpv" <<'EOF'
import json, re, subprocess, sys
targets = json.loads(subprocess.run(['meson', 'introspect', '--targets', sys.argv[1]], check=True, capture_output=True, text=True).stdout)
sources = [s for t in targets for group in t['target_sources'] for s in group.get('sources', [])]
gpl_only = re.compile(r'audio/out/ao_(jack|oss)\.c|stream/(dvb|stream_cdda|stream_dvb|stream_dvdnav)'
                      r'|video/out/(vo_(caca|direct3d|vaapi|vdpau|x11|xv)\.c|x11_common)|video/vdpau')
compiled = [s for s in sources if gpl_only.search(s)]
if compiled: sys.exit('GPL-only mpv sources were compiled: ' + ' '.join(compiled))
print(f'mpv: {len(sources)} sources compiled, none of them GPL-only.')
EOF

echo "== Collecting output"
rm -rf "${OUT:?}"/*
$HOST-strip --strip-unneeded -o "$OUT/libmpv-2.dll" "$WORK/build-mpv/libmpv-2.dll"
# The DLL must import only Windows system libraries.
imports=$($HOST-objdump -p "$OUT/libmpv-2.dll" | sed -n 's/^\s*DLL Name: //p' | tr 'A-Z' 'a-z' | sort -u)
echo "Imports: $(echo $imports)"
for dll in $imports; do
  case $dll in
    kernel32.dll|user32.dll|advapi32.dll|ole32.dll|oleaut32.dll|shell32.dll|shlwapi.dll|gdi32.dll|\
    ws2_32.dll|secur32.dll|crypt32.dll|bcrypt.dll|ncrypt.dll|avrt.dll|winmm.dll|dwrite.dll|uuid.dll|\
    msvcrt.dll|version.dll|api-ms-win-*.dll|ntdll.dll|psapi.dll|imm32.dll|dwmapi.dll|propsys.dll|shcore.dll|uxtheme.dll) ;;
    *) echo "Unexpected DLL import: $dll" >&2; exit 1 ;;
  esac
done
# Record which static archives the linker used, for the notices.
linked=$(grep -oE '/[^ ()]*\.a\b' "$WORK/libmpv.map" | xargs -n1 basename | sort -u | tr '\n' ' ')
echo "Linked archives: $linked"

mkdir -p "$OUT/licenses"
python3 - "$RECIPE/sources.json" "$WORK/src" "$OUT/licenses" <<'EOF'
import json, shutil, sys, os
sources, src, out = sys.argv[1:]
for s in json.load(open(sources))['sources']:
    for f in s.get('licenseFiles', []):
        name = f"{s['name']}-{os.path.basename(f)}"
        if not name.lower().endswith(('.txt', '.md')): name += '.txt'  # opens on Windows
        shutil.copyfile(os.path.join(src, s['name'], f) if s['name'] != 'fast_float'
                        else os.path.join(src, 'libplacebo', '3rdparty', 'fast_float', f),
                        os.path.join(out, name))
EOF
# The mingw-w64 C runtime (libmingw32, libmingwex) is linked statically; parts of it are
# under the ZPL-2.1, which asks binary distributions to carry its notice. libgcc and
# libstdc++ are covered by the GCC Runtime Library Exception and need no notice.
cp /usr/share/doc/mingw-w64-x86-64-dev/copyright "$OUT/licenses/mingw-w64-runtime-copyright.txt"

echo "== Writing the source bundle"
BUNDLE=$WORK/bundle/libmpv-windows-x64-source
mkdir -p "$BUNDLE/sources" "$BUNDLE/recipe"
cp -a "$RECIPE"/. "$BUNDLE/recipe/"
json "'\n'.join(s['file'] for s in d['sources'])" | while read -r file; do cp "$SRC/$file" "$BUNDLE/sources/"; done
cp "$RECIPE/README.md" "$BUNDLE/README.md"
dpkg-query -W -f '${Package} ${Version}\n' > "$BUNDLE/toolchain-packages.txt"
tar --sort=name --mtime=@"$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner --format=gnu \
  -cf "$OUT/libmpv-windows-x64-source.tar" -C "$WORK/bundle" libmpv-windows-x64-source

python3 - "$OUT" "$WORK" "$linked" <<'EOF'
import json, re, subprocess, sys
out, work, linked = sys.argv[1:]
def run(*cmd): return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
config = open(f'{work}/build-ffmpeg/config.h').read()
info = {
  'ffmpegConfiguration': re.search(r'#define FFMPEG_CONFIGURATION "(.*)"', config).group(1),
  'ffmpegLicense': re.search(r'#define FFMPEG_LICENSE "(.*)"', config).group(1),
  'mpvOptions': {o['name']: o['value'] for o in json.loads(run('meson', 'introspect', '--buildoptions', f'{work}/build-mpv'))
                 if o['section'] == 'user'},
  'linkedArchives': linked.split(),
  'toolchain': {
    'gcc': run('x86_64-w64-mingw32-gcc-win32', '--version').splitlines()[0],
    'binutils': run('x86_64-w64-mingw32-ld', '--version').splitlines()[0],
    'meson': run('meson', '--version').strip(),
    'packages': run('dpkg-query', '-W', '-f', '${Package}=${Version}\n').split(),
  },
}
json.dump(info, open(f'{out}/build-info.json', 'w'), indent=2)
EOF

# Docker runs as root; hand the output back to the calling user. Rootless podman needs nothing.
if [ -n "${HOST_UID:-}" ]; then chown -R "$HOST_UID:${HOST_GID:-$HOST_UID}" "$OUT"; fi
ls -l "$OUT"
