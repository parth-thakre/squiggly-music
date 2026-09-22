# Renderer handoff

The current UI is a functional test shell. Visual design will be handled separately. Do not treat its layout, copy, colors, or illustration as product requirements.

## Files to replace

`apps/desktop/renderer/src/App.tsx`, `styles.css`, and renderer-only components. The existing `SeekBar.tsx` and `store.ts` are optional starting points. Keep the HTML Content Security Policy and native range accessibility unless replacing them with an equally constrained implementation.

## Desktop contract

Import types from `packages/core/contracts.ts`. Use `window.squiggly`, exposed by `apps/desktop/preload/index.ts`:

| Method | Purpose |
| --- | --- |
| `snapshot()` | Get current player, diagnostics, and server state |
| `subscribe(listener)` | Receive authoritative snapshots; returns an unsubscribe function |
| `command(command)` | Play, pause, stop, previous/next, seek, volume, select track/device, restart |
| `openFiles()` | Ask the main process to show a native file dialog and replace the queue |
| `connect(connection)` | Start a session-only server connection |
| `albums(offset)` | Load up to 48 newest albums |
| `playAlbum(id)` | Replace the native playlist and begin playback |
| `disconnect()` | Clear the server session and restart the player to remove private stream URLs |
| `exportDiagnostics()` | Show a save dialog for a credential-free diagnostic report |

Mutations and server operations return `{ ok: true, value }` or `{ ok: false, error }`. They must surface failures. `snapshot()` returns state directly. The bridge is absent in browser preview; do not substitute simulated playback or invented metrics.

## Audio truth rules

- Unknown remains unknown. Do not turn missing sample rates or bit depths into sensible-looking defaults.
- Clearly distinguish source metadata, decoded sample format, MPV output, and unverified OS/DAC behavior.
- There is no established bit-perfect or exclusive-mode state. Do not add a badge implying one.
- A raw stream request does not prove the server returned unmodified audio.
- Volume below 100% means attenuation. Decoder sample format is not original file bit depth.
- The only initial backend is libmpv. No HTML audio, Web Audio playback fallback, or JavaScript audio processing.

## Performance and security rules

- Do not put a per-frame playback clock into application-wide React state. Interpolate inside the progress/lyrics component using occasional native snapshots.
- Stop animation while paused or hidden and respect reduced motion. Avoid always-running spectrum or decorative wave animations.
- Virtualize long queues and paginate the library. Do not fetch the entire library into renderer state.
- Never import Node, Electron, Koffi, server authentication, or the private player protocol into renderer runtime code.
- Runtime Effect schemas live in `packages/core/validation.ts`; keep them out of renderer imports unless genuinely required.
- Clear password state after connection attempts. Do not use localStorage for credentials or pass authenticated stream URLs to components.
- Subscribe once and release listeners on teardown. Avoid replacing optimistic values with stale asynchronous snapshots.

Backend changes should be tested independently of visual work. `npm run check` exercises the public validation and native host contract; `npm run test:desktop` checks the actual preload bridge and process isolation.
