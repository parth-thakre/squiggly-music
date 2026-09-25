<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-dark.png">
    <img alt="Squiggly Music" src="docs/brand/lockup-light.png" width="400">
  </picture>
</h1>

An audiophile-first desktop music player for Navidrome/OpenSubsonic, built on Electron, React, Effect, and native libmpv playback. Audio correctness, process isolation, and inspectable behavior come first. It is pre-release software: see the [2026-09-25 audit](docs/audit-2026-09-25.md) for known defects and release blockers.

## Run

Use Node 22.16 or newer and npm. A graphical desktop and a compatible libmpv runtime are required for desktop playback.

```bash
npm ci
npm run dev
```

The player searches for `libmpv.so.2` or `.1` on Linux, `libmpv.2.dylib` on macOS, and `mpv-2.dll` or `libmpv-2.dll` on Windows. Set `SQUIGGLY_LIBMPV_PATH` to an absolute library path if it is not discoverable. Omit this override on systems with a normal libmpv installation. Setting it to a missing path makes the engine unavailable; it does not fall back to system libraries. Its dependent libraries must also be available to the OS loader. A standalone `mpv` executable is not sufficient.

The audio host launches `node` from PATH, or the absolute executable in `SQUIGGLY_NODE_PATH`. This development dependency is deliberate. Loading the Fedora libmpv build into Electron 44's utility process crashed during native initialization, while standalone Node succeeded. Release packages ship their own pinned Node runtime for the host (see Packaging), so users don't need Node installed.

On Fedora, the runtime package is `mpv-libs`. An optional developer setup is to extract a Fedora runtime under `.local/runtime`. This per-machine setup is untracked and absent in a fresh checkout. If you have created that extraction, run:

```bash
SQUIGGLY_LIBMPV_PATH="$PWD/.local/runtime/usr/lib64/libmpv.so.2" \
LD_LIBRARY_PATH="$PWD/.local/runtime/usr/lib64" npm run dev
```

That local runtime is machine-specific, ignored by Git, and not a redistributable app bundle. macOS has no package or native validation yet.

### Browser build

`npm run web` builds the renderer for the browser and serves it; `npm run preview` runs the Vite development server. Both listen on 127.0.0.1. A server-side `/api` bridge (`scripts/navidrome-preview.ts`) connects to Navidrome with credentials from `SQUIGGLY_PREVIEW_NAVIDROME_URL`, `_USER`, and `_PASSWORD`, so the browser can browse and play the library through the browser's own audio element. The Navidrome password never reaches the browser.

Whoever reaches `/api` acts as that Navidrome account. To use it from another device, set `SQUIGGLY_WEB_PASSWORD` (12 or more characters): every `/api` route then needs a signed-in session cookie. Without it, `/api` serves only this computer. The header of `scripts/navidrome-preview.ts` documents the routes, binding rules, and a Tailscale setup. It is a personal server, not a hardened multi-user deployment. Browser playback bypasses libmpv, so the audio policy and diagnostics below apply to the desktop app only.

## Install

Releases are published on the repository's [Releases page](https://github.com/parth-thakre/squiggly-music/releases). The repository is private, so downloading requires a GitHub account with access. The GitHub CLI is the easiest way to download:

```bash
gh release download --pattern 'squiggly-music-*.rpm' --pattern SHA256SUMS -R parth-thakre/squiggly-music   # latest release
```

| Platform | Asset |
| --- | --- |
| Windows 10/11 x64, installer | `Squiggly-Music-<version>-windows-x64-setup.exe` |
| Windows 10/11 x64, portable | `Squiggly-Music-<version>-windows-x64-portable.exe` |
| Fedora x86_64 | `squiggly-music-<version>.x86_64.rpm` |

Verify each download against `SHA256SUMS` from the same release:

```bash
sha256sum --ignore-missing -c SHA256SUMS
```

```powershell
(Get-FileHash .\Squiggly-Music-<version>-windows-x64-setup.exe -Algorithm SHA256).Hash.ToLower()   # compare with SHA256SUMS
```

On a public repository, each asset also has a build provenance attestation. It shows that the release workflow built the file from the tagged commit: `gh attestation verify <file> -R parth-thakre/squiggly-music`.

- **Windows:** run the setup program, or run the portable executable directly. The builds are not code-signed yet, so SmartScreen may warn: choose **More info**, then **Run anyway**. The package includes its own audio runtime (Node and libmpv).
- **Fedora:** `sudo dnf install ./squiggly-music-<version>.x86_64.rpm`. dnf also installs `mpv-libs`, the libmpv runtime the player uses. Start **Squiggly Music** from Activities, or run `squiggly-music`. Upgrade with the same command using a newer RPM. Uninstall with `sudo dnf remove squiggly-music`.

## Packaging

`npm run package:win` and `npm run package:linux` build into `dist/`. Each package ships a pinned, checksum-verified Node executable as the audio host's runtime. The fetch scripts in `scripts/` download it into `.local/`.

- **Windows** (`Squiggly-Music-<version>-windows-x64-{setup,portable}.exe`): also bundles libmpv and Koffi's win32-x64 binary. It builds on Windows, or on Linux with Wine.
- **Linux** (`squiggly-music-<version>.x86_64.rpm`): keeps only Koffi's linux-x64 binary and depends on the system `mpv-libs` instead of bundling libmpv. It needs `rpmbuild` and `libcrypt.so.1`, which electron-builder's bundled fpm links against. On Fedora: `sudo dnf install rpm-build libxcrypt-compat`.

The fetch scripts pin SHA-256 digests for the Node archives and libmpv, and the npm integrity for Koffi's Windows binary. They cache archives in `.local/downloads`, rehash them on every run, and download again on a mismatch. The comments in each script record how the pins were checked.

After electron-builder copies the app, `scripts/release-notices.mjs` writes `resources/licenses/npm-packages.txt` and fails the build if a required notice is missing or a production dependency has an unreviewed license. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

`npm run smoke:runtime -- <app dir>` runs the packaged audio host with its bundled Node: it checks that libmpv loads, decodes a generated WAV to the null output, and exits cleanly. Pass `dist/win-unpacked` on Windows, or `"/opt/Squiggly Music" --expect-system-libmpv` after installing the RPM.

`npm run release:checksums` writes `dist/SHA256SUMS` for every file in `dist/`. The release workflow runs the same script.

App icons are generated from the single source `apps/desktop/renderer/public/icon.svg`. After replacing that SVG, run `npm run icons` (requires ImageMagick 7 with librsvg) and commit `build/`. It regenerates `build/icons/*.png` (Linux), `build/icon.ico` (Windows app, installer, and shortcuts), and `build/icon.png`.

## Releasing

`package.json`'s `version` is the single source of truth. The release workflow rejects a tag that does not match it.

```bash
git switch main && git pull
npm version patch            # or minor / major / prerelease --preid beta; commits and tags vX.Y.Z
git push --follow-tags       # pushes the commit and the tag
```

Pushing a `v*` tag runs `.github/workflows/release.yml`:

1. It typechecks, builds, and runs the tests on Fedora, including the native libmpv tests, and runs the Playwright UI tests once `npm run test:ui` exists.
2. It builds the Windows installer and portable executable on `windows-latest`, and the RPM in a Fedora container.
3. It smoke-tests each package's audio runtime: `dist/win-unpacked` with the bundled libmpv, and the RPM after `dnf install` with Fedora's `mpv-libs`. A failure stops the release.
4. It writes `SHA256SUMS` and adds build provenance attestations when the repository supports them.
5. It publishes a GitHub Release. The notes combine an install and verify header (`.github/release-notes-header.md`) with notes GitHub generates from the PRs and commits since the previous tag. Versions with a hyphen, such as `1.2.0-beta.1`, are published as prereleases.

To build without publishing, run the workflow manually from the Actions tab (**Release**, then **Run workflow**) and download the `release-assets` artifact.

## Features

- Sandboxed Electron renderer with an allowlisted, runtime-validated preload API.
- libmpv client API through Koffi's native FFI, hosted in a separate Node process. Audio samples never pass through JavaScript.
- Session-only Navidrome/OpenSubsonic login. Browse records, artists, playlists, favorites, and search; play original streams or local files.
- An editable queue: add next or last, reorder, remove, clear. It syncs to the server and is restored on the next launch. Play reporting (scrobbling) is on by default.
- Radio seeded from a track, album, or artist, topped up from the server while it plays.
- Playlist creation and editing: add, remove, reorder, rename, delete. Playlists owned by other users are read-only.
- Lyrics from the server's `songLyrics`, with optional LRCLIB lookup (off by default), including synced lines.
- Exclusive output mode as a request to libmpv. The app reports whether the output accepted it but can't verify exclusive access.
- System tray, a mini player window, media keys, and MPRIS on Linux.
- A native playlist configured for gapless playback. This is not yet an end-to-end gapless certification.
- Diagnostics: source metadata, decoder and output formats, processing settings, mpv cache throughput and buffer time, process CPU and memory, IPC rate, latency samples, and event-loop timing, with unknown values left unknown. A manually exported report omits credentials, stream URLs, local paths, track metadata, and server addresses.
- Windows installer and portable builds, and a Fedora RPM.

## Connect Navidrome

In the desktop app, choose **Connect a server**, enter your Navidrome server address, username, and password, then connect. Include any port or reverse-proxy subpath, such as `http://localhost:4533` or `https://music.example.com/navidrome`. Use HTTPS outside a trusted local network.

Use the server's base address, not its web UI route. An explicit API endpoint such as `/navidrome/rest/ping.view` is also accepted. Bare `/app` and `/rest` suffixes are preserved because either can be a configured server subpath.

The Library opens after login. Browse newest albums in pages of 48, use Refresh after a server scan, and select an album to play it through libmpv. The connector uses Navidrome's OpenSubsonic API with salted token authentication and requests original audio with `format=raw`.

Credentials last only for the current session. Disconnecting or replacing a connection clears the previous native playlist and its stream tokens. A failed replacement leaves the existing session connected.

The connector tests include a local Navidrome-compatible HTTP fixture covering authentication, subpaths, album paging, metadata, and authenticated stream retrieval. They do not replace testing against a live Navidrome installation.

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

Effect runs at asynchronous service boundaries. Audio commands and server requests use separate concurrency lanes so slow network requests do not hold the playback permit. OpenSubsonic metadata requests have a 15-second timeout and an 8 MiB response cap; audio streaming uses libmpv's own network behavior. The app bounds queues at 1,000 tracks and album pages at 48 entries. These bounds are not evidence of 100k-track scalability.

The player polls native state every 250 ms and publishes immediate updates at startup and after commands. Renderer subscriptions also receive once-per-second diagnostic updates and operation-completion updates. Only the seek control interpolates playback position. Its squiggle animates continuously while visible, at a throttled rate while paused, and stops when hidden or when reduced motion is on. Detailed traces are not persisted or sent externally; Effect spans exist for future opt-in trace export.

## Verification

```bash
npm run check
```

This typechecks, builds, and runs the tests. Without `SQUIGGLY_LIBMPV_PATH`, the native decoding tests are explicitly skipped; the missing-library test still runs.

`npm test` builds first (`pretest`). `npm run test:source` runs the same Vitest suite without building, which is faster while editing. Most tests import the TypeScript sources directly. The isolated audio host tests in `tests/native.test.ts` fork the compiled `out/main/player.js`: they fail when `out/` is missing and test stale code when it is out of date, so run `npm run build` first after changing `packages/player-mpv` or its imports. The release workflow builds before running the tests.

If you created the optional local Fedora runtime extraction, run the native decoding test with:

```bash
SQUIGGLY_LIBMPV_PATH="$PWD/.local/runtime/usr/lib64/libmpv.so.2" \
LD_LIBRARY_PATH="$PWD/.local/runtime/usr/lib64" npm run check
```

For the actual Electron preload/process integration test, run in a graphical session or supply a private Xvfb display on Linux. The example below assumes you created the optional local Fedora runtime extraction. With a normal libmpv installation, omit both environment overrides and run `npm run test:desktop`:

```bash
SQUIGGLY_LIBMPV_PATH="$PWD/.local/runtime/usr/lib64/libmpv.so.2" \
LD_LIBRARY_PATH="$PWD/.local/runtime/usr/lib64" npm run test:desktop
```

Tests generate their own PCM file and use MPV's null audio output. They do not exercise a real DAC, prove bit-perfect playback, or establish hardware performance budgets. Never set `SQUIGGLY_TEST_NULL_AUDIO=1` for normal listening; that test-only variable deliberately produces no audible output.

## Not implemented yet

OS-backed credential persistence, a local library index (search uses the server), persistent artwork caching, metadata extraction for local files, ReplayGain/EQ controls, verified gapless transitions and exclusive access, device-loopback tests, renderer frame metrics, extension hosting, Jellyfin, mobile apps, code signing, and an update check.

React Native is reserved for a future mobile client. Shared domain contracts and suitable Effect logic can be reused; the playback implementation will need platform-specific adapters.

## UI handoff

See [docs/ui-handoff.md](docs/ui-handoff.md). The renderer can be redesigned without changing the playback or credential boundaries.

Five interactive UI design studies are available at `/mocks.html` with `npm run preview`. Use the direction buttons to compare Cove, Daylight, After hours, Studio, and Blue note. These are isolated mockups with sample records and no audio playback. The existing player is unchanged. See [docs/ui-mockups.md](docs/ui-mockups.md) for the design notes.

Five more UI studies are at `/mocks-2.html` with `npm run preview`: Verse, Bench, Sleeve notes, Transistor, and Ledger. They are isolated mockups with sample records and no audio playback. See [docs/ui-mockups-2.md](docs/ui-mockups-2.md).

## References and licensing

The [upstream references](references/README.md) remain separate and unchanged. No Feishin, LosslessCut, T3 Code, or Fiddle implementation was copied into this app. The seek bar is an original canvas implementation of a sine-wave progress indicator, not a port of upstream source.

Squiggly's own code is released under the [MIT License](LICENSE). The packages also redistribute third-party software under its own licenses; [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) lists it, along with the open licensing questions. The Windows packages bundle a GPL-3.0-or-later libmpv build, with a written source offer in [licenses/libmpv-windows/NOTICE.md](licenses/libmpv-windows/NOTICE.md). Resolve those questions before a public release. Koffi is a native FFI dependency, not our own N-API addon.
