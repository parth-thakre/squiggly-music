import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppSnapshot, ConfigApi, ConfigFiles, DesktopBridge, ExtensionInfo, ExtensionsApi, KeptApi, KeptProgress, LibraryApi, SystemMediaApi, SystemMediaState, UpdatesApi } from '../../../packages/core/contracts';

// The main process validates every argument. Covers load through its credential-free squiggly-art scheme.
const call = (method: Exclude<keyof LibraryApi, 'coverUrl'>, ...args: unknown[]) => ipcRenderer.invoke(`squiggly:library:${method}`, args);
const library: LibraryApi = {
  albums: (type, offset, size, years) => call('albums', type, offset, size, ...(years ? [years] : [])),
  album: id => call('album', id),
  artists: () => call('artists'),
  artist: id => call('artist', id),
  playlists: () => call('playlists'),
  playlist: id => call('playlist', id),
  genres: () => call('genres'),
  starred: () => call('starred'),
  randomSongs: options => call('randomSongs', options),
  tracks: (sort, offset, size, seed) => call('tracks', sort, offset, size, seed),
  search: (query, options) => call('search', query, ...(options ? [options] : [])),
  star: (target, id, starred) => call('star', target, id, starred),
  createPlaylist: (name, trackIds) => call('createPlaylist', name, trackIds),
  addToPlaylist: (playlistId, trackIds) => call('addToPlaylist', playlistId, trackIds),
  updatePlaylist: (playlistId, changes) => call('updatePlaylist', playlistId, changes),
  removeFromPlaylist: (playlistId, indexes) => call('removeFromPlaylist', playlistId, indexes),
  reorderPlaylist: (playlistId, trackIds) => call('reorderPlaylist', playlistId, trackIds),
  deletePlaylist: playlistId => call('deletePlaylist', playlistId),
  similarSongs: (id, count) => call('similarSongs', id, count),
  topSongs: (artistId, count) => call('topSongs', artistId, count),
  // The main process also requires the lyricsLookup setting before contacting LRCLIB.
  lyrics: (track, lookup) => call('lyrics', track, lookup),
  // The desktop main process reports plays and saves the queue itself; these exist for parity.
  reportPlay: (trackId, event) => call('reportPlay', trackId, event),
  savedQueue: () => call('savedQueue'),
  saveQueue: (trackIds, currentIndex, positionSeconds) => call('saveQueue', trackIds, currentIndex, positionSeconds),
  rate: (target, id, rating) => call('rate', target, id, rating),
  coverUrl: (coverArt, size) => `squiggly-art://cover/${encodeURIComponent(String(coverArt))}?size=${Math.min(1200, Math.max(32, Math.round(Number(size)) || 300))}`,
  artistInfo: artistId => call('artistInfo', artistId),
  songsByGenre: (genre, offset, size) => call('songsByGenre', genre, offset, size),
  nowPlaying: () => call('nowPlaying'),
  createShare: (ids, description, expiresAt) => call('createShare', ids, description ?? null, expiresAt ?? null),
  shares: () => call('shares'),
  deleteShare: id => call('deleteShare', id),
  radioStations: () => call('radioStations'),
};
// Push channels from the main process, as subscribe functions.
function listen<T>(channel: string, listener: (value: T) => void) {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}
// The config folder, passed by the main process as a window argument so `dir` is ready at once.
const configDir = process.argv.find(arg => arg.startsWith('--squiggly-config='))?.slice('--squiggly-config='.length) ?? '';
const config: ConfigApi = {
  dir: configDir,
  read: () => ipcRenderer.invoke('squiggly:config:read'),
  subscribe: listener => listen<ConfigFiles>('squiggly:config', listener),
  openDir: () => ipcRenderer.invoke('squiggly:config:open-dir'),
};
const extensions: ExtensionsApi = {
  list: () => ipcRenderer.invoke('squiggly:extensions:list'),
  subscribe: listener => listen<ExtensionInfo[]>('squiggly:extensions', listener),
  setEnabled: (id, enabled) => ipcRenderer.invoke('squiggly:extensions:set-enabled', [id, enabled]),
  reload: () => ipcRenderer.invoke('squiggly:extensions:reload'),
  remove: id => ipcRenderer.invoke('squiggly:extensions:remove', id),
  openDir: () => ipcRenderer.invoke('squiggly:extensions:open-dir'),
  writeClipboard: text => ipcRenderer.invoke('squiggly:extensions:clipboard', text),
};
const media: SystemMediaApi = {
  // The main process adds this argument only to the main window, and not on Linux.
  hosted: process.argv.includes('--squiggly-media-session'),
  subscribe: listener => listen<SystemMediaState | null>('squiggly:media', listener),
};
const updates: UpdatesApi = {
  check: () => ipcRenderer.invoke('squiggly:update:check'),
  install: () => ipcRenderer.invoke('squiggly:update:install'),
  open: () => ipcRenderer.invoke('squiggly:update:open'),
};
// Songs kept on this computer. Songs go by id; the main process looks the tracks up itself and
// never sends a path back.
const kept: KeptApi = {
  state: () => ipcRenderer.invoke('squiggly:kept:state'),
  present: () => ipcRenderer.invoke('squiggly:kept:present'),
  container: (kind, id) => ipcRenderer.invoke('squiggly:kept:container', [kind, id]),
  subscribe: listener => listen<KeptProgress>('squiggly:kept', listener),
  keep: ({ kind, id, name, artist, coverArt, tracks }) => ipcRenderer.invoke('squiggly:kept:keep', { kind, id, name, artist, coverArt, trackIds: tracks.map(track => track.id) }),
  cancel: (kind, id) => ipcRenderer.invoke('squiggly:kept:cancel', [kind, id]),
  forget: (kind, id) => ipcRenderer.invoke('squiggly:kept:forget', [kind, id]),
  forgetAll: () => ipcRenderer.invoke('squiggly:kept:forget-all'),
  openDir: () => ipcRenderer.invoke('squiggly:kept:open-dir'),
};
const bridge: DesktopBridge = {
  snapshot: () => ipcRenderer.invoke('squiggly:get-snapshot'),
  subscribe: listener => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on('squiggly:snapshot', handler);
    return () => ipcRenderer.removeListener('squiggly:snapshot', handler);
  },
  command: command => ipcRenderer.invoke('squiggly:command', command),
  openFiles: () => ipcRenderer.invoke('squiggly:open-files'),
  // Files dropped on the window. Their paths are looked up here and go straight to the main
  // process, which checks them; the page never sees one. A File that isn't on disk (one the page
  // made) has no path, and is sent as '' so the main process counts it among those left out.
  openDropped: (files, mode) => ipcRenderer.invoke('squiggly:open-paths', [
    (Array.isArray(files) ? files : []).map(file => { try { return webUtils.getPathForFile(file); } catch { return ''; } }), mode]),
  connect: connection => ipcRenderer.invoke('squiggly:connect', connection),
  playTracks: (trackIds, startIndex) => ipcRenderer.invoke('squiggly:play-tracks', [trackIds, startIndex]),
  resumeQueue: () => ipcRenderer.invoke('squiggly:resume-queue'),
  queue: {
    add: (trackIds, where) => ipcRenderer.invoke('squiggly:queue:add', [trackIds, where]),
    move: (from, to) => ipcRenderer.invoke('squiggly:queue:move', [from, to]),
    remove: indexes => ipcRenderer.invoke('squiggly:queue:remove', [indexes]),
    clear: () => ipcRenderer.invoke('squiggly:queue:clear'),
    jump: (index, entryId) => ipcRenderer.invoke('squiggly:queue:jump', [index, entryId]),
  },
  // The main process owns radio, so it keeps topping up while this window is hidden.
  radio: {
    start: seed => ipcRenderer.invoke('squiggly:radio:start', seed),
    stop: () => ipcRenderer.invoke('squiggly:radio:stop'),
  },
  library,
  config,
  extensions,
  media,
  updates,
  settings: () => ipcRenderer.invoke('squiggly:get-settings'),
  updateSettings: changes => ipcRenderer.invoke('squiggly:update-settings', changes),
  window: {
    toggleMini: () => ipcRenderer.invoke('squiggly:window:toggle-mini'),
    setAlwaysOnTop: on => ipcRenderer.invoke('squiggly:window:always-on-top', on),
    // The main process adds this argument only to the mini player's window.
    isMini: process.argv.includes('--squiggly-mini'),
    frameless: process.argv.includes('--squiggly-frameless'),
    tintControls: (ink, ground) => ipcRenderer.invoke('squiggly:window:tint-controls', ink, ground),
    followWhileHidden: on => ipcRenderer.invoke('squiggly:window:follow-while-hidden', on),
  },
  disconnect: () => ipcRenderer.invoke('squiggly:disconnect'),
  exportDiagnostics: () => ipcRenderer.invoke('squiggly:export-diagnostics'),
  saveM3u: (name, entries) => ipcRenderer.invoke('squiggly:save-m3u', [name, entries]),
  kept,
  retryServer: passive => ipcRenderer.invoke('squiggly:retry-server', passive === true),
  // Only in betas with remote diagnostics built in, whose main process adds this argument.
  ...(process.argv.includes('--squiggly-diagnostics') ? { sendDiagnostics: () => ipcRenderer.invoke('squiggly:diagnostics:send') } : {}),
};
contextBridge.exposeInMainWorld('squiggly', bridge);
