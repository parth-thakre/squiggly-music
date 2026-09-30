# Development

## Layout

| Path | What lives there |
| --- | --- |
| `apps/desktop/main` | Electron lifecycle, IPC checks, the server session, radio, queue sync, tray, MPRIS, media keys, settings, and on Linux the sound server's sink reading |
| `apps/desktop/preload` | The only bridge between the interface and the desktop |
| `apps/desktop/renderer` | The React interface, with no Node or libmpv access. The same code runs as the browser version |
| `packages/core` | Shared types and request schemas |
| `packages/player-mpv` | The audio process and its libmpv calls |
| `packages/adapter-opensubsonic` | The Navidrome connector: token auth, validated responses, timeouts |
| `packages/lyrics` | The LRCLIB client and LRC parser |
| `scripts/navidrome-preview.ts` | The `/api` bridge for the browser version |
| `apps/android` | The Android app: the page's Android half (`web/`) and the native project (Capacitor, Media3). See [android.md](android.md) |
| `scripts/android.mjs` | Builds the Android APKs |

[ui-handoff.md](ui-handoff.md) goes into the interface.

## libmpv and Node

The audio process looks for `libmpv.so.2` or `.1` on Linux, `mpv-2.dll` or `libmpv-2.dll` on Windows, and on macOS `libmpv.2.dylib` in Homebrew's `/opt/homebrew/lib` or `/usr/local/lib` or MacPorts' `/opt/local/lib`, by full path only; `brew install mpv` provides it. `SQUIGGLY_LIBMPV_PATH` points it at a specific file instead. If that file is missing, the engine reports itself unavailable. It won't fall back to a system copy. The audio process runs in the app's data folder, so a copy in the folder you started the app from isn't picked up. The standalone `mpv` program isn't enough; it needs the library.

In development the audio process runs on the `node` from your PATH, or `SQUIGGLY_NODE_PATH`, on a Mac too. libmpv crashed during initialisation inside Electron's utility process, which is why it runs in plain Node.

If you'd rather not install `mpv-libs` on Fedora, you can unpack the RPM into `.local/runtime` (it's git-ignored) and run:

```bash
SQUIGGLY_LIBMPV_PATH="$PWD/.local/runtime/usr/lib64/libmpv.so.2" \
LD_LIBRARY_PATH="$PWD/.local/runtime/usr/lib64" npm run dev
```

## Tests

`npm run check` typechecks, builds, and runs every Vitest suite. `npm run test:source` skips the build, which is quicker while editing, but `tests/native.test.ts` forks the built `out/main/player.js`. After changing `packages/player-mpv`, build first or that test runs stale code.

`tests/sinks.test.ts` reads recorded `pw-dump` and `pactl` output (`tests/sinkFixtures.ts`) and never runs the real tools. To see what the sound server says on your machine, play something and open the Diagnostics page.

The native decoding tests skip unless `SQUIGGLY_LIBMPV_PATH` is set. They decode generated PCM to mpv's null output, so they never touch a real DAC. Don't set `SQUIGGLY_TEST_NULL_AUDIO=1` for listening. It silences output on purpose.

`npm run test:ui` builds the browser version and drives it in Chromium against a fake Navidrome with generated covers and audio. It runs desktop and phone layouts. The same run checks the website's download buttons (`tests/ui/site`) with a mocked GitHub release: a Mac whose browser can't say its CPU, as in Safari and Firefox, gets a button for Apple silicon and one for Intel.

The Android app's pure parts run with the rest: `tests/androidQueue.test.ts` checks how the page's queue is mirrored to the native player. [android.md](android.md) covers the emulator.

`npm run test:desktop` starts the real Electron app and checks the preload bridge and process isolation. It needs a display (a graphical session, or Xvfb on Linux).

## Limits

The queue holds up to 1,000 songs. Server requests time out after 15 seconds and responses over 8 MiB are refused. The audio process reports its state every 250 ms, and only the squiggle interpolates between those reports.
