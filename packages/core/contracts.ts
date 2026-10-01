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
  // 'station': an internet radio station from the server's list (RadioStation), a live stream
  // with no duration, album, or cover. Its id is the station's id marked as a station's
  // (stationTrack, stationIdOf in stations.ts), so it never matches a song's.
  source: 'local' | 'navidrome' | 'station';
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
  // The account's own rating, 1 to 5. Absent when unrated (or rated 0, which is the same).
  userRating?: number;
  // The file's path as the server reports it (Subsonic `path`), for playlist files (m3u.ts).
  // Absent when the server gives none, and for local files, whose paths stay in the main process.
  path?: string | null;
  // The file's size in bytes as the server reports it (Subsonic song.size). Absent when it sends none.
  size?: number;
}
// One credited artist with their own page. See Track.artists.
export interface ArtistRef { id: string; name: string }
export interface Album {
  id: string; name: string; artist: string; songCount: number;
  artistId: string | null; year: number | null; genre: string | null; duration: number | null;
  coverArt: string | null; starred: boolean;
  // When the server splits the credit into several artists; `artist` stays the display text.
  artists?: ArtistRef[];
  // The account's own rating, 1 to 5. Absent when unrated.
  userRating?: number;
}
export interface Artist { id: string; name: string; albumCount: number; coverArt: string | null; starred: boolean; userRating?: number }
export interface AlbumDetail {
  album: Album; tracks: Track[];
  // OpenSubsonic's discTitles: the discs the files name ("Live at the Roundhouse"). Absent when none do.
  discTitles?: DiscTitle[];
}
export interface DiscTitle { disc: number; title: string }
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
// search3's page for each kind: how many (0 to 200; 0 skips that kind) and from where. Left out,
// a search finds 8 artists, 16 records, and 40 songs, each from the top.
export interface SearchOptions { artistCount?: number; artistOffset?: number; albumCount?: number; albumOffset?: number; songCount?: number; songOffset?: number }
// capped: the server returned as many of that kind as were asked for, so there may be more.
// Subsonic gives no totals, so how many more is unknown.
export interface SearchResults extends LibraryItems { capped: { artists: boolean; albums: boolean; tracks: boolean } }
export type AlbumListType = 'newest' | 'recent' | 'frequent' | 'highest' | 'random' | 'starred' | 'alphabeticalByName' | 'alphabeticalByArtist' | 'byYear';
// The years a byYear list covers, inclusive. Only byYear takes them.
export interface AlbumYears { fromYear: number; toYear: number }
export interface RandomSongOptions { size: number; genre?: string; fromYear?: number; toYear?: number }
// The Records sorts, for tracks. Most and recently played list played tracks only, and top
// rated (highest) rated tracks only.
export type TrackSort = 'newest' | 'alphabeticalByName' | 'alphabeticalByArtist' | 'frequent' | 'recent' | 'random' | 'highest';
// sorted is false when the server can't sort tracks (only Navidrome's own API can): the page is
// in the server's one fixed order, whatever sort was asked for. plainHttp: Navidrome could sort,
// but its API signs in with the password itself, which isn't sent over plain HTTP beyond this
// network.
export interface TrackPage { tracks: Track[]; sorted: boolean; plainHttp?: true }
export type StarTarget = 'track' | 'album' | 'artist';
// A rating from one to five stars; 0 clears it.
export type Rating = 0 | 1 | 2 | 3 | 4 | 5;

// Library browsing, shared by the desktop bridge (IPC to the main process) and the
// browser preview (HTTP to the dev server). Both call the same OpenSubsonic connector.
export interface LibraryApi {
  albums(type: AlbumListType, offset: number, size: number, years?: AlbumYears): Promise<Result<Album[]>>;
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
  search(query: string, options?: SearchOptions): Promise<Result<SearchResults>>;
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
  // Rates a song, record, or artist for this account (Subsonic setRating). 0 clears the rating.
  rate(target: StarTarget, id: string, rating: Rating): Promise<Result>;
  // A URL the renderer may load directly. It never contains credentials.
  coverUrl(coverArt: string, size: number): string;
  // What the server's agents (Last.fm, Spotify) know about an artist. Every field may be empty.
  artistInfo(artistId: string): Promise<Result<ArtistInfo>>;
  // One genre's songs, a page at a time. Fewer than size: the last page.
  songsByGenre(genre: string, offset: number, size: number): Promise<Result<Track[]>>;
  // What other accounts on the server are playing now (getNowPlaying). This account's own
  // players are left out. Empty when nobody else is listening.
  nowPlaying(): Promise<Result<NowPlayingEntry[]>>;
  // Public links (Subsonic shares) to songs, a record, or a playlist: ids of one kind. Navidrome
  // offers them only with EnableSharing on; otherwise these fail with a plain message.
  // expiresAt is epoch milliseconds; without it the server picks (Navidrome: a year).
  createShare(ids: string[], description?: string, expiresAt?: number): Promise<Result<Share>>;
  shares(): Promise<Result<Share[]>>;
  deleteShare(id: string): Promise<Result>;
  // The server's internet radio stations (getInternetRadioStations), read-only. Their stream
  // addresses stay with the connector's host, as song streams do; stationTrack() queues one.
  radioStations(): Promise<Result<RadioStation[]>>;
}
// One of someone else's players, as the server last heard from it.
export interface NowPlayingEntry { username: string; track: Track }
// A public link the server made (createShare). Times are the server's ISO strings.
export interface Share {
  id: string;
  // The public address. It carries no credentials.
  url: string;
  description: string | null;
  created: string | null;
  // null: the server reported no expiry.
  expires: string | null;
  lastVisited: string | null;
  visitCount: number | null;
  // What the link plays, as the server lists it: songs, or a record.
  entries: ShareEntry[];
}
export interface ShareEntry { id: string; title: string }
// An internet radio station. homePageUrl is http(s) only, or null.
export interface RadioStation { id: string; name: string; homePageUrl: string | null }
export interface ArtistInfo {
  // Plain text: the server's HTML with its tags and its "Read more on Last.fm" link taken out.
  biography: string | null;
  musicBrainzId: string | null;
  lastFmUrl: string | null;
  // External addresses (Last.fm and the like). The renderer doesn't load them: its CSP only
  // allows covers served through the app.
  images: { small: string | null; medium: string | null; large: string | null };
  // Only artists in this library: the server gives ids to those alone.
  similar: ArtistRef[];
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
  playCountsAt: 25 | 50 | 75 | 90; // percent of a song that has to play before it counts
  miniOnTop: boolean;         // keep the mini player above other windows
  outputDevice: string;       // mpv audio-device name; 'auto' is the system default
  checkForUpdates: boolean;   // ask GitHub for new releases at launch and every six hours
  keptLimitMb: number;        // how much room songs kept on this device may take, in MB (1024 * 1024 bytes)
  diagnostics: boolean;       // betas with remote diagnostics built in: send them (off: nothing sent or written)
}
export interface QueueApi {
  // A number inserts before the entry at that index.
  add(trackIds: string[], where: 'next' | 'end' | number): Promise<Result>;
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
export type AudioServer = 'pipewire' | 'pulseaudio';
// How the sink was found. 'stream': by following mpv's own stream to the sink the server linked
// it to. 'device' (the sink mpv asked for) and 'default' (the server's default sink) are guesses
// made when mpv's stream wasn't found; the session manager may have put it somewhere else.
export type SinkRoute = 'stream' | 'device' | 'default';
// What the sound server reports about the sink mpv plays into: the rate, sample format, and
// channel count it has opened that sink with. The main process asks it on Linux (main/sinks.ts).
// It is the server's report, not what a DAC receives. `name` is the sink's description.
// `resampling` is true only when the sink was found through mpv's stream and its rate and mpv's
// output rate are both known and differ, false when they are equal, and null otherwise.
export interface AudioSink {
  server: AudioServer;
  route: SinkRoute;
  name: string;
  rate: number | null;
  format: string | null;
  channels: number | null;
  resampling: boolean | null;
}
// 'auto' or an output the engine listed. An mpv device string can name an ALSA plugin, and the
// file plugin runs commands, so no other name may reach audio-device.
export const listedDevice = (name: string, devices: readonly AudioDevice[]) => name === 'auto' || devices.some(d => d.name === name);
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
  // Linux only, filled in by the main process; null when the server wasn't asked or didn't answer.
  sink: AudioSink | null;
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
  // Which play of the current entry this is: a string that changes whenever a song starts from the
  // top (another entry, the same one loaded again, a repeat-one loop, a jump to the entry playing)
  // and never on a seek or a pause. '' before anything has played. Anything that counts plays
  // (play reports) keys on it; the browser and Android keep one in the page (PlayerState.playId).
  playId: string;
  // Radio is owned by the main process so it keeps going while the main window is hidden.
  radio: { label: string } | null;
  devices: AudioDevice[];
  audio: AudioPath;
  // Queue behaviour, never the signal: what follows the last song (repeat), and whether the songs
  // after the current one were put in random order (shuffle). See packages/core/playOrder.ts.
  repeat: RepeatMode;
  shuffle: boolean;
  // A station playing: the title its stream announces (ICY StreamTitle), as mpv reads it. Null
  // when it announces none, and for anything but a station. Absent from older hosts.
  stationTitle?: string | null;
  // The current entry is a kept song and the player opened its file on this device, not the
  // stream. Absent from older hosts, which means false.
  fromDevice?: boolean;
}
// off: the queue stops after its last song. all: it wraps to the first. one: a finished song
// starts again; Next still moves on.
export type RepeatMode = 'off' | 'all' | 'one';
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
  // portable exe and the Linux packages). off: development builds and Flatpak.
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
  // The new version's release page, where the portable exe and the Linux packages are downloaded.
  open(): Promise<Result>;
}
export interface ServerState {
  connected: boolean; name: string | null; sessionId: string | null;
  // The server address and username signed in, for what the renderer keeps per account.
  account: string | null;
  // The saved sign-in (see apps/desktop/main/account.ts), without its password.
  saved: { url: string; username: string } | null;
  // Whether connecting will save the sign-in: the system can encrypt the password.
  canRemember: boolean;
  // Reconnecting with the saved sign-in at launch, and why that failed, if it did.
  reconnecting: boolean; reconnectError: string | null;
  // Whether the server answers (packages/core/reach.ts). Absent from older hosts: online.
  reach?: Reachability;
  // Finished plays waiting to be reported until the server answers again.
  queuedPlays?: number;
}
// A failure carries `unreachable` when no answer came at all (the connection failed, the request
// timed out, or a gateway said the server is down), as opposed to an answer that refused.
export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string; unreachable?: true };
// What connecting did. plain-http: the address was typed without a scheme and only plain HTTP
// answered, so nothing was signed in. Connecting again to `url` (http:// written out) does,
// once the person has agreed to send the password unprotected.
export type ConnectOutcome = { type: 'connected' } | { type: 'plain-http'; url: string };

// Whether the server is out of reach. away: the app shows what is kept and stops asking the
// server; since: when that began (epoch ms); checking: a probe is on its way; checkedAt: the last
// probe's answer (epoch ms).
export interface Reachability { away: boolean; since: number | null; checking: boolean; checkedAt: number | null }
export const ONLINE: Reachability = { away: false, since: null, checking: false, checkedAt: null };

// Songs kept on this device (desktop and Android). A record, a playlist, or a mix's draw is kept
// as a container of song ids; the songs are files, the originals as the server sent them.
export type KeepKind = 'album' | 'playlist' | 'mix';
export interface KeepRequest { kind: KeepKind; id: string; name: string; artist: string | null; coverArt: string | null; tracks: Track[] }
// present: how many of its songs are kept; bytes: what they take.
export interface KeptContainer { kind: KeepKind; id: string; name: string; artist: string | null; coverArt: string | null; total: number; present: number; bytes: number; keptAt: number }
// A keep in progress. paused: the server went away and it goes on when the server is back.
// stopped: it ended early, and `error` says why.
export interface KeptJob { kind: KeepKind; id: string; name: string; done: number; total: number; failed: number; state: 'waiting' | 'keeping' | 'paused' | 'stopped'; error: string | null }
// revision changes whenever what is kept changes. dir: the kept folder (desktop only). notice: a
// one-time line, such as the list of kept songs having been unreadable.
export interface KeptState { revision: number; songs: number; usedBytes: number; limitBytes: number; containers: KeptContainer[]; jobs: KeptJob[]; dir: string | null; notice: string | null }
// What each push carries while downloads run.
export interface KeptProgress { revision: number; usedBytes: number; jobs: KeptJob[] }
// A container and its kept songs, in container order.
export interface KeptDetail { container: KeptContainer; trackIds: string[]; tracks: Track[] }
export interface KeptApi {
  state(): Promise<KeptState>;
  // Every kept track id. Pulled again when the revision changes.
  present(): Promise<string[]>;
  container(kind: KeepKind, id: string): Promise<Result<KeptDetail>>;
  subscribe(listener: (progress: KeptProgress) => void): () => void;
  // Resolves once the keep is admitted (there is room, and the songs are known), not when it ends.
  keep(request: KeepRequest): Promise<Result>;
  // Stops a keep, or clears one that stopped or paused. Songs already kept stay.
  cancel(kind: KeepKind, id: string): Promise<Result>;
  forget(kind: KeepKind, id: string): Promise<Result>;
  forgetAll(): Promise<Result>;
  // Desktop only: shows the kept folder.
  openDir?(): Promise<Result>;
}
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
  // Found in the folder but never turned on or off. It stays off until the user turns it on.
  isNew: boolean;
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
  // Files dropped on the window, opened as openFiles opens its choice. The preload looks up each
  // File's path on disk (Electron's webUtils) and sends the paths straight to the main process;
  // they never come back to the page. A File the page made itself has no path. The main process
  // keeps only regular files with an audio extension; folders and anything else are left out
  // and counted in `skipped`. More than a full queue is refused. 'play' replaces the queue;
  // 'queue' adds to the end when something is loaded.
  openDropped(files: File[], mode: 'play' | 'queue'): Promise<Result<{ opened: number; skipped: number }>>;
  connect(connection: Connection): Promise<Result<ConnectOutcome>>;
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
    // A hidden window gets no snapshots until it's shown. On, it keeps getting them: the sleep
    // timer's "after this song" asks for this while it waits, even in the tray.
    followWhileHidden(on: boolean): Promise<Result>;
  };
  disconnect(): Promise<Result>;
  exportDiagnostics(): Promise<Result>;
  // Saves an extended M3U (m3u.ts) through a save dialog, as `<name>.m3u8`. Local files are
  // written with their paths, which only the main process knows. Cancelling is not an error.
  saveM3u(name: string, entries: M3uEntry[]): Promise<Result>;
  // Songs kept on this computer. Absent from stand-ins, which means the build keeps nothing.
  kept?: KeptApi;
  // Asks the server again while it is out of reach. passive: a check the page made on its own
  // (focus, the network coming back), skipped when one was made in the last few seconds.
  retryServer?(passive?: boolean): Promise<Result>;
  // Betas with remote diagnostics built in only (apps/desktop/main/remoteDiagnostics.ts): send
  // everything queued now. Absent otherwise, which is how the window knows to hide the
  // diagnostics setting, its marker, and this command.
  sendDiagnostics?(): Promise<Result<string>>;
}
// One song in a playlist file. `local` marks a file on this computer (Track.source 'local').
export interface M3uEntry {
  id: string; local: boolean; title: string; artist: string; album: string;
  duration: number | null; path: string | null; suffix: string | null;
}

export const emptyAudio = (): AudioPath => ({
  codec: null, decoderRate: null, decoderFormat: null, decoderChannels: null,
  outputRate: null, outputFormat: null, outputChannels: null, outputBackend: null,
  requestedDevice: 'auto', replayGain: null, exclusiveRequested: null, filters: null, bufferSeconds: null,
  streamBytesPerSecond: null, buffering: false, sink: null,
});
export const emptyPlayer = (): PlayerSnapshot => ({
  engine: 'starting', error: null, playing: false, position: 0, duration: 0,
  volume: 100, currentIndex: -1, queue: [], entryIds: [], playId: '', radio: null, devices: [], audio: emptyAudio(),
  repeat: 'off', shuffle: false, stationTitle: null, fromDevice: false,
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
  account: string | null;
  signIn: Pick<ServerState, 'saved' | 'canRemember' | 'reconnecting' | 'reconnectError'>;
  // Whether the server answers, as on the desktop. Absent means online.
  reach?: Reachability;
  queuedPlays?: number;
}
// What the native player reports. Times are seconds; a duration of 0 is unknown.
export interface AndroidPlayback {
  // The queue entry loaded, or null with nothing loaded.
  entryId: string | null;
  // Changes whenever an entry starts from its beginning, which makes it a new play. The page
  // shows it as PlayerState.playId, a string like PlayerSnapshot.playId.
  playId: number;
  playing: boolean; buffering: boolean; ended: boolean; position: number; duration: number;
  // The original couldn't be decoded, so the server's 320 kbps MP3 is playing instead.
  fallback: boolean;
  // 'network' (it couldn't be fetched or opened) or 'unplayable' (anything else, such as a file
  // that couldn't be decoded).
  error: string | null;
  // A station playing: the title its stream announces, from ExoPlayer's ICY metadata. Null when
  // it announces none.
  stationTitle?: string | null;
  // The entry playing is a kept file on the phone, not the stream.
  local?: boolean;
}
export interface AndroidQueueSnapshot { queue: Track[]; entryIds: string[]; index: number; playback: AndroidPlayback }
export interface AndroidBridge {
  library: LibraryApi;
  // Songs kept on the phone. Absent from older bridges.
  kept?: KeptApi;
  session: {
    get(): AndroidSession;
    subscribe(listener: (session: AndroidSession) => void): () => void;
    // Tries HTTPS, then HTTP (see ConnectOutcome), for an address without a scheme; saves the
    // sign-in when it can.
    connect(connection: Connection): Promise<Result<ConnectOutcome>>;
    // Tries the saved sign-in again, after it failed at launch (offline, say).
    reconnect(): Promise<Result>;
    // Stops playback, empties the native queue, and forgets the saved sign-in.
    disconnect(): Promise<Result>;
    // Asks the server again while it is out of reach (see DesktopBridge.retryServer).
    retry?(passive?: boolean): Promise<Result>;
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
    // ExoPlayer's repeat mode, so the queue wraps or a song repeats with the page asleep. The page
    // shuffles its own queue and sends the new order with sync().
    repeat(mode: RepeatMode): void;
    // The sleep timer, which the native player keeps as well as the page so it still pauses after
    // the app is swiped away. sleepAt pauses at that time (epoch milliseconds); sleepAfterPlay
    // pauses when the play with that AndroidPlayback.playId is over and another begins. Null cancels.
    sleepAt(at: number | null): void;
    sleepAfterPlay(playId: number | null): void;
  };
  // Saves an extended M3U (m3u.ts) as `<name>.m3u8` where the listener picks, through Android's
  // document picker: the WebView doesn't download files. Cancelling is not an error.
  saveM3u(name: string, entries: M3uEntry[]): Promise<Result>;
}

declare global { interface Window { squiggly?: DesktopBridge; squigglyAndroid?: AndroidBridge } }
