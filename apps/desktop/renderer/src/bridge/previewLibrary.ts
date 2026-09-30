import type { Connection, LibraryApi, Reachability, Result } from '../../../../../packages/core/contracts';
import { OUT_OF_REACH, PROBE_TIMEOUT, Reach, type ProbeOutcome } from '../../../../../packages/core/reach';

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

type Fetch = typeof globalThis.fetch;
async function requestWith<T>(fetcher: Fetch, path: string, init: RequestInit): Promise<{ status: number; result: Result<T> }> {
  try {
    const response = await fetcher(path, { credentials: 'same-origin', ...init });
    const body: unknown = await response.json().catch(() => null);
    // Void results serialize without a value key; a failure may say the server gave no answer.
    if (body && typeof body === 'object' && 'ok' in body && (body.ok === true || (body.ok === false && 'error' in body && typeof body.error === 'string'))) {
      const result = body as Result<T> & { unreachable?: unknown };
      return { status: response.status, result: result.ok ? result : { ok: false, error: result.error, ...(result.unreachable === true ? { unreachable: true } : {}) } };
    }
    return { status: response.status, result: { ok: false, error: 'The preview server returned an unexpected response.' } };
  } catch { return { status: 0, result: { ok: false, error: 'Could not reach the preview server.' } }; }
}
const request = <T,>(path: string, init: RequestInit) => requestWith<T>((...args) => fetch(...args), path, init);
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Library calls and whether the server answers them. A call the host says got no answer asks the
// reach machine to check (one confirming probe); once the server is away, calls are answered here
// at once, without the host, until a probe gets an answer. The host itself being gone (status 0)
// is the sign-in flow's business, not this. Built from a fetch so tests can give their own.
export function createWebLibrary(fetcher: Fetch, options: { timers?: ConstructorParameters<typeof Reach>[0]['timers']; now?: () => number } = {}) {
  const listeners = new Set<(state: Reachability) => void>();
  const timers = options.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  // The confirming probe, 8 seconds at most from the request to the end of its body. A host or
  // connection that stops answering is no answer; the request is let go.
  const probe = async (): Promise<ProbeOutcome> => {
    const controller = new AbortController();
    let timer: unknown = null;
    const late = new Promise<ProbeOutcome>(resolve => { timer = timers.set(() => { controller.abort(); resolve({ kind: 'unreachable' }); }, PROBE_TIMEOUT); });
    const asked = requestWith<unknown>(fetcher, '/api/albums', { ...post(['newest', 0, 1]), signal: controller.signal }).then(({ status, result }): ProbeOutcome =>
      status === 0 || (!result.ok && result.unreachable) ? { kind: 'unreachable' } : { kind: 'answered' });
    try { return await Promise.race([asked, late]); } finally { timers.clear(timer); }
  };
  const reach = new Reach({ probe, changed: state => listeners.forEach(listener => listener(state)), ...options });
  async function call<T>(method: string, args: unknown[]): Promise<Result<T>> {
    if (reach.state.away) return { ok: false, error: OUT_OF_REACH, unreachable: true };
    const { status, result } = await requestWith<T>(fetcher, `/api/${method}`, post(args));
    if (status === 401) notifySignedOut();
    else if (status === 503 && !result.ok && result.error === notConnected) notifyDisconnected();
    else if (!result.ok && result.unreachable) reach.failed();
    return result;
  }
  const webReach = {
    get: () => reach.state,
    subscribe(listener: (state: Reachability) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retry: (passive = false) => reach.retry(passive),
    leave: () => reach.leave(),
  };
  return { call, webReach };
}
const web = createWebLibrary((...args) => fetch(...args));
const call = web.call;
/** Whether this page's server answers. The page subscribes to show the notice and stop asking. */
export const webReach = web.webReach;

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
