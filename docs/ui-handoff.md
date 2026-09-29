# Renderer guide

The renderer lives in `apps/desktop/renderer/src/app/`. It runs in three places: the desktop app, where `window.squiggly` is the preload bridge and libmpv plays audio; the browser build (`npm run web`), where the same UI talks to the host's `/api/*` bridge and plays through an audio element; and the Android app, where `window.squigglyAndroid` (`apps/android/web/bridge.ts`) runs the connector in the page and a native Media3 player plays the queue. [android.md](android.md) has the details.

## Layout of the code

| File | Role |
| --- | --- |
| `App.tsx` | Shell: bar, deck (now playing), page, connect screen. The bar's search field searches after a 250 ms pause; Enter searches at once and moves to the first result, Escape empties it and goes back. Recent searches (`squiggly.searches`, the query text only) and that Enter request live in `searches.ts`. `/` opens the Search page, which lists them until you type |
| `views.tsx` | Pages: records, album, artists, artist, tracks, playlists, playlist editor, mixes, favorites, search, queue, lyrics, settings, diagnostics, home |
| `player.ts` | Playback store. Desktop mirrors main-process snapshots; web drives two audio elements, reports plays, and saves the queue itself. Android (`mode: 'android'`) keeps the queue as web does and follows the native player's reports |
| `registry.ts`, `menu.tsx` | The extension seam: right-click menu items and commands. Built-in items register the same way extensions do |
| `TrackTable.tsx` | Song lists: selection, drag reorder, windowing past 120 rows. Rows (or the selection) drag onto the queue and playlists; with `onDropItems`, drops from outside land before the row under the pointer, drawn with the reorder line |
| `drag.ts` | Drag and drop with a mouse or pen (touch keeps its menus). Sources call `startDrag(event, target)`: the `application/x-squiggly` payload is `{ kind: 'album' \| 'artist' \| 'tracks' \| 'playlist', ids }`, the shapes `tracksOf` takes, with the title as plain text. Targets use `useDropTarget`, which outlines them in `--accent` only while a payload they take is over them; drags that reorder a list (marked `application/x-squiggly-reorder`) light up lists only. `dropOnQueue` and `dropOnPlaylist` reuse Add to queue and the playlist's editor. `useFileDrops` takes files from the computer on the desktop and swallows them elsewhere |
| `commands/` | Every action as a command, default keys, `keybindings.json` overrides, and the Ctrl+K palette. The palette lists commands only and filters by substring; the library has the search in the bar. The browser build has no config folder, so Settings › Keys edits its bindings there instead |
| `theme/` | Theme tokens, built-in themes, user themes from the config folder, and `registerTheme()` for extensions. Motion checks go through `reducedMotion` from here, which covers the system setting and the theme |
| `extensions/` | The extension runtime: loads each enabled extension's module from `squiggly-ext://`, builds its context, and disposes everything it registered on reload. Also pages, notices, and Settings › Extensions. See [extensions.md](extensions.md) |
| `config.ts` | The desktop's config folder (`keybindings.json`, `themes/*.json`), read once and shared by keys and themes. The main process reads and watches it (`main/config.ts`, wired up in `main/configBridge.ts`) |
| `transport.tsx` | The room's palette (`useRoomPalette`: theme colours or the sleeve), its CSS variables, transport buttons, and the position squiggle, shared by the deck and the mini player |
| `ui.tsx` | Small shared pieces: covers, glyphs, palettes from sleeves, title splitting, `time()`, `shuffled()`, formatting |
| `lyrics.tsx`, `Mini.tsx`, `mixes.ts`, `route.ts`, `library.ts`, `settings.ts`, `favorites.ts`, `ratings.tsx` | Lyrics sheet, mini player window, automatic playlists, navigation and view transitions, cached library access, settings, optimistic favorites, optimistic ratings and their marks |

## Desktop contract

Import types from `packages/core/contracts.ts`. `window.squiggly` (see `apps/desktop/preload/index.ts`):

| Method | Purpose |
| --- | --- |
| `snapshot()`, `subscribe(listener)` | Authoritative player, diagnostics, and server state |
| `player.playId` in the snapshot | A string that changes whenever a song starts from the top: another entry, the same entry again (repeat all over one song), a repeat-one loop, a jump to the entry playing. Never on a seek or pause; `''` before anything has played. The audio host sets it; the main process reports plays by it. The renderer store has the same `playId` on every platform: this one on the desktop, a new one per load in the browser, the native player's per-play counter on Android |
| `command(command)` | Play, pause, stop, previous/next, seek, volume, output device, restart |
| `command({ type: 'repeat', mode })`, `command({ type: 'shuffle', on })` | Queue modes, owned by the audio host and shown as `player.repeat` (`off`, `all`, `one`) and `player.shuffle` in the snapshot. Shuffle on reorders the songs after the current one; off leaves the queue as it is. While shuffle is on, a new queue (`playTracks`, `openFiles`) plays from the chosen song with the rest in random order; radio and a restored queue keep theirs. Repeat on stops radio, and starting radio turns repeat off. The main process saves both (`play-modes.json`) for the next launch |
| `filePath(file)`, `openPaths(paths, 'play' \| 'queue')` | Files dropped on the window. `filePath` is Electron's `webUtils.getPathForFile` in the preload; only the paths go to the main process, which checks them as `openFiles` limits its dialog (audio extensions, regular files, up to 1000) and leaves out folders and anything else, counting them in `skipped`. `queue` adds to the end when something is loaded; `play` replaces the queue. The renderer never reads the files |
| `openFiles()`, `connect(connection)`, `disconnect()` | Local files; server login, saved encrypted when the system allows (`server.saved`, `server.canRemember` in the snapshot) and reconnected at launch (`server.reconnecting`, `server.reconnectError`). Settings › Disconnect calls `disconnect()`, which stops playback, forgets the saved sign-in, and returns to the connect screen |
| `playTracks(trackIds, startIndex)` | Replace the queue with up to 500 library tracks the main process has returned |
| `queue.add(ids, 'next' \| 'end' \| index)`, `queue.move`, `queue.remove`, `queue.clear` | Edit the queue (up to 1000). An index inserts before that entry (a drop onto the queue). The playing song cannot be removed. Indexes refer to the latest snapshot |
| `queue.jump(index, entryId)` | Play a queue entry. The entry id makes the jump land on that exact entry, even when the same song appears twice |
| `radio.start(seed)`, `radio.stop()` | Radio from a song, album, or artist. The main process owns it and keeps topping up the queue while every window is hidden |
| `resumeQueue()` | Load the server-saved queue paused at its song and position |
| `library.*` | `LibraryApi`: browse, search, star, rate (`rate(kind, id, 0 to 5)`, where 0 clears; items carry `userRating` when rated), playlists and editing, radio (`similarSongs`, `topSongs`), `lyrics`, what other accounts are playing (`nowPlaying`) |
| `library.tracks(sort, offset, size, seed)` | Every track on the server, up to 500 at a time, sorted as Records sorts (Newest, A to Z, By artist, Most played, Recently played, Random, Top rated; `seed` keeps a random order across pages). A page shorter than `size` is the last. Navidrome's own API does the sorting: the connector signs in to it with the account's password (`POST /auth/login`), keeps the session token in memory, takes the fresh one each answer brings, and signs in again when it's refused. Other servers, or a Navidrome whose own API is out of reach, answer in the server's one order (`search3` with an empty query) with `sorted: false`, and the Tracks page hides its sorts. The page asks for 200 at a time as it scrolls |
| `library.coverUrl(coverArt, size)` | `squiggly-art://` URL; the main process fetches art, credentials never reach the renderer |
| `library.artistInfo(artistId)` | `getArtistInfo2`: the biography as plain text (the server's HTML stripped, its Last.fm link dropped), links, and similar artists that are in the library. Every field may be empty, and the artist page then shows nothing. Image addresses are external, so the renderer doesn't load them |
| `library.songsByGenre(genre, offset, size)` | One genre's songs, up to 500 at a time (`getSongsByGenre`). The genre page asks for 200 at a time as it scrolls |
| `library.nowPlaying()` | What other accounts on the server are playing (`getNowPlaying`), as `{ username, track }`. The connector leaves out this account's own players and a song someone has on two players at once. Home reads it once per visit and hides it when it's empty or fails |
| `library.albums('byYear', offset, size, { fromYear, toYear })` | Records from those years, oldest first. Only `byYear` takes years. Records' decade filter uses it; the decades offered are the ones the automatic playlists find |
| `library.search(query, options?)` | `search3`. Left out, the options mean 8 artists, 16 records, and 40 songs; `artistCount`, `albumCount`, `songCount` (0 to 200, 0 skips the kind) and `artistOffset`, `albumOffset`, `songOffset` (0 to 1,000,000) page each kind. `capped` says which kinds came back full: there may be more, and the Search page offers See all. Subsonic gives no totals. The page's tab (`{ view: 'search', query, type?: 'artists' \| 'albums' \| 'songs' }`) pages one kind, songs 100 at a time |
| `settings()`, `updateSettings(changes)` | Stored preferences; re-read `settings()` after a failed update |
| `extensions.list()`, `subscribe`, `setEnabled`, `reload`, `remove`, `openDir`, `writeClipboard` | Extensions in `<config>/extensions`. `remove` moves the folder to the trash. The runtime in `extensions/` is the only caller |
| `config.dir`, `config.read()`, `config.subscribe(listener)`, `config.openDir()` | The config folder: `keybindings.json` and `themes/*.json` as parsed JSON, with plain errors for files that couldn't be read. Pushed again whenever their contents change |
| `window.toggleMini()`, `window.setAlwaysOnTop(on)`, `window.isMini` | The mini player window |
| `window.followWhileHidden(on)` | A hidden window gets no snapshots until it's shown; on, it keeps getting them. The sleep timer asks for this while "after this song" waits, so it still pauses in the tray |
| `exportDiagnostics()` | Save a credential-free report |
| `updates.check()`, `updates.install()`, `updates.open()` | Updates from GitHub releases; the state is `update` in the snapshot (`mode` install, notify, or off; `status`; `version`). `install()` restarts into a downloaded update, `open()` opens the new release's page for copies that can't update themselves |

Queue entries have identities: `snapshot.player.entryIds[i]` names the entry at `queue[i]`. Select and seek by entry, not by track id: `queue.jump` takes the entry id, and seek commands carry the `entryId` captured when the gesture began, so a seek that lands after the track changed is refused instead of seeking the wrong song.

On the desktop the main process reports plays and saves the queue; the renderer must not call `library.reportPlay` or `library.saveQueue` there. LRCLIB is contacted only when both the call and the stored setting allow it.

Mutations return `{ ok: true, value }` or `{ ok: false, error }` and every failure is shown.

## Renderer conventions

- **Playlist edits** go through `playlistEditor(id)` in `library.ts`, or `usePlaylist(id)` in components. There is one editor per playlist, shared by its page and every menu. It queues edits and sends them to the server one at a time, then reconciles the local list with the server's read-back. Don't call the playlist mutations in `library.*` directly from views. New playlists go through `createPlaylist()` in `menu.tsx`, which refreshes the playlist list and opens the new one.
- **Menus and commands** register through `registry.ts`. Ids are namespaced by owner (`builtin:play`). Registering an id that is still live throws `RegistryCollision`; dispose the old registration first. Disposers are idempotent and never remove a newer registration with the same id. `registry.scope(owner)` gives an extension its own add functions and one `dispose()` for everything it added.
- `tracksOf(target)` in `menu.tsx` returns a `Result`. Show its error; don't assume the tracks loaded.
- **Navigation state** lives in the route. The Records and Tracks sorts are part of the route, so Back returns to the same order and scroll offset. So is the Records decade (`decade`). A fresh start opens Home (`{ view: 'home' }`); a reload stays where it was. Home's shelves each load on their own through `useResource`, twelve records at most, except that Your mixes waits for Most played's list to learn whether there is history, and its automatic playlists show their names without drawing songs.
- **Contrast.** `--accent` is for marks and large type (3:1 against the ground). `--accent-text` is for normal-weight text: it keeps 4.5:1 against both the ground and the selected-row tint. Use it for the current track number. Lyrics stay in ink and soft: the current line is ink and its words fill from soft to ink as they are sung.

## Browser build

The browser build uses `bridge/previewLibrary.ts` instead of `window.squiggly`. `npm run web` and `npm run preview` bind 127.0.0.1. Reaching them from another address requires `SQUIGGLY_WEB_PASSWORD` (12 or more characters) on the host; without it `/api` serves loopback only. `webSession.status()` reports whether a password is required and whether this browser is signed in; `signIn` and `signOut` manage the HttpOnly session cookie. `onSignedOut(listener)` fires when any `/api` call returns 401, so the UI can return to the sign-in screen. The cookie is same-origin, so `<audio>` and `<img>` URLs under `/api` need no extra headers.

## Android app

`window.squigglyAndroid` (`AndroidBridge` in `packages/core/contracts.ts`) is installed by `apps/android/web/main.ts` before the renderer loads. `library.ts` takes its `library`, and the connect screen and Settings › Disconnect use its `session`, as they use the desktop's bridge. `player.ts` keeps the queue in the page (the browser's queue code), and every change to `entryIds` goes to `player.sync()`, which sends the native player only the edits (`apps/android/web/queue.ts`). Loading an entry is `player.load(entryId, …)`, never an index. The native player moves between songs by itself; its reports name the entry playing and a `playId` that changes whenever an entry starts from the top, which is a new play for reporting. Reports from before the page's last load or queue replacement are dropped by sequence number.

Covers use the browser build's `/api/cover?id=…&size=…` addresses; the native side answers them, so no component sees a credential. The page reports plays and saves the queue itself, under the same settings as the browser.

## Audio truth rules

- Unknown remains unknown. Do not turn missing sample rates or bit depths into sensible-looking defaults.
- Distinguish source metadata, decoded sample format, mpv output, and unverified OS/DAC behavior.
- Exclusive output is a request. `exclusiveRequested` says what mpv accepted, not what the OS granted; never badge it as bit-perfect.
- A raw stream request does not prove the server returned unmodified audio.
- Volume below 100% means attenuation. Decoder sample format is not original file bit depth.
- The desktop plays through libmpv only. The browser build plays through the browser and says so in the signal-path sentence. The Android app plays through ExoPlayer, asks for the original file as the desktop does, and says when it fell back to the server's MP3.

## Performance and security rules

- No per-frame clock in app-wide state. The squiggle interpolates between snapshots; views subscribe with selectors.
- The seek squiggle animates continuously while visible; that is intentional. It draws every frame while playing and 30 frames a second while paused, and draws nothing while the window is hidden. Reduced motion gets a still wave. Other decorative motion stops while paused or hidden.
- Lyrics run one animation frame loop while playing and visible. It writes each sung word's progress to its span (`--p`, `data-progress`) and re-renders only when the line changes; paused, it paints once. Word times come with the lyrics (`wordTiming`); lines without exact times are estimated by `timeWords()` in `packages/lyrics/words.ts`, the same on desktop and web. Reduced motion lights whole words and drops the blur.
- Window long lists and page the library. Caches are bounded.
- Never import Node, Electron, Koffi, server authentication, or the private player protocol into renderer code.
- Keep passwords out of renderer state and storage; never hand authenticated URLs to components. The Android app is the one exception to the first half: the page is the whole app there, so the connector holds its token in the page's memory, and the password passes through the bridge at sign-in and at launch. It is never stored in the page (`SecureAccount.kt` keeps it sealed natively) and never logged: Capacitor's logging is off because it would write plugin arguments to logcat.

`npm run check` runs typecheck and tests; `npm run test:desktop` checks the preload bridge and process isolation.
