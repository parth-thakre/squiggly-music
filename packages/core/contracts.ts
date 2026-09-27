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
  trackNumber?: number | null;
  discNumber?: number | null;
  year?: number | null;
  genre?: string | null;
  starred?: boolean;
}
export interface Album {
  id: string; name: string; artist: string; songCount: number;
  artistId: string | null; year: number | null; genre: string | null; duration: number | null;
  coverArt: string | null; starred: boolean;
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
export interface Lyrics {
  // start is seconds from the beginning of the song; null for unsynced lyrics.
  synced: boolean; lines: { start: number | null; text: string }[];
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
  server: { connected: boolean; name: string | null; sessionId: string | null };
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
  settings(): Promise<Settings>;
  updateSettings(changes: Partial<Settings>): Promise<Result<Settings>>;
  // The compact always-on-top window. Opening it from the mini player's own button returns to the full window.
  window: { toggleMini(): Promise<Result>; setAlwaysOnTop(on: boolean): Promise<Result>; isMini: boolean };
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

declare global { interface Window { squiggly?: DesktopBridge } }
