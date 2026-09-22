# Squiggly Music

An audiophile-first Electron player prototype with React, Effect, and native libmpv playback. The renderer is a replaceable test shell. Audio correctness, process isolation, and inspectable behavior come first.

## Run

Use Node 22.16 or newer and npm. A graphical desktop and a compatible libmpv runtime are required for desktop playback.

```bash
npm ci
npm run dev
```

The player searches for `libmpv.so.2` or `.1` on Linux, `libmpv.2.dylib` on macOS, and `mpv-2.dll` or `libmpv-2.dll` on Windows. Set `SQUIGGLY_LIBMPV_PATH` to an absolute library path if it is not discoverable. Its dependent libraries must also be available to the OS loader. A standalone `mpv` executable is not sufficient.

The audio host launches `node` from PATH, or the absolute executable in `SQUIGGLY_NODE_PATH`. This development dependency is deliberate. Loading the Fedora libmpv build into Electron 44's utility process crashed during native initialization, while standalone Node succeeded. A release must ship a separately validated host runtime instead of assuming users have Node installed.

On Fedora, the runtime package is `mpv-libs`. This workspace also has a locally extracted Fedora runtime under `.local/runtime`; no system packages were installed. To use that extraction on this machine:

```bash
SQUIGGLY_LIBMPV_PATH="$PWD/.local/runtime/usr/lib64/libmpv.so.2" \
LD_LIBRARY_PATH="$PWD/.local/runtime/usr/lib64" npm run dev
```

That local runtime is machine-specific, ignored by Git, and not a redistributable app bundle. Other platforms still need native validation and packaging.

For a browser-only UI preview:

```bash
npm run preview
```

The preview does not have an Electron bridge, does not play audio, and does not invent diagnostic values. For a named preview host, set `SQUIGGLY_PREVIEW_HOST` to that exact hostname. The preview server binds to all interfaces for the collaborative browser; it is a development server, not an authenticated deployment.

## Implemented slice

- Sandboxed Electron renderer with an allowlisted, runtime-validated preload API.
- libmpv client API through Koffi's native FFI, hosted in a separate Node process. Audio samples never pass through JavaScript.
- Local file selection, queue replacement, track selection, play, pause, stop, previous/next, seek, attenuation, and output-device selection.
- Session-only OpenSubsonic login, paged album browsing, and original-stream requests. No credentials are stored on disk.
- A native playlist configured for gapless playback. This is not yet an end-to-end gapless certification.
- Source metadata, decoder/output formats, processing settings, MPV cache throughput and buffer time, with unknown values left unknown.
- Process CPU/working-set memory, player-to-main IPC payload rate, bounded latency samples, pending operations, and main event-loop timing.
- A manually exported diagnostic report that omits credentials, stream URLs, local file paths, track metadata, and server addresses.

## Audio policy

Ignore external MPV config and scripts. Request original server streams. Start at unity player volume, disable ReplayGain, and do not add EQ or crossfade. Volume changes below 100% are intentional processing, not bit-perfect playback.

`audio-params` describes decoded samples, not original file bit depth. `audio-out-params` describes MPV's output, not necessarily the OS mixer's or DAC's final format. Matching rates do not prove bit-perfect output. Server transcoding, exclusive access, OS mixing, hardware underruns, and physical output resolution remain unverified where the implementation cannot establish them.

MPV's `cache-speed` is a cache input rate. It is not the track's encoded bitrate, total network usage, or a measurement of the connection's maximum bandwidth. Event-loop delay includes the configured sampling interval. Startup timing begins when the main module loads, not when the executable is launched.

## Boundaries

- `apps/desktop/main`: Electron lifecycle, file dialogs, IPC validation, server session, and diagnostic aggregation.
- `apps/desktop/preload`: the only renderer-to-desktop bridge.
- `apps/desktop/renderer`: replaceable React UI, with no Node or libmpv access.
- `packages/core`: public data contracts, request schemas, and bounded Effect operation metrics.
- `packages/player-mpv`: private playback transport and native library calls.
- `packages/adapter-opensubsonic`: token authentication, validated responses, cancellation, and server mapping.

Effect runs at asynchronous service boundaries. Audio commands and server requests use separate concurrency lanes so slow network requests do not hold the playback permit. Network requests have a 15-second timeout and an 8-MB response cap. The prototype bounds queues at 500 tracks and album pages at 48 entries. These bounds are not evidence of 100k-track scalability.

The player emits four authoritative snapshots per second. Only the seek control interpolates playback position. It stops its animation while paused, hidden, or reduced motion is enabled. Detailed traces are not persisted or sent externally; Effect spans exist for future opt-in trace export.

## Verification

```bash
npm run check
```

This typechecks, builds, and runs the tests. Without `SQUIGGLY_LIBMPV_PATH`, the native decoding test is explicitly skipped; the missing-library test still runs.

To run the native decoding test with the local Fedora runtime:

```bash
SQUIGGLY_LIBMPV_PATH="$PWD/.local/runtime/usr/lib64/libmpv.so.2" \
LD_LIBRARY_PATH="$PWD/.local/runtime/usr/lib64" npm run check
```

For the actual Electron preload/process integration test, run in a graphical session or supply a private Xvfb display on Linux:

```bash
SQUIGGLY_LIBMPV_PATH="$PWD/.local/runtime/usr/lib64/libmpv.so.2" \
LD_LIBRARY_PATH="$PWD/.local/runtime/usr/lib64" npm run test:desktop
```

Tests generate their own PCM file and use MPV's null audio output. They do not exercise a real DAC, prove bit-perfect playback, or establish hardware performance budgets. Never set `SQUIGGLY_TEST_NULL_AUDIO=1` for normal listening; that test-only variable deliberately produces no audible output.

## Not implemented yet

OS-backed credential persistence, library indexing/search, artwork caching, metadata extraction for local files, saved playlists, queue editing, ReplayGain/EQ controls, exclusive-output controls, verified gapless transitions, device-loopback tests, renderer frame metrics, plugin hosting, lyrics, Jellyfin, mobile apps, installers, signing, and updates.

React Native is reserved for a future mobile client. Shared domain contracts and suitable Effect logic can be reused; the playback implementation will need platform-specific adapters.

## UI handoff

See [docs/ui-handoff.md](docs/ui-handoff.md). The renderer can be redesigned without changing the playback or credential boundaries.

## References and licensing

The [upstream references](references/README.md) remain separate and unchanged. No Feishin, LosslessCut, T3 Code, or Fiddle implementation was copied into this app. The seek bar is an original canvas implementation of a sine-wave progress indicator, not a port of upstream source.

The project is private and has no distribution license selected yet. Decide that before release, and review the exact libmpv/FFmpeg build and dependency licenses before bundling binaries. Koffi is a native FFI dependency, not our own N-API addon.
