# Renderer guide

The renderer lives in `apps/desktop/renderer/src/app/`. It runs in two places: the desktop app, where `window.squiggly` is the preload bridge and libmpv plays audio, and the browser build (`npm run web`), where the same UI talks to the host's `/api/*` bridge and plays through an audio element.

## Layout of the code

| File | Role |
| --- | --- |
| `App.tsx` | Shell: bar, deck (now playing), page, connect screen |
| `views.tsx` | Pages: records, album, artists, artist, playlists, playlist editor, mixes, favorites, search, queue, lyrics, settings, diagnostics |
| `player.ts` | Playback store. Desktop mirrors main-process snapshots; web drives two audio elements, reports plays, and saves the queue itself |
| `registry.ts`, `menu.tsx` | The extension seam: right-click menu items and commands. Built-in items register the same way extensions will |
| `TrackTable.tsx` | Song lists: selection, drag reorder, windowing past 120 rows |
| `commands/` | Every action as a command, default keys, `keybindings.json` overrides, and the Ctrl+K palette. The palette lists commands only and filters by substring; the library has the search in the bar. The browser build has no config folder, so Settings › Keys edits its bindings there instead |
| `theme/` | Theme tokens, built-in themes, and user themes from the config folder. Motion checks go through `reducedMotion` from here, which covers the system setting and the theme |
| `config.ts` | The desktop's config folder (`keybindings.json`, `themes/*.json`), read once and shared by keys and themes. The main process reads and watches it (`main/config.ts`, wired up in `main/configBridge.ts`) |
| `transport.tsx` | The room's palette (`useRoomPalette`: theme colours or the sleeve), its CSS variables, transport buttons, and the position squiggle, shared by the deck and the mini player |
| `ui.tsx` | Small shared pieces: covers, glyphs, palettes from sleeves, title splitting, `time()`, `shuffled()`, formatting |
| `lyrics.tsx`, `Mini.tsx`, `mixes.ts`, `route.ts`, `library.ts`, `settings.ts`, `favorites.ts` | Lyrics sheet, mini player window, automatic playlists, navigation and view transitions, cached library access, settings, optimistic favorites |

## Desktop contract

Import types from `packages/core/contracts.ts`. `window.squiggly` (see `apps/desktop/preload/index.ts`):

| Method | Purpose |
| --- | --- |
| `snapshot()`, `subscribe(listener)` | Authoritative player, diagnostics, and server state |
| `command(command)` | Play, pause, stop, previous/next, seek, volume, output device, restart |
| `openFiles()`, `connect(connection)`, `disconnect()` | Local files; session-only server login. Settings › Disconnect calls `disconnect()`, which stops playback and returns to the connect screen |
| `playTracks(trackIds, startIndex)` | Replace the queue with up to 500 library tracks the main process has returned |
| `queue.add(ids, 'next' \| 'end')`, `queue.move`, `queue.remove`, `queue.clear` | Edit the queue (up to 1000). The playing song cannot be removed. Indexes refer to the latest snapshot |
| `queue.jump(index, entryId)` | Play a queue entry. The entry id makes the jump land on that exact entry, even when the same song appears twice |
| `radio.start(seed)`, `radio.stop()` | Radio from a song, album, or artist. The main process owns it and keeps topping up the queue while every window is hidden |
| `resumeQueue()` | Load the server-saved queue paused at its song and position |
| `library.*` | `LibraryApi`: browse, search, star, playlists and editing, radio (`similarSongs`, `topSongs`), `lyrics` |
| `library.coverUrl(coverArt, size)` | `squiggly-art://` URL; the main process fetches art, credentials never reach the renderer |
| `settings()`, `updateSettings(changes)` | Stored preferences; re-read `settings()` after a failed update |
| `config.dir`, `config.read()`, `config.subscribe(listener)`, `config.openDir()` | The config folder: `keybindings.json` and `themes/*.json` as parsed JSON, with plain errors for files that couldn't be read. Pushed again whenever their contents change |
| `window.toggleMini()`, `window.setAlwaysOnTop(on)`, `window.isMini` | The mini player window |
| `exportDiagnostics()` | Save a credential-free report |

Queue entries have identities: `snapshot.player.entryIds[i]` names the entry at `queue[i]`. Select and seek by entry, not by track id: `queue.jump` takes the entry id, and seek commands carry the `entryId` captured when the gesture began, so a seek that lands after the track changed is refused instead of seeking the wrong song.

On the desktop the main process reports plays and saves the queue; the renderer must not call `library.reportPlay` or `library.saveQueue` there. LRCLIB is contacted only when both the call and the stored setting allow it.

Mutations return `{ ok: true, value }` or `{ ok: false, error }` and every failure is shown.

## Renderer conventions

- **Playlist edits** go through `playlistEditor(id)` in `library.ts`, or `usePlaylist(id)` in components. There is one editor per playlist, shared by its page and every menu. It queues edits and sends them to the server one at a time, then reconciles the local list with the server's read-back. Don't call the playlist mutations in `library.*` directly from views. New playlists go through `createPlaylist()` in `menu.tsx`, which refreshes the playlist list and opens the new one.
- **Menus and commands** register through `registry.ts`. Ids are namespaced by owner (`builtin:play`). Registering an id that is still live throws `RegistryCollision`; dispose the old registration first. Disposers are idempotent and never remove a newer registration with the same id. `registry.scope(owner)` gives an extension its own add functions and one `dispose()` for everything it added.
- `tracksOf(target)` in `menu.tsx` returns a `Result`. Show its error; don't assume the tracks loaded.
- **Navigation state** lives in the route. The Records sort is part of the route, so Back returns to the same order and scroll offset.
- **Contrast.** `--accent` is for marks and large type (3:1 against the ground). `--accent-text` is for normal-weight text: it keeps 4.5:1 against both the ground and the selected-row tint. Use it for the current lyric line and the current track number.

## Browser build

The browser build uses `bridge/previewLibrary.ts` instead of `window.squiggly`. `npm run web` and `npm run preview` bind 127.0.0.1. Reaching them from another address requires `SQUIGGLY_WEB_PASSWORD` (12 or more characters) on the host; without it `/api` serves loopback only. `webSession.status()` reports whether a password is required and whether this browser is signed in; `signIn` and `signOut` manage the HttpOnly session cookie. `onSignedOut(listener)` fires when any `/api` call returns 401, so the UI can return to the sign-in screen. The cookie is same-origin, so `<audio>` and `<img>` URLs under `/api` need no extra headers.

## Audio truth rules

- Unknown remains unknown. Do not turn missing sample rates or bit depths into sensible-looking defaults.
- Distinguish source metadata, decoded sample format, mpv output, and unverified OS/DAC behavior.
- Exclusive output is a request. `exclusiveRequested` says what mpv accepted, not what the OS granted; never badge it as bit-perfect.
- A raw stream request does not prove the server returned unmodified audio.
- Volume below 100% means attenuation. Decoder sample format is not original file bit depth.
- The desktop plays through libmpv only. The browser build plays through the browser and says so in the signal-path sentence.

## Performance and security rules

- No per-frame clock in app-wide state. The squiggle interpolates between snapshots; views subscribe with selectors.
- The seek squiggle animates continuously while visible; that is intentional. It draws every frame while playing and 30 frames a second while paused, and draws nothing while the window is hidden. Reduced motion gets a still wave. Other decorative motion stops while paused or hidden.
- Window long lists and page the library. Caches are bounded.
- Never import Node, Electron, Koffi, server authentication, or the private player protocol into renderer code.
- Keep passwords out of renderer state and storage; never hand authenticated URLs to components.

`npm run check` runs typecheck and tests; `npm run test:desktop` checks the preload bridge and process isolation.
