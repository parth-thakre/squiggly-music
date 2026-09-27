import type { LibraryApi, Result } from '../../../../../packages/core/contracts';

// Browser build only: the host runs the real OpenSubsonic connector with credentials from
// its environment. See scripts/navidrome-preview.ts for the /api contract.
// Every /api route needs the session cookie once the host sets a password. The cookie is
// HttpOnly and same-origin, so <audio src="/api/stream..."> and <img src="/api/cover..."> carry it
// without any custom headers.
const signedOutListeners = new Set<() => void>();
const notifySignedOut = () => { for (const listener of [...signedOutListeners]) listener(); };

/** Called when the host rejects a library call for want of a session, and after signOut(). */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => { signedOutListeners.delete(listener); };
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
  return result;
}

export const webSession = {
  /** required: the host has a password. signedIn: library calls will be accepted. Unreachable hosts read as signed out. */
  async status(): Promise<{ signedIn: boolean; required: boolean }> {
    const { result } = await request<{ signedIn: boolean; required: boolean }>('/api/session', { method: 'GET' });
    return result.ok && typeof result.value?.signedIn === 'boolean' && typeof result.value.required === 'boolean'
      ? { signedIn: result.value.signedIn, required: result.value.required }
      : { signedIn: false, required: true };
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
  albums: (type, offset, size) => call('albums', [type, offset, size]),
  album: id => call('album', [id]),
  artists: () => call('artists', []),
  artist: id => call('artist', [id]),
  playlists: () => call('playlists', []),
  playlist: id => call('playlist', [id]),
  genres: () => call('genres', []),
  starred: () => call('starred', []),
  randomSongs: options => call('randomSongs', [options]),
  search: query => call('search', [query]),
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
  coverUrl: (coverArt, size) => `/api/cover?id=${encodeURIComponent(coverArt)}&size=${Math.round(size)}`,
};
