# Squiggly Music — Project Brief

> Working title only. A fast, attractive, plugin-first desktop music client for Navidrome/OpenSubsonic and Jellyfin, powered by native MPV.

## Current direction

Audiophile-first. Audio correctness, an inspectable signal path, and playback isolation take priority over visual polish and the plugin catalog. Use Electron with React DOM for desktop, Effect for asynchronous services and instrumentation, and native libmpv in a separate process. Reserve React Native for a later mobile client with platform-specific playback. The current renderer is a functional shell; visual design is a separate handoff.

See [README.md](README.md) for implemented behavior and limitations, and [docs/ui-handoff.md](docs/ui-handoff.md) for the renderer contract. The milestones below remain the broader roadmap, not claims that all features already exist.

## Why this exists

Existing clients force an unpleasant choice:

- Feishin offers a polished baseline but performs poorly and has no real plugin system.
- foobar2000 is extensible but does not provide the desired modern experience.
- Other self-hosted music clients rarely combine strong desktop UX, native MPV playback, word-synced lyrics, and a stable extension API.

This project should provide all four without becoming another monolithic player.

## Non-negotiable product goals

1. **Electron desktop application** — not Tauri.
2. **Native libmpv playback backend** — MPV is the primary and only initial playback engine.
3. **Actually good performance** — responsiveness is an architectural requirement, not future cleanup.
4. **A real, versioned plugin system** that is easy to develop for.
5. **A distinctive, high-quality interface**, including the Android-inspired squiggly seek bar.
6. **OpenSubsonic/Navidrome support first**, followed by Jellyfin through a server adapter.
7. **Word-synced lyrics**, initially using `am-lyrics` as a renderer/provider integration.

## Initial development server

A Navidrome development server is available at:

- URL: `http://100.72.88.79:4533`
- Navidrome: `0.63.2`
- Subsonic API: `1.16.1`
- OpenSubsonic: enabled
- Library size when checked: 1,514 songs
- Extensions: `songLyrics` v1/v2, transcoding, transcode offset, indexed queue, form POST, and playback reporting

Credentials must not be committed. Store them in the OS credential vault during development and use environment variables only for automated tests.

## Proposed stack

### Source references

Local upstream checkouts and inspected source locations are listed in [references/README.md](references/README.md). Use Feishin for music-server and playback behavior, T3 Code for desktop boundaries and performance-test patterns, LosslessCut for native media-process handling, and Electron Fiddle for packaging and desktop tests. These are references, not application dependencies. Check the reuse rules before copying code, especially across GPL versions.

### Candidate dependencies

- Electron
- React + TypeScript
- Effect for service lifetimes, bounded concurrency, cancellation, errors, and measurements
- Vite
- Electron Forge or Electron Builder (decide during bootstrap)
- Native libmpv client API, initially through Koffi FFI in a standalone Node child process
- Zustand with narrow selectors for renderer state
- TanStack Query for remote server state
- SQLite for library metadata, cache indexes, plugin state, and offline state
- OS credential vault via Electron `safeStorage` or a keychain-backed library
- Vitest for units and Playwright for Electron integration tests

## High-level architecture

```text
apps/
  desktop/
    main/                 Electron lifecycle and secure IPC
    preload/              Narrow typed renderer bridge
    renderer/             React application

packages/
  player-mpv/             libmpv native bridge and playback process
  core/                   Queue, playback, library, and domain contracts
  plugin-sdk/             Stable public plugin API and types
  plugin-runtime/         Discovery, permissions, lifecycle, isolation
  adapter-opensubsonic/   Navidrome/OpenSubsonic implementation
  adapter-jellyfin/       Later Jellyfin implementation
  shared/                 Shared primitives with no platform coupling

plugins/
  am-lyrics/              First-party word-synced lyrics plugin
  examples/               Minimal reference plugins
```

## Native MPV design

libmpv should run outside the primary Electron renderer, ideally in a dedicated utility/child process so a player crash cannot terminate the interface.

The renderer never receives native handles and never loads the addon. It communicates through a typed preload API. The first bridge should remain deliberately small:

```ts
interface PlaybackAPI {
  load(input: PlaybackInput): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  getSnapshot(): Promise<PlaybackSnapshot>;
  subscribe(listener: (event: PlaybackEvent) => void): Unsubscribe;
}
```

Required MPV capabilities:

- Accurate seeking and property observation
- Gapless playback
- ReplayGain
- Custom HTTP request headers for authenticated streams
- Audio filters and output-device selection
- Stream/track format metadata
- Playback error propagation

Do not couple the renderer to raw, high-frequency `time-pos` events. Send occasional authoritative synchronization events and interpolate position locally with `requestAnimationFrame`.

## Plugin system

The goal is **Jellyfin-style plugin repositories and installation**, not binary compatibility with Jellyfin plugins. Jellyfin plugins are usually server-side C#/.NET assemblies and cannot be loaded directly into an Electron client.

### Plugin categories

1. **Service plugins** — lyrics, metadata, scrobbling, integrations, automation.
2. **UI plugins** — pages, panels, sidebar destinations, commands, settings.
3. **Playback plugins** — restricted MPV controls, filters, events, and visualizers.
4. **Server adapters** — OpenSubsonic, Jellyfin, and possible future protocols.

### Isolation model

- Service plugins run in isolated Node child/utility processes.
- UI plugins render through sandboxed iframes or Web Components.
- Plugins never receive direct Node, Electron, database, credential, or libmpv access.
- All access uses capability-scoped, versioned APIs.
- Plugins have declared permissions, lifecycle limits, structured logs, and storage quotas.
- A misbehaving plugin must not freeze the main renderer or playback process.

Avoid exposing React as the plugin ABI. React version changes would otherwise break third-party UI plugins. Prefer framework-neutral web entry points and Web Components.

### Example manifest

```json
{
  "id": "org.example.am-lyrics",
  "name": "AM Lyrics",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "main.js",
  "ui": "ui/index.html",
  "permissions": [
    "playback.read",
    "playback.seek",
    "track.read",
    "network"
  ]
}
```

### Repository experience

Repositories expose a signed JSON catalog. The application provides:

- Searchable in-app catalog
- Install, update, disable, and uninstall
- Stable/beta channels
- API and application compatibility checks
- Permission review before installation
- Checksums and optional publisher signatures
- Failed-update rollback
- Per-plugin logs and resource usage

### Developer experience

Target workflow:

```bash
npm create squiggly-plugin
npm run dev
npm run package
```

The SDK should include:

- TypeScript types
- Manifest schema and validation
- Hot reload against a running development client
- Mock playback/library APIs
- Permission linting
- Plugin inspector and structured logs
- Small, complete example plugins

## Lyrics

The first-party lyrics integration should wrap [`@uimaxbai/am-lyrics`](https://github.com/binimum/am-lyrics), which offers word-synced lyrics and accepts playback time in milliseconds.

It should receive track metadata and playback state only through the plugin SDK. A clicked lyric line requests seeking through `playback.seek`; it never accesses MPV directly.

Navidrome's OpenSubsonic `songLyrics` v2 response should remain a supported source. Provider selection and renderer selection should be separate extension points.

## Visual direction

The interface should feel authored, tactile, calm, and modern—not like a generic component-library dashboard. Album artwork and content should lead; chrome should remain restrained.

### Signature seek bar

Use [`saket/squiggly-slider`](https://github.com/saket/squiggly-slider) as the behavioral and visual reference. It is an Apache-2.0 Jetpack Compose library and cannot be consumed directly by Electron, so port the rendering behavior to TypeScript with appropriate attribution and license compliance.

Desired behavior:

- Played progress is a rounded sine wave.
- Remaining progress is a quiet straight rail.
- Thumb sits precisely at their junction.
- Wave animates subtly while playing and freezes while paused.
- Large invisible pointer target supports comfortable scrubbing.
- Native range semantics provide keyboard and screen-reader accessibility.
- Dragging updates locally; seeking is committed efficiently to MPV.
- Respect `prefers-reduced-motion`.
- Amplitude, wavelength, thickness, animation speed, and color are design tokens.

The small `squiggly-sliders` web package may be useful as a prototype/reference, but the product should own a reviewed internal implementation rather than depend on an immature package for core playback UI.

## Performance requirements

Initial budgets:

| Metric | Target |
|---|---:|
| Idle renderer CPU | <1% on a typical desktop |
| Idle application memory | <250 MB |
| Playback memory | <350 MB |
| Cold startup | <2 seconds |
| Common interaction response | <50 ms |
| Scrolling | Stable 60 FPS; 120 FPS where supported |
| Authoritative playback updates | Approximately 4–10 per second |
| Supported library scale | 100,000+ tracks |

Architectural rules:

- Never put the full library into reactive React state.
- Use SQLite-backed pagination and indexing.
- Virtualize all potentially large lists and grids.
- Resize/decode artwork away from the renderer and cache thumbnails.
- Do not put playback position in a broad React context.
- Use narrow store selectors and isolate the progress UI.
- Lazy-load routes, visualizers, settings, and plugin interfaces.
- Keep continuous animation compositor-friendly or canvas-based.
- Add a generated 50k–100k track benchmark dataset early.
- Track startup, memory, frame timing, and query counts in CI where practical.

## Security requirements

- `contextIsolation: true`
- Renderer sandbox enabled
- Node integration disabled in all user-facing renderers
- Strict Content Security Policy
- Typed allowlisted IPC only
- Credentials encrypted through OS-backed storage
- Plugin permissions deny by default
- Network access mediated and domain-aware
- Signed/checksummed plugin packages where available
- No plugin access to authentication secrets

## Delivery milestones

### Milestone 0 — Decisions and proof of concept

- Bootstrap Electron/React/TypeScript workspace.
- Select and validate a maintained libmpv Node binding strategy or create a minimal N-API bridge.
- Prove native MPV playback of one authenticated Navidrome stream.
- Prototype the squiggly seek bar in isolation.
- Record startup and idle baselines.

### Milestone 1 — Thin vertical slice

- Secure Navidrome login and capability discovery.
- Browse albums and tracks.
- Play, pause, seek, volume, previous, and next through libmpv.
- Queue management.
- Artwork cache.
- Basic polished player interface.

### Milestone 2 — Plugin foundation

- Finalize plugin manifest and API v1.
- Implement isolated service-plugin host.
- Implement sandboxed UI-plugin surface.
- Add installation from a local ZIP/folder.
- Build hot reload, inspector, and one tiny example plugin.

### Milestone 3 — Lyrics

- Integrate OpenSubsonic lyrics.
- Ship `am-lyrics` as the first meaningful plugin.
- Click-to-seek and accurate playback synchronization.
- Lyrics provider and renderer extension points.

### Milestone 4 — Catalog and polish

- Jellyfin-style plugin repositories.
- Updates, permissions, checksums, rollback, and logs.
- Full visual system and responsive desktop layouts.
- Accessibility and keyboard-navigation pass.
- Large-library and plugin-abuse performance testing.

### Milestone 5 — Jellyfin

- Add the Jellyfin server adapter without contaminating OpenSubsonic domain logic.
- Verify library, streaming, artwork, lyrics, playlists, and reporting behavior.

## First decision to make

The riskiest technical dependency is the native libmpv integration. Before investing heavily in UI, test candidate Node/libmpv bindings against the current Electron ABI and Windows packaging. If no binding meets reliability and maintenance requirements, build a narrow N-API addon around the small playback contract above.
