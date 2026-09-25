import { contextBridge, ipcRenderer } from 'electron';
import type { AppSnapshot, DesktopBridge, LibraryApi } from '../../../packages/core/contracts';

// The main process validates every argument. Covers load through its credential-free squiggly-art scheme.
const call = (method: Exclude<keyof LibraryApi, 'coverUrl'>, ...args: unknown[]) => ipcRenderer.invoke(`squiggly:library:${method}`, args);
const library: LibraryApi = {
  albums: (type, offset, size) => call('albums', type, offset, size),
  album: id => call('album', id),
  artists: () => call('artists'),
  artist: id => call('artist', id),
  playlists: () => call('playlists'),
  playlist: id => call('playlist', id),
  genres: () => call('genres'),
  starred: () => call('starred'),
  randomSongs: options => call('randomSongs', options),
  search: query => call('search', query),
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
  coverUrl: (coverArt, size) => `squiggly-art://cover/${encodeURIComponent(String(coverArt))}?size=${Math.min(1200, Math.max(32, Math.round(Number(size)) || 300))}`,
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
  settings: () => ipcRenderer.invoke('squiggly:get-settings'),
  updateSettings: changes => ipcRenderer.invoke('squiggly:update-settings', changes),
  window: {
    toggleMini: () => ipcRenderer.invoke('squiggly:window:toggle-mini'),
    setAlwaysOnTop: on => ipcRenderer.invoke('squiggly:window:always-on-top', on),
    // The main process adds this argument only to the mini player's window.
    isMini: process.argv.includes('--squiggly-mini'),
  },
  disconnect: () => ipcRenderer.invoke('squiggly:disconnect'),
  exportDiagnostics: () => ipcRenderer.invoke('squiggly:export-diagnostics'),
};
contextBridge.exposeInMainWorld('squiggly', bridge);
