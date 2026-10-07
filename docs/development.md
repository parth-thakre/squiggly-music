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

`npm run test:ui` builds the browser version and drives it in Chromium against a fake Navidrome with generated covers and audio. It runs desktop and phone layouts. The same run loads the website (`site/`) with a faked GitHub release (`tests/ui/site`). It checks the download buttons, so that a Mac whose browser can't say its CPU, as in Safari and Firefox, gets a button for Apple silicon and one for Intel, and that the download list keeps what each file needs.

The Android app's pure parts run with the rest: `tests/androidQueue.test.ts` checks how the page's queue is mirrored to the native player. [android.md](android.md) covers the emulator.

Keeping songs and offline mode have their own suites. `tests/kept-store.test.ts` and `tests/kept-manager.test.ts` run the desktop's kept index and downloads against real temporary folders and a fake server. `tests/kept-validation.test.ts` checks the index's shape against `tests/fixtures/kept-index.json`, which is also the Android app's. `tests/reach.test.ts` covers when the app decides the server is out of reach and when it comes back, `tests/reports.test.ts` the plays that wait meanwhile, and `tests/offline.test.ts` the pages it shows and the browser build's calls. In `npm run test:ui`, `kept.spec.ts` drives the interface against a fake main process in the page (`installDesktopBridge` with `server` and `kept`), and `offline-web.spec.ts` the browser build's real host with `fake.unreachable` set.

`npm run test:desktop` starts the real Electron app and checks the preload bridge and process isolation. It needs Electron's own binary and a display (a graphical session, or Xvfb on Linux), so it can't run on a machine without either. `npm run smoke:packaged -- <executable>` does the same for a packaged build; [packaging.md](packaging.md) has the details. `tests/packagedSmoke.test.ts` runs that script against a stand-in app whose page crashes, stalls, or reloads, and checks it still fails in time and deletes its profile.

`tests/packaging.test.ts` checks the Linux packaging config: the RPM, deb, and AppImage targets, their libmpv dependencies, and the Flatpak manifest's pins against `build/libmpv/sources.json`.

## Limits

The queue holds up to 1,000 songs. Server requests time out after 15 seconds and responses over 8 MiB are refused. The audio process reports its state every 250 ms, and only the squiggle interpolates between those reports.
