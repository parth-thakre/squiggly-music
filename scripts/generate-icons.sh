#!/usr/bin/env bash
# Derives every packaged app icon from the one source SVG. Re-run after replacing the SVG:
#   npm run icons
# Outputs (committed, read by electron-builder.yml):
#   build/icons/NxN.png  Linux hicolor icons (linux.icon)
#   build/icon.ico       Windows app, installer, and shortcut icon (win.icon)
#   build/icon.png       1024 px master for any other target
#   apps/desktop/main/assets/icon.png  256 px window and tray icon loaded by the main process
# Requires ImageMagick 7 (`magick`) with an SVG renderer (librsvg): sudo dnf install ImageMagick
set -euo pipefail
cd "$(dirname "$0")/.."
source=${1:-apps/desktop/renderer/public/icon.svg}
command -v magick >/dev/null || { echo 'ImageMagick 7 (magick) is required.' >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Rasterize once at a large size from the SVG's own viewBox, then downsample every
# size from that master so all outputs agree regardless of the SVG's declared size.
declared=$(magick -background none "$source" -format '%w' info:)
magick -background none -density $((72 * 2048 / declared)) "$source" -resize 1024x1024 -gravity center -extent 1024x1024 -depth 8 "$work/master.png"

rm -rf build/icons && mkdir -p build/icons
for size in 16 24 32 48 64 128 256 512; do
  magick "$work/master.png" -filter Lanczos -resize "${size}x${size}" -depth 8 "build/icons/${size}x${size}.png"
done
cp "$work/master.png" build/icon.png
cp build/icons/256x256.png apps/desktop/main/assets/icon.png
magick build/icons/{16x16,24x24,32x32,48x48,64x64,128x128,256x256}.png build/icon.ico
echo "Icons regenerated from $source"
