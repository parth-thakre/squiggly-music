import type { Connection, LibraryApi, Result } from '../../../../../packages/core/contracts';

// Browser build only: the host runs the real OpenSubsonic connector, with the login this page
// gave it (connect) or one from its environment. See scripts/navidrome-preview.ts for the /api
// contract. Every /api route needs the session cookie once the host sets a password. The
// cookies are HttpOnly and same-origin, so <audio src="/api/stream..."> and
// <img src="/api/cover..."> carry them without any custom headers.
const signedOutListeners = new Set<() => void>();
const notifySignedOut = () => { for (const listener of [...signedOutListeners]) listener(); };
const disconnectedListeners = new Set<() => void>();
const notifyDisconnected = () => { for (const listener of [...disconnectedListeners]) listener(); };
// The host's answer when it has no server for this browser (see notConnected in the host).
const notConnected = 'Not connected to a server. Connect from the page.';

/** Called when the host rejects a library call for want of a session, and after signOut(). */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => { signedOutListeners.delete(listener); };
}
/** Called when the host has no server for this browser (it restarted and forgot the connection, say). Not after disconnect(). */
export function onDisconnected(listener: () => void): () => void {
  disconnectedListeners.add(listener);
  return () => { disconnectedListeners.delete(listener); };
}

async function request<T>(path: string, init: RequestInit): Promise<{ status: number; result: Result<T> }> {
  try {
    const response = await fetch(path, { credentials: 'same-origin', ...init });
    const body: unknown = await response.json().catch(() => null);
    // Void results serialize without a value key.
    if (body && typeof body === 'object' && 'ok' in body && (body.ok === true || (body.ok === false && 'error' in body && typeof body.error === 'string'))) return { status: response.status, result: body as Result<T> };
    return { status: response.status, result: { ok: false, error: 'The preview server returned an unexpected response.' } };
  } catch { return { status: 0, result: { ok: false, error: 'Could not reach the preview server.' } }; }
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function call<T>(method: string, args: unknown[]): Promise<Result<T>> {
  const { status, result } = await request<T>(`/api/${method}`, post(args));
  if (status === 401) notifySignedOut();
  else if (status === 503 && !result.ok && result.error === notConnected) notifyDisconnected();
  return result;
}

export interface WebSessionStatus {
  /** The host has a password. */
  required: boolean;
  /** Library calls will be accepted. */
  signedIn: boolean;
  /** The host has a server for this browser. */
  connected: boolean;
  serverName: string | null;
  /** That server is this browser's own (connect), not the host's configured one, so it can disconnect. */
  pageConnection: boolean;
}
const unreachable: WebSessionStatus = { signedIn: false, required: true, connected: false, serverName: null, pageConnection: false };

export const webSession = {
  /** Unreachable hosts read as signed out. */
  async status(): Promise<WebSessionStatus> {
    const { result } = await request<Partial<WebSessionStatus>>('/api/session', { method: 'GET' });
    const value = result.ok ? result.value : undefined;
    return value && typeof value.signedIn === 'boolean' && typeof value.required === 'boolean' ? {
      signedIn: value.signedIn, required: value.required, connected: value.connected === true,
      serverName: typeof value.serverName === 'string' ? value.serverName : null, pageConnection: value.pageConnection === true,
    } : unreachable;
  },
  /** Sends the login to this page's host once. The host keeps it in memory; the page keeps nothing. */
  async connect(connection: Connection): Promise<Result<{ serverName: string }>> {
    const { status, result } = await request<{ serverName: string }>('/api/connect', post(connection));
    if (status === 401) notifySignedOut();
    return result.ok && typeof result.value?.serverName !== 'string' ? { ok: false, error: 'The preview server returned an unexpected response.' } : result;
  },
  async disconnect(): Promise<Result> {
    const { status, result } = await request<void>('/api/disconnect', post({}));
    if (status === 401) notifySignedOut();
    return result;
  },
  async signIn(password: string): Promise<Result> {
    return (await request<void>('/api/session', post({ password }))).result;
  },
  async signOut(): Promise<Result> {
    const { result } = await request<void>('/api/session', { method: 'DELETE' });
    if (result.ok) notifySignedOut();
    return result;
  },
};

export const previewLibrary: LibraryApi = {
  albums: (type, offset, size, years) => call('albums', years ? [type, offset, size, years] : [type, offset, size]),
  album: id => call('album', [id]),
  artists: () => call('artists', []),
  artist: id => call('artist', [id]),
  playlists: () => call('playlists', []),
  playlist: id => call('playlist', [id]),
  genres: () => call('genres', []),
  starred: () => call('starred', []),
  randomSongs: options => call('randomSongs', [options]),
  tracks: (sort, offset, size, seed) => call('tracks', [sort, offset, size, seed]),
  search: (query, options) => call('search', options ? [query, options] : [query]),
  star: (target, id, starred) => call('star', [target, id, starred]),
  createPlaylist: (name, trackIds) => call('createPlaylist', [name, trackIds]),
  addToPlaylist: (playlistId, trackIds) => call('addToPlaylist', [playlistId, trackIds]),
  updatePlaylist: (playlistId, changes) => call('updatePlaylist', [playlistId, changes]),
  removeFromPlaylist: (playlistId, indexes) => call('removeFromPlaylist', [playlistId, indexes]),
  reorderPlaylist: (playlistId, trackIds) => call('reorderPlaylist', [playlistId, trackIds]),
  deletePlaylist: playlistId => call('deletePlaylist', [playlistId]),
  similarSongs: (id, count) => call('similarSongs', [id, count]),
  topSongs: (artistId, count) => call('topSongs', [artistId, count]),
  // The lookup setting lives in the browser; the dev server only contacts LRCLIB when it is true.
  lyrics: (track, lookup) => call('lyrics', [{ id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration }, lookup]),
  reportPlay: (trackId, event) => call('reportPlay', [trackId, event]),
  savedQueue: () => call('savedQueue', []),
  saveQueue: (trackIds, currentIndex, positionSeconds) => call('saveQueue', [trackIds, currentIndex, positionSeconds]),
  rate: (target, id, rating) => call('rate', [target, id, rating]),
  coverUrl: (coverArt, size) => `/api/cover?id=${encodeURIComponent(coverArt)}&size=${Math.round(size)}`,
  artistInfo: artistId => call('artistInfo', [artistId]),
  songsByGenre: (genre, offset, size) => call('songsByGenre', [genre, offset, size]),
  nowPlaying: () => call('nowPlaying', []),
  createShare: (ids, description, expiresAt) => call('createShare', [ids, description ?? null, expiresAt ?? null]),
  shares: () => call('shares', []),
  deleteShare: id => call('deleteShare', [id]),
  radioStations: () => call('radioStations', []),
};
