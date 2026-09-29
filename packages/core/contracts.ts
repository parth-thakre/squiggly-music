import type { Schema } from 'effect';
import type { CommandSchema, ConnectionSchema } from './validation';

export type PlayerCommand = Schema.Schema.Type<typeof CommandSchema>;
export type Connection = Schema.Schema.Type<typeof ConnectionSchema>;

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number | null;
  source: 'local' | 'navidrome';
  sourceFormat: string | null;
  sourceSampleRate: number | null;
  sourceBitDepth: number | null;
  // Library metadata. Absent for local files and older snapshots.
  albumId?: string | null;
  artistId?: string | null;
  coverArt?: string | null;
  // When the server splits the credit ("A & B") into several artists, each with a page;
  // `artist` stays the display text. Absent for a single artist.
  artists?: ArtistRef[];
  trackNumber?: number | null;
  discNumber?: number | null;
  year?: number | null;
  genre?: string | null;
  starred?: boolean;
}
// One credited artist with their own page. See Track.artists.
export interface ArtistRef { id: string; name: string }
export interface Album {
  id: string; name: string; artist: string; songCount: number;
  artistId: string | null; year: number | null; genre: string | null; duration: number | null;
  coverArt: string | null; starred: boolean;
  // When the server splits the credit into several artists; `artist` stays the display text.
  artists?: ArtistRef[];
}
export interface Artist { id: string; name: string; albumCount: number; coverArt: string | null; starred: boolean }
export interface AlbumDetail { album: Album; tracks: Track[] }
export interface ArtistDetail { artist: Artist; albums: Album[] }
export interface Playlist {
  id: string; name: string; comment: string | null; owner: string | null;
  songCount: number; duration: number; coverArt: string | null;
  // Server-managed playlists (smart .nsp rules, auto-imported .m3u files) cannot be edited.
  readonly: boolean; changed: string | null;
}
export interface PlaylistDetail { playlist: Playlist; tracks: Track[] }
export interface Genre { name: string; songCount: number; albumCount: number }
export interface LibraryItems { artists: Artist[]; albums: Album[]; tracks: Track[] }
export type AlbumListType = 'newest' | 'recent' | 'frequent' | 'highest' | 'random' | 'starred' | 'alphabeticalByName' | 'alphabeticalByArtist';
export interface RandomSongOptions { size: number; genre?: string; fromYear?: number; toYear?: number }
// The Records sorts, for tracks. Most and recently played list played tracks only.
export type TrackSort = 'newest' | 'alphabeticalByName' | 'alphabeticalByArtist' | 'frequent' | 'recent' | 'random';
// sorted is false when the server can't sort tracks (only Navidrome's own API can): the page is
// in the server's one fixed order, whatever sort was asked for.
export interface TrackPage { tracks: Track[]; sorted: boolean }
export type StarTarget = 'track' | 'album' | 'artist';

// Library browsing, shared by the desktop bridge (IPC to the main process) and the
// browser preview (HTTP to the dev server). Both call the same OpenSubsonic connector.
export interface LibraryApi {
  albums(type: AlbumListType, offset: number, size: number): Promise<Result<Album[]>>;
  album(id: string): Promise<Result<AlbumDetail>>;
  artists(): Promise<Result<Artist[]>>;
  artist(id: string): Promise<Result<ArtistDetail>>;
  playlists(): Promise<Result<Playlist[]>>;
  playlist(id: string): Promise<Result<PlaylistDetail>>;
  genres(): Promise<Result<Genre[]>>;
  starred(): Promise<Result<LibraryItems>>;
  randomSongs(options: RandomSongOptions): Promise<Result<Track[]>>;
  // Every track on the server, a page at a time. Fewer than size: the last page. `seed` keeps a
  // random order the same from page to page. See TrackPage for servers that can't sort.
  tracks(sort: TrackSort, offset: number, size: number, seed: string): Promise<Result<TrackPage>>;
  search(query: string): Promise<Result<LibraryItems>>;
  star(target: StarTarget, id: string, starred: boolean): Promise<Result>;
  createPlaylist(name: string, trackIds: string[]): Promise<Result<Playlist>>;
  addToPlaylist(playlistId: string, trackIds: string[]): Promise<Result>;
  // Editing. Server-managed (readonly) playlists reject these with a plain message.
  updatePlaylist(playlistId: string, changes: { name?: string; comment?: string }): Promise<Result>;
  removeFromPlaylist(playlistId: string, indexes: number[]): Promise<Result>;
  // Rewrites the playlist's songs in the given order (the API has no move operation).
  reorderPlaylist(playlistId: string, trackIds: string[]): Promise<Result>;
  deletePlaylist(playlistId: string): Promise<Result>;
  // Songs like the given song or artist id (getSimilarSongs), for radio. May be empty.
  similarSongs(id: string, count: number): Promise<Result<Track[]>>;
  topSongs(artistId: string, count: number): Promise<Result<Track[]>>;
  // Server lyrics first (embedded or .lrc); LRCLIB only when lookup is true and the server has none.
  lyrics(track: LyricsQuery, lookup: boolean): Promise<Result<Lyrics | null>>;
  // Play reporting and the server-saved queue. The desktop main process calls these itself;
  // the browser build calls them from the renderer.
  reportPlay(trackId: string, event: 'started' | 'finished'): Promise<Result>;
  savedQueue(): Promise<Result<SavedQueue | null>>;
  saveQueue(trackIds: string[], currentIndex: number, positionSeconds: number): Promise<Result>;
  // A URL the renderer may load directly. It never contains credentials.
  coverUrl(coverArt: string, size: number): string;
}
export interface LyricsQuery { id: string; title: string; artist: string; album: string; duration: number | null }
// Times are seconds from the beginning of the song. A synced line's words, joined, spell its
// text exactly: the space after a word travels with that word.
export interface LyricWord { start: number; end: number; text: string }
export interface LyricLine {
  // null for unsynced lyrics. end is when the singing of the line stops, when known.
  start: number | null; end?: number | null; text: string;
  // Synced lines with text only.
  words?: LyricWord[];
}
export interface Lyrics {
  synced: boolean; lines: LyricLine[];
  // 'exact' when every line came with its own word times (OpenSubsonic cues, enhanced LRC);
  // 'estimated' when some were spread across the line by length; null for unsynced lyrics.
  wordTiming: 'exact' | 'estimated' | null;
  source: 'server' | 'lrclib';
}
export interface SavedQueue { tracks: Track[]; currentIndex: number; positionSeconds: number; changed: string | null; changedBy: string | null }

// Desktop-only preferences, stored by the main process.
export interface Settings {
  lyricsLookup: boolean;      // allow LRCLIB for songs without server lyrics
  exclusiveOutput: boolean;   // mpv audio-exclusive: bypass the system mixer where the platform allows
  closeToTray: boolean;       // closing the window keeps playback running in the tray
  syncQueue: boolean;         // save the queue to Navidrome and offer to resume it
  reportPlays: boolean;       // tell Navidrome what was played
  miniOnTop: boolean;         // keep the mini player above other windows
  outputDevice: string;       // mpv audio-device name; 'auto' is the system default
  checkForUpdates: boolean;   // ask GitHub for new releases at launch and every six hours
}
export interface QueueApi {
  add(trackIds: string[], where: 'next' | 'end'): Promise<Result>;
  move(from: number, to: number): Promise<Result>;
  remove(indexes: number[]): Promise<Result>;
  // Removes everything except the current song.
  clear(): Promise<Result>;
  // Play the entry at this index. `entryId` must match that index in the latest snapshot,
  // so a queue that changed underneath the click is refused rather than playing the wrong song.
  jump(index: number, entryId: string): Promise<Result>;
}
export type RadioSeed = { kind: 'song'; trackId: string; label: string } | { kind: 'album' | 'artist'; id: string; label: string };
export interface RadioApi {
  // Replaces the queue with the seed and similar songs, then keeps it topped up.
  start(seed: RadioSeed): Promise<Result>;
  stop(): Promise<Result>;
}
export interface AudioDevice { name: string; description: string }
export interface AudioPath {
  codec: string | null;
  decoderRate: number | null;
  decoderFormat: string | null;
  decoderChannels: string | null;
  outputRate: number | null;
  outputFormat: string | null;
  outputChannels: string | null;
  outputBackend: string | null;
  requestedDevice: string;
  replayGain: string | null;
  // mpv's audio-exclusive option: what was requested, not whether the OS granted exclusive access.
  exclusiveRequested?: boolean | null;
  filters: string | null;
  bufferSeconds: number | null;
  streamBytesPerSecond: number | null;
  buffering: boolean;
}
export interface PlayerSnapshot {
  engine: 'starting' | 'ready' | 'unavailable' | 'crashed';
  error: string | null;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  currentIndex: number;
  queue: Track[];
  // One id per queue entry, parallel to `queue`, unique within the queue and stable across
  // moves. Two copies of the same song have different entry ids.
  entryIds: string[];
  // Radio is owned by the main process so it keeps going while the main window is hidden.
  radio: { label: string } | null;
  devices: AudioDevice[];
  audio: AudioPath;
}
export interface OperationMetric { name: string; count: number; errors: number; cancelled?: number; p50Ms: number; p95Ms: number }
export interface ProcessMetric { name: string; cpuPercent: number; memoryMB: number }
export interface Diagnostics {
  uptimeSeconds: number;
  startupMs: number | null;
  ipcCommands: number;
  playerMessagesPerSecond: number;
  playerBytesPerSecond: number;
  pendingCommands: number;
  eventLoopDelayMs: number;
  processes: ProcessMetric[];
  operations: OperationMetric[];
}
export interface AppSnapshot {
  player: PlayerSnapshot;
  diagnostics: Diagnostics;
  server: ServerState;
  update: UpdateState;
}
// Updates from GitHub releases (apps/desktop/main/updates.ts).
export interface UpdateState {
  // install: the app updates itself. notify: it says a version is out and links to it (the
  // portable exe, the RPM). off: development builds.
  mode: 'install' | 'notify' | 'off';
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error';
  current: string;          // this app's version
  version: string | null;   // the newer version, once one is found
  percent: number | null;   // download progress
  error: string | null;
}
export interface UpdatesApi {
  check(): Promise<Result>;
  // Restart to update. Only when an update is ready.
  install(): Promise<Result>;
  // The new version's release page, where the portable exe and the RPM are downloaded.
  open(): Promise<Result>;
}
export interface ServerState {
  connected: boolean; name: string | null; sessionId: string | null;
  // The saved sign-in (see apps/desktop/main/account.ts), without its password.
  saved: { url: string; username: string } | null;
  // Whether connecting will save the sign-in: the system can encrypt the password.
  canRemember: boolean;
  // Reconnecting with the saved sign-in at launch, and why that failed, if it did.
  reconnecting: boolean; reconnectError: string | null;
}
export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };
// The user's config folder (~/.config/squiggly on Linux, %APPDATA%\Squiggly on Windows).
// Files are read and watched by the main process; edits apply live.
export interface ThemeFile { id: string; name: string; tokens: unknown }
export interface ConfigFiles {
  keybindings: unknown | null;   // keybindings.json, validated by the renderer's command system
  themes: ThemeFile[];           // themes/*.json
  errors: string[];              // plain messages for files that could not be read
}
export interface ConfigApi {
  dir: string;
  read(): Promise<ConfigFiles>;
  subscribe(listener: (files: ConfigFiles) => void): () => void;
  openDir(): Promise<Result>;
}
// Extensions: folders in <config>/extensions, full trust (see docs/extensions.md, "Trust model").
export interface ExtensionInfo {
  id: string; name: string; version: string; description: string | null;
  // The extension's folder name inside <config>/extensions.
  folder: string;
  enabled: boolean;
  // A squiggly-ext:// URL for the compiled renderer entry, while the extension is on and compiles.
  rendererUrl: string | null;
  // package.json or compile problems, in plain words.
  error: string | null;
}
export interface ExtensionsApi {
  list(): Promise<ExtensionInfo[]>;
  subscribe(listener: (list: ExtensionInfo[]) => void): () => void;
  setEnabled(id: string, enabled: boolean): Promise<Result>;
  // Compiles every extension again and gives each a new URL, so the window starts it afresh.
  reload(): Promise<Result>;
  // Moves the extension's folder to the system trash.
  remove(id: string): Promise<Result>;
  openDir(): Promise<Result>;
  // For ctx.clipboard: the window's own clipboard API needs a permission the app doesn't grant.
  writeClipboard(text: string): Promise<Result>;
}
// The operating system's media controls on Windows and macOS: the Windows media flyout and
// media keys, macOS Now Playing. Linux has MPRIS in the main process instead.
export interface SystemMediaState {
  // -1 for the song saved on the server, shown while nothing is loaded.
  index: number; entryId: string; trackId: string;
  title: string; artist: string; album: string; coverArt: string | null;
  duration: number; position: number; playing: boolean;
}
export interface SystemMediaApi {
  // Whether this window hosts the media session: the main window, on Windows and macOS.
  hosted: boolean;
  // The current song and its state, or null when there is nothing to show (or exclusive output
  // needs the device to itself). Sent on changes, whether or not the window is visible.
  subscribe(listener: (state: SystemMediaState | null) => void): () => void;
}

export interface DesktopBridge {
  snapshot(): Promise<AppSnapshot>;
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void;
  command(command: PlayerCommand): Promise<Result>;
  openFiles(): Promise<Result>;
  connect(connection: Connection): Promise<Result>;
  // Replaces the queue with library tracks the main process has already seen, then plays from startIndex.
  playTracks(trackIds: string[], startIndex: number): Promise<Result>;
  // Resumes a queue saved on the server (from this or another device) at its song and position.
  resumeQueue(): Promise<Result>;
  queue: QueueApi;
  radio: RadioApi;
  library: LibraryApi;
  config: ConfigApi;
  extensions: ExtensionsApi;
  media: SystemMediaApi;
  updates: UpdatesApi;
  settings(): Promise<Settings>;
  updateSettings(changes: Partial<Settings>): Promise<Result<Settings>>;
  // The compact always-on-top window. Opening it from the mini player's own button returns to the full window.
  window: {
    toggleMini(): Promise<Result>; setAlwaysOnTop(on: boolean): Promise<Result>; isMini: boolean;
    // The main window has no title bar on Windows and Linux: the system's window buttons sit over
    // the top of the page, and tintControls gives them the room's ink colour (#rrggbb).
    frameless: boolean; tintControls(ink: string): Promise<Result>;
  };
  disconnect(): Promise<Result>;
  exportDiagnostics(): Promise<Result>;
}

export const emptyAudio = (): AudioPath => ({
  codec: null, decoderRate: null, decoderFormat: null, decoderChannels: null,
  outputRate: null, outputFormat: null, outputChannels: null, outputBackend: null,
  requestedDevice: 'auto', replayGain: null, exclusiveRequested: null, filters: null, bufferSeconds: null,
  streamBytesPerSecond: null, buffering: false,
});
export const emptyPlayer = (): PlayerSnapshot => ({
  engine: 'starting', error: null, playing: false, position: 0, duration: 0,
  volume: 100, currentIndex: -1, queue: [], entryIds: [], radio: null, devices: [], audio: emptyAudio(),
});
export const emptyDiagnostics = (): Diagnostics => ({
  uptimeSeconds: 0, startupMs: null, ipcCommands: 0, playerMessagesPerSecond: 0,
  playerBytesPerSecond: 0, pendingCommands: 0, eventLoopDelayMs: 0, processes: [], operations: [],
});

// The Android app (apps/android). Its web entry installs window.squigglyAndroid before the app
// starts. The connector runs in the page and reaches Navidrome through native HTTP; a native
// Media3 player holds the queue and plays it, so it keeps going with the screen off.
export interface AndroidSession {
  // False until the saved sign-in has been read; the page shows nothing before then.
  ready: boolean;
  connected: boolean; serverName: string | null;
  // Changes with every sign-in; library caches are dropped with it, as on the desktop.
  sessionId: string | null;
  signIn: Pick<ServerState, 'saved' | 'canRemember' | 'reconnecting' | 'reconnectError'>;
}
// What the native player reports. Times are seconds; a duration of 0 is unknown.
export interface AndroidPlayback {
  // The queue entry loaded, or null with nothing loaded.
  entryId: string | null;
  // Changes whenever an entry starts from its beginning, which makes it a new play.
  playId: number;
  playing: boolean; buffering: boolean; ended: boolean; position: number; duration: number;
  // The original couldn't be decoded, so the server's 320 kbps MP3 is playing instead.
  fallback: boolean;
  error: string | null;
}
export interface AndroidQueueSnapshot { queue: Track[]; entryIds: string[]; index: number; playback: AndroidPlayback }
export interface AndroidBridge {
  library: LibraryApi;
  session: {
    get(): AndroidSession;
    subscribe(listener: (session: AndroidSession) => void): () => void;
    // Tries HTTPS, then HTTP, for an address without a scheme; saves the sign-in when it can.
    connect(connection: Connection): Promise<Result>;
    // Tries the saved sign-in again, after it failed at launch (offline, say).
    reconnect(): Promise<Result>;
    // Stops playback, empties the native queue, and forgets the saved sign-in.
    disconnect(): Promise<Result>;
  };
  player: {
    // What the native player still holds from before the page loaded (the app was swiped away
    // while it played), or null.
    restore(): Promise<AndroidQueueSnapshot | null>;
    // Makes the native queue match these entries, keeping the one playing where it is.
    sync(queue: readonly Track[], entryIds: readonly string[]): void;
    load(entryId: string, options: { play: boolean; position: number }): void;
    play(): void; pause(): void;
    seek(entryId: string, seconds: number): void;
    volume(percent: number): void;
    subscribe(listener: (playback: AndroidPlayback) => void): () => void;
    // The bridge emptied the native queue (a new sign-in, or disconnecting); the page empties its own.
    onReset(listener: () => void): () => void;
  };
}

declare global { interface Window { squiggly?: DesktopBridge; squigglyAndroid?: AndroidBridge } }
