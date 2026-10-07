#!/bin/sh
# Starts Squiggly Music through zypak, which lets Chromium's sandbox work inside Flatpak.
# Flatpak sets FLATPAK_ID; the app reads it to hide its GitHub update check and to name its
# MPRIS entry after this package's desktop file.
export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
exec zypak-wrapper /app/squiggly-music/squiggly-music "$@"
