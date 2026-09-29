import { Effect, Either, Schema } from 'effect';
import type { AndroidBridge, AndroidPlayback, AndroidQueueSnapshot, AndroidSession, Connection, LibraryApi, Result, Track } from '../../../packages/core/contracts';
import { Metrics } from '../../../packages/core/metrics';
import { ConnectionSchema, SaveM3uSchema } from '../../../packages/core/validation';
import { buildM3u, m3uFileName } from '../../../packages/core/m3u';
import { SubsonicClient, libraryCall, resolveServerAddress, type LibraryMethod } from '../../../packages/adapter-opensubsonic/client';
import { nativeFetch } from './http';
import { Squiggly, type NativeItem, type NativeOp, type NativePlayback } from './plugin';
import { planQueue } from './queue';

// window.squigglyAndroid: what the desktop's main process does for its window, done in the page.
// The OpenSubsonic connector runs here with a native fetch, the sign-in is kept encrypted by the
// Android Keystore, and the native player gets the queue as stream addresses. Components still
// see only /api/cover URLs, which the native side answers (CoverProxy.kt), never credentials.

const metrics = new Metrics();
const makeClient = (connection: Connection) => new SubsonicClient(connection, metrics, { fetch: nativeFetch }, { fetch: nativeFetch });
const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

// Session ----------------------------------------------------------------------------------
let client: SubsonicClient | null = null;
// Bumped by every connect and disconnect, so an older attempt that finishes late is dropped.
let generation = 0;
let session: AndroidSession = { ready: false, connected: false, serverName: null, sessionId: null, account: null, signIn: { saved: null, canRemember: false, reconnecting: false, reconnectError: null } };
const sessionListeners = new Set<(session: AndroidSession) => void>();
function setSession(patch: Partial<AndroidSession>, signIn: Partial<AndroidSession['signIn']> = {}) {
  session = { ...session, ...patch, signIn: { ...session.signIn, ...signIn } };
  for (const listener of [...sessionListeners]) listener(session);
}
// The saved account, for reconnecting after a failed attempt at launch without retyping.
let savedAccount: Connection | null = null;

async function connectTo(typed: Connection, { save }: { save: boolean }): Promise<Result> {
  const mine = ++generation;
  const attempt = await Effect.runPromise(Effect.either(Effect.gen(function* () {
    const connection = yield* resolveServerAddress(typed, makeClient);
    const candidate = yield* Effect.try({ try: () => makeClient(connection), catch: error => error instanceof Error ? error : new Error('Check the server address.') });
    const info = yield* candidate.ping();
    return { connection, candidate, info };
  })));
  if (mine !== generation) return { ok: false, error: 'Connection canceled.' };
  if (Either.isLeft(attempt)) return { ok: false, error: message(attempt.left, 'Could not connect.') };
  const { connection, candidate, info } = attempt.right;
  client = candidate;
  await Squiggly.setServer({ coverBase: candidate.coverArtBase(), key: `${candidate.baseUrl}\n${connection.username}` }).catch(() => undefined);
  let { canRemember } = session.signIn;
  if (save && canRemember) {
    const saved = await Squiggly.saveAccount(connection).then(result => result.saved, () => false);
    // The Keystore refused: this sign-in lasts for the session, and the screen says so next time.
    if (saved) savedAccount = connection; else { canRemember = false; savedAccount = null; }
  }
  const address = new URL(candidate.baseUrl);
  setSession({
    connected: true, sessionId: crypto.randomUUID(), account: `${candidate.baseUrl}\n${connection.username}`,
    // A plain HTTP server is named with its scheme, since nothing sent to it is encrypted.
    serverName: `${info.name} (${address.protocol === 'http:' ? 'http://' : ''}${address.host})`,
  }, { canRemember, saved: savedAccount && { url: savedAccount.url, username: savedAccount.username }, reconnecting: false, reconnectError: null });
  return { ok: true, value: undefined };
}

async function reconnect(): Promise<Result> {
  if (!savedAccount) return { ok: false, error: 'There is no saved sign-in.' };
  setSession({}, { reconnecting: true, reconnectError: null });
  const result = await connectTo(savedAccount, { save: false });
  if (!result.ok && !session.connected) setSession({}, { reconnecting: false, reconnectError: result.error });
  return result;
}

async function start() {
  const stored = await Squiggly.loadAccount().catch(() => ({ canRemember: false, account: null }));
  const account = stored.account && Schema.decodeUnknownOption(ConnectionSchema)(stored.account);
  savedAccount = account && account._tag === 'Some' ? account.value : null;
  setSession({ ready: true }, { canRemember: stored.canRemember, reconnecting: !!savedAccount, saved: savedAccount && { url: savedAccount.url, username: savedAccount.username } });
  if (savedAccount) await reconnect();
}

// Library ----------------------------------------------------------------------------------
async function call<T>(method: LibraryMethod, args: unknown[]): Promise<Result<T>> {
  const current = client;
  if (!current) return { ok: false, error: 'Connect to your server first.' };
  const result = await Effect.runPromise(Effect.either(libraryCall(current, method, args)));
  // An answer from an account that has since been replaced must not reach the page.
  if (current !== client) return { ok: false, error: 'Server session changed. Try again.' };
  return Either.isRight(result) ? { ok: true, value: result.right.value as T } : { ok: false, error: message(result.left, 'The request failed.') };
}
const library: LibraryApi = {
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
  lyrics: (track, lookup) => call('lyrics', [{ id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration }, lookup]),
  reportPlay: (trackId, event) => call('reportPlay', [trackId, event]),
  savedQueue: () => call('savedQueue', []),
  saveQueue: (trackIds, currentIndex, positionSeconds) => call('saveQueue', [trackIds, currentIndex, positionSeconds]),
  rate: (target, id, rating) => call('rate', [target, id, rating]),
  // Same address as the browser build; the native side fetches it with the account's credentials.
  coverUrl: (coverArt, size) => `/api/cover?id=${encodeURIComponent(coverArt)}&size=${Math.round(size)}`,
  artistInfo: artistId => call('artistInfo', [artistId]),
  songsByGenre: (genre, offset, size) => call('songsByGenre', [genre, offset, size]),
  nowPlaying: () => call('nowPlaying', []),
  createShare: (ids, description, expiresAt) => call('createShare', [ids, description ?? null, expiresAt ?? null]),
  shares: () => call('shares', []),
  deleteShare: id => call('deleteShare', [id]),
  radioStations: () => call('radioStations', []),
};

// Player -----------------------------------------------------------------------------------
// Commands that change which entry is loaded carry a sequence number. The native player
// reports the last one it carried out, so reports sent before it caught up are dropped.
let seq = 0;
// The entries the native queue holds, as far as the page knows.
let mirrored: string[] = [];
let edits = 0;
const playbackListeners = new Set<(playback: AndroidPlayback) => void>();
const resetListeners = new Set<() => void>();

function item(track: Track, id: string, current: SubsonicClient): NativeItem {
  // A station plays its own stream, from the station list the page read through this client; it
  // has no MP3 to fall back to. (An unknown one gets no address, and the player says it failed.)
  const station = track.source === 'station' ? current.knownStationLocation(track.id) ?? '' : null;
  return {
    id, url: station ?? current.streamLocation(track.id), fallbackUrl: station ?? current.streamLocation(track.id, 'mp3'),
    title: track.title, artist: track.artist, album: track.album, coverArt: track.coverArt ?? null, duration: track.duration,
    track: JSON.stringify(track), live: station !== null,
  };
}
let latest: { queue: readonly Track[]; entryIds: readonly string[] } = { queue: [], entryIds: [] };
function sync(queue: readonly Track[], entryIds: readonly string[]) {
  latest = { queue, entryIds };
  const ops = planQueue(mirrored, entryIds);
  if (!ops.length) return;
  const current = client;
  const adds = ops.some(op => op.type === 'insert' || (op.type === 'replace' && op.ids.length));
  // Without an account there are no stream addresses; the next sync after connecting sends these.
  if (adds && !current) return;
  const byId = new Map(entryIds.map((id, i) => [id, queue[i]]));
  const native = ops.map((op): NativeOp => op.type === 'replace' ? { type: 'replace', items: op.ids.map(id => item(byId.get(id)!, id, current!)) }
    : op.type === 'insert' ? { type: 'insert', at: op.at, items: op.ids.map(id => item(byId.get(id)!, id, current!)) } : op);
  mirrored = [...entryIds];
  const mine = ++edits;
  // A replaced queue unloads the entry that was playing, which older reports still name.
  const replacing = ops.some(op => op.type === 'replace');
  void Squiggly.edit({ ops: native, seq: replacing ? ++seq : seq }).then(({ ids }) => {
    // The native queue should now be the page's. If it isn't, plan again from what it holds.
    if (mine === edits && !same(ids, mirrored)) { mirrored = ids; sync(latest.queue, latest.entryIds); }
  }, () => { if (mine === edits) void Squiggly.restore().then(({ items }) => { mirrored = items.map(entry => entry.id); sync(latest.queue, latest.entryIds); }); });
}
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

async function clearPlayer() {
  mirrored = [];
  latest = { queue: [], entryIds: [] };
  await Squiggly.edit({ ops: [{ type: 'replace', items: [] }], seq: ++seq }).catch(() => undefined);
  for (const listener of [...resetListeners]) listener();
}

function playback(native: NativePlayback): AndroidPlayback {
  const { entryId, playId, playing, buffering, ended, position, duration, fallback, error } = native;
  return { entryId, playId, playing, buffering, ended, position, duration, fallback, error, stationTitle: native.stationTitle ?? null };
}
void Squiggly.addListener('playback', native => {
  if (native.seq < seq) return;
  const state = playback(native);
  for (const listener of [...playbackListeners]) listener(state);
});

async function restore(): Promise<AndroidQueueSnapshot | null> {
  const held = await Squiggly.restore().catch(() => null);
  if (!held) return null;
  seq = Math.max(seq, held.playback.seq);
  const queue: Track[] = [], entryIds: string[] = [];
  for (const entry of held.items) {
    try { queue.push(JSON.parse(entry.track) as Track); entryIds.push(entry.id); } catch { /* skipped; the next sync removes it */ }
  }
  mirrored = held.items.map(entry => entry.id);
  const index = held.playback.entryId ? entryIds.indexOf(held.playback.entryId) : -1;
  if (!queue.length || index < 0) return null;
  return { queue, entryIds, index, playback: playback(held.playback) };
}

// Files -------------------------------------------------------------------------------------
// A playlist file goes through the system's document picker: the WebView ignores a download.
// Checked here as the desktop's main process checks it; the native side bounds it again
// (SquigglyPlugin.kt's MAX_SAVE_CHARS).
const MAX_SAVE_CHARS = 8 * 1024 * 1024;
async function saveM3u(name: unknown, entries: unknown): Promise<Result> {
  const decoded = Schema.decodeUnknownEither(SaveM3uSchema)([name, entries]);
  if (Either.isLeft(decoded)) return { ok: false, error: 'Invalid playlist file.' };
  const [title, songs] = decoded.right;
  const text = buildM3u(songs, title);
  if (text.length > MAX_SAVE_CHARS) return { ok: false, error: 'The playlist file is too large to save.' };
  try {
    await Squiggly.saveFile({ name: m3uFileName(title), mimeType: 'audio/x-mpegurl', text });
    return { ok: true, value: undefined };
  } catch (error) { return { ok: false, error: message(error, 'Could not save the playlist file.') }; }
}

export const androidBridge: AndroidBridge = {
  saveM3u,
  library,
  session: {
    get: () => session,
    subscribe(listener) { sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; },
    async connect(input) {
      const decoded = Schema.decodeUnknownEither(ConnectionSchema)(input);
      if (Either.isLeft(decoded)) return { ok: false, error: 'Enter your server\'s address, your username, and your password.' };
      // A new sign-in replaces whatever the last one left playing.
      await clearPlayer();
      return connectTo(decoded.right, { save: true });
    },
    reconnect,
    async disconnect() {
      generation++;
      await clearPlayer();
      client = null; savedAccount = null;
      await Squiggly.setServer({ coverBase: null, key: null }).catch(() => undefined);
      await Squiggly.forgetAccount().catch(() => undefined);
      setSession({ connected: false, serverName: null, sessionId: null, account: null }, { saved: null, reconnecting: false, reconnectError: null });
      return { ok: true, value: undefined };
    },
  },
  player: {
    restore,
    sync,
    load(entryId, { play, position }) { void Squiggly.load({ id: entryId, position, play, seq: ++seq }); },
    play() { void Squiggly.play(); },
    pause() { void Squiggly.pause(); },
    seek(entryId, seconds) { void Squiggly.seek({ id: entryId, position: seconds }); },
    volume(percent) { void Squiggly.volume({ volume: percent / 100 }); },
    subscribe(listener) { playbackListeners.add(listener); return () => { playbackListeners.delete(listener); }; },
    onReset(listener) { resetListeners.add(listener); return () => { resetListeners.delete(listener); }; },
    // Page to native only: a mode changed outside the page (a MediaController) isn't observed.
    repeat(mode) { void Squiggly.repeat({ mode }); },
    sleepAt(at) { void Squiggly.sleepAt({ at: at === null ? null : Math.round(at) }); },
    sleepAfterPlay(playId) { void Squiggly.sleepAfterPlay({ playId }); },
  },
};

void start();
