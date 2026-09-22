# Upstream references

These are independent, shallow Git checkouts of upstream development branches, fetched on 2026-09-22. They are source references, not Squiggly dependencies or a decision to fork Feishin. No dependencies have been installed and no upstream code has been copied into Squiggly.

Keep the checkouts unchanged. Do not import from them or include them in application builds. The root `.gitignore` excludes the four checkouts while retaining this guide.

## Sources

| Checkout | Upstream | Branch | Recorded revision | License |
| --- | --- | --- | --- | --- |
| `feishin` | [jeffvli/feishin](https://github.com/jeffvli/feishin) | `development` | `ce421d2729f9f63e25ab641566ceb27b3612ce2f` | GPL-3.0 as declared upstream |
| `t3code` | [pingdotgg/t3code](https://github.com/pingdotgg/t3code) | `main` | `aff9318bf46beaf05cc7155b428d3f0b8711efd2` | MIT |
| `lossless-cut` | [mifi/lossless-cut](https://github.com/mifi/lossless-cut) | `master` | `20f2e34687a691dd15b18c030d108b3b66d44098` | GPL-2.0-only |
| `electron-fiddle` | [electron/fiddle](https://github.com/electron/fiddle) | `main` | `d4f03bad13df8c6168379c30e95df4dfaafa6153` | MIT |

These revisions identify this inspection, not the latest release tags. Branch heads will move.

## What to use each project for

### Feishin: music behavior and compatibility

- [MPV lifecycle](feishin/src/main/features/core/player/index.ts): initialization races, stale events after restarting, playback error reporting, and platform-specific MPV paths.
- [MPV preload bridge](feishin/src/preload/mpv-player.ts): the commands needed between the renderer and main process.
- [OpenSubsonic controller](feishin/src/renderer/api/subsonic/subsonic-controller.ts) and [normalization](feishin/src/shared/api/subsonic/subsonic-normalize.ts): server behavior and mapping API results into application data.
- [Lyrics providers](feishin/src/main/features/core/lyrics): provider-specific behavior worth checking before adding our own.

Feishin uses `node-mpv` to control an MPV process. This is not the native libmpv addon proposed in `PROJECT.md`. Use it to understand playback behavior, not as proof that our proposed binding works. Profile before attributing Feishin's slowness to a particular layer.

### T3 Code: desktop boundaries and focused performance tests

- [Preload bridge](t3code/apps/desktop/src/preload.ts) and [IPC channels](t3code/apps/desktop/src/ipc/channels.ts): explicit desktop operations and event subscriptions with listener cleanup.
- [Desktop window](t3code/apps/desktop/src/window/DesktopWindow.ts) and [tests](t3code/apps/desktop/src/window/DesktopWindow.test.ts): window behavior and sandboxed application-window settings.
- [Backend manager](t3code/apps/desktop/src/backend/DesktopBackendManager.ts): starting and managing a separate backend process.
- [Client benchmarks](t3code/apps/web/src/performance.bench.ts): small, generated workloads for frequently used client operations. Adapt the approach to track sorting and queue operations; this does not replace measuring Electron startup, memory, or frame times.

Borrow the narrow contracts and cleanup discipline. Do not bring over agent orchestration, remote environments, the full Effect service structure, or preview-browser exceptions to window isolation. The bridge also contains synchronous IPC calls; it is not a template to copy wholesale into a latency-sensitive player.

### LosslessCut: native media processes

- [FFmpeg handling](lossless-cut/src/main/ffmpeg.ts): packaged binary paths, early executable checks, tracked subprocesses, cancellation, and progress handling.
- [Progress parser tests](lossless-cut/src/main/progress.test.ts): test external-process output separately from the UI.

Study these patterns, but do not copy this app's renderer security settings. Its main window currently enables Node integration and disables context isolation, which conflicts with Squiggly's requirements. FFmpeg workflows are also different from continuous MPV playback.

### Electron Fiddle: packaging and desktop tests

- [Forge configuration](electron-fiddle/forge.config.ts): platform packaging, signing configuration, and Electron fuses.
- [Window tests](electron-fiddle/tests/main/windows.spec.ts), [IPC tests](electron-fiddle/tests/main/ipc.spec.ts), and [preload tests](electron-fiddle/tests/preload/preload.spec.ts): focused testing at Electron boundaries.

Use these as examples when choosing packaging and test tools. Fiddle runs user-written Electron experiments; its execution and subframe privileges are not appropriate defaults for a music player or plugin sandbox.

## Reuse rules

- Preserve source attribution and license notices when adapting MIT code from T3 Code or Fiddle. Check the specific file and dependencies too.
- Do not copy Feishin code into an MIT-only application. Decide Squiggly's distribution license before importing GPL-covered implementation.
- Treat LosslessCut as a pattern reference, not a code donor. Its declared GPL-2.0-only license is not compatible with combining its code into a GPL-3.0 derivative of Feishin without additional permission.
- Keeping references locally does not select Squiggly's license. Record the upstream path, revision, and license for any actual code reuse.
- A reference project's reputation is not a performance measurement or a security guarantee. Check the specific behavior we adopt.

## Restore or refresh

To recreate the latest development checkouts, run from the Squiggly root when the destination directories do not exist:

```bash
git clone --depth 1 --single-branch --branch development https://github.com/jeffvli/feishin.git references/feishin
git clone --depth 1 --single-branch --branch main https://github.com/pingdotgg/t3code.git references/t3code
git clone --depth 1 --single-branch --branch master https://github.com/mifi/lossless-cut.git references/lossless-cut
git clone --depth 1 --single-branch --branch main https://github.com/electron/fiddle.git references/electron-fiddle
```

Before refreshing, check for local edits with `git -C references/<name> status --short`. If clean, use `git -C references/<name> pull --ff-only`, then update the recorded revision and recheck the relevant notes. If the pull cannot fast-forward, inspect the divergence instead of resetting or deleting local work.

To reproduce a recorded revision instead of following the latest branch, fetch and detach at that full commit in a clean checkout:

```bash
git -C references/<name> fetch --depth 1 origin <recorded-revision>
git -C references/<name> switch --detach <recorded-revision>
```

Return to the branch listed above before resuming branch updates. The original license files remain in every checkout.
