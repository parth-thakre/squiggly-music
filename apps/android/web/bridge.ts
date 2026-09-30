import { Effect, Either, Schema } from 'effect';
import type { AndroidBridge, AndroidPlayback, AndroidQueueSnapshot, AndroidSession, ConnectOutcome, Connection, LibraryApi, Result, Track } from '../../../packages/core/contracts';
import { ONLINE } from '../../../packages/core/contracts';
import { Metrics } from '../../../packages/core/metrics';
import { ConnectionSchema, SaveM3uSchema } from '../../../packages/core/validation';
import { buildM3u, m3uFileName } from '../../../packages/core/m3u';
import { isStation, stationIdOf } from '../../../packages/core/stations';
import { keyOf } from '../../../packages/core/kept';
import { LAUNCH_WAIT, OUT_OF_REACH, PROBE_TIMEOUT, Reach, type ProbeOutcome } from '../../../packages/core/reach';
import { SubsonicClient, libraryCall, reachOf, resolveServerAddress, Unreachable, type LibraryMethod } from '../../../packages/adapter-opensubsonic/client';
import { createKept } from './kept';
import { createPlays } from './plays';
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
let session: AndroidSession = { ready: false, connected: false, serverName: null, sessionId: null, account: null, signIn: { saved: null, canRemember: false, reconnecting: false, reconnectError: null }, reach: ONLINE, queuedPlays: 0 };
const sessionListeners = new Set<(session: AndroidSession) => void>();
function setSession(patch: Partial<AndroidSession>, signIn: Partial<AndroidSession['signIn']> = {}) {
  session = { ...session, ...patch, signIn: { ...session.signIn, ...signIn } };
  for (const listener of [...sessionListeners]) listener(session);
}
// The saved account, for reconnecting after a failed attempt at launch without retyping.
let savedAccount: Connection | null = null;
// A session opened at launch with the server unreachable: the client never pinged, so its
// extension discovery can't be trusted. Probes use a fresh client until one answers.
let unverified: Connection | null = null;
let answered: SubsonicClient | null = null;
const hostName = (candidate: SubsonicClient, name?: string) => {
  // A plain HTTP server is named with its scheme, since nothing sent to it is encrypted.
  const address = new URL(candidate.baseUrl);
  const where = `${address.protocol === 'http:' ? 'http://' : ''}${address.host}`;
  return name ? `${name} (${where})` : where;
};
// The cover proxy's name for the account (CoverProxy.kt keeps its own).
const coverKey = (candidate: SubsonicClient, username: string) => `${candidate.baseUrl}\n${username}`;
const withTimeout = <A, L>(task: Promise<A>, ms: number, late: L): Promise<A | L> => Promise.race([task, new Promise<L>(resolve => setTimeout(() => resolve(late), ms))]);

// Whether the server answers (packages/core/reach.ts), as the desktop's main process does.
const reach = new Reach({
  async probe(): Promise<ProbeOutcome> {
    const probing = unverified ? makeClient(unverified) : client;
    if (!probing) return { kind: 'refused', error: 'Connect to your server first.' };
    const result = await withTimeout(Effect.runPromise(Effect.either(probing.ping())), PROBE_TIMEOUT, 'late' as const);
    if (result === 'late') return { kind: 'unreachable' };
    if (Either.isRight(result)) { answered = probing; return { kind: 'answered', name: result.right.name }; }
    return reachOf(result.left) === 'unreachable' ? { kind: 'unreachable' } : { kind: 'refused', error: message(result.left, 'The server refused.') };
  },
  changed: state => { setSession({ reach: state }); if (!state.away && !state.checking) void Squiggly.keptResume().catch(() => undefined); },
  returned: outcome => {
    if (unverified && answered && client) {
      client = answered; unverified = null;
      void Squiggly.setServer({ coverBase: answered.coverArtBase(), key: coverKey(answered, savedAccount?.username ?? '') }).catch(() => undefined);
      setSession({ serverName: hostName(answered, outcome.kind === 'answered' ? outcome.name : undefined) });
    }
    void plays.flush();
    void Squiggly.keptResume().catch(() => undefined);
  },
  // Answered, but refused, while unverified (the password changed, say): the connect screen with
  // the reason. Kept songs stay; the account is the same.
  refused: error => {
    if (!unverified) return;
    unverified = null; client = null; generation++;
    reach.leave();
    setSession({ connected: false, serverName: null, sessionId: null, account: null }, { reconnecting: false, reconnectError: error });
  },
});
const away = () => reach.state.away;
const plays = createPlays({ client: () => client, away, failed: () => reach.failed(), changed: count => setSession({ queuedPlays: count }) });
session = { ...session, queuedPlays: plays.size };

async function connectTo(typed: Connection, { save }: { save: boolean }): Promise<Result<ConnectOutcome>> {
  const mine = ++generation;
  const attempt = await Effect.runPromise(Effect.either(Effect.gen(function* () {
    const address = yield* resolveServerAddress(typed, makeClient);
    // Only plain HTTP answered: nothing is signed in until the person agrees (App.tsx's Connect).
    if (address.type === 'plain-http') return address;
    const { connection } = address;
    const candidate = yield* Effect.try({ try: () => makeClient(connection), catch: error => error instanceof Error ? error : new Error('Check the server address.') });
    const info = yield* candidate.ping();
    return { type: 'ready' as const, connection, candidate, info };
  })));
  if (mine !== generation) return { ok: false, error: 'Connection canceled.' };
  if (Either.isLeft(attempt)) return { ok: false, error: message(attempt.left, 'Could not connect.') };
  if (attempt.right.type === 'plain-http') return { ok: true, value: attempt.right };
  const { connection, candidate, info } = attempt.right;
  client = candidate; unverified = null;
  reach.leave();
  await Squiggly.setServer({ coverBase: candidate.coverArtBase(), key: coverKey(candidate, connection.username) }).catch(() => undefined);
  // Kept songs belong to one account: another one forgets them, and plays waiting to be reported.
  const key = keyOf(candidate.baseUrl, connection.username);
  await Squiggly.keptBind({ key }).catch(() => undefined);
  plays.bind(key);
  void plays.flush();
  // A disconnect while the server or kept songs were being set up has already forgotten the
  // sign-in and cleared the session, so this one mustn't save itself back or reopen.
  if (mine !== generation) return { ok: false, error: 'Connection canceled.' };
  let { canRemember } = session.signIn;
  if (save && canRemember) {
    const saved = await Squiggly.saveAccount(connection).then(result => result.saved, () => false);
    // The Keystore refused: this sign-in lasts for the session, and the screen says so next time.
    if (saved) savedAccount = connection; else { canRemember = false; savedAccount = null; }
  }
  setSession({
    connected: true, sessionId: crypto.randomUUID(), account: `${candidate.baseUrl}\n${connection.username}`,
    serverName: hostName(candidate, info.name),
  }, { canRemember, saved: savedAccount && { url: savedAccount.url, username: savedAccount.username }, reconnecting: false, reconnectError: null });
  return { ok: true, value: { type: 'connected' } };
}

async function reconnect(): Promise<Result> {
  if (!savedAccount) return { ok: false, error: 'There is no saved sign-in.' };
  setSession({}, { reconnecting: true, reconnectError: null });
  // With songs kept for this account, the server gets four seconds; no answer opens the app away.
  const kept = await reconnectKept(savedAccount);
  if (kept) return kept;
  const result = await connectTo(savedAccount, { save: false });
  if (!result.ok && !session.connected) setSession({}, { reconnecting: false, reconnectError: result.error });
  // A saved address has its scheme written out, so it's never offered as plain HTTP again.
  return result.ok ? { ok: true, value: undefined } : result;
}

async function reconnectKept(saved: Connection): Promise<Result | null> {
  let candidate: SubsonicClient;
  try { candidate = makeClient(saved); } catch { return null; }
  const key = keyOf(candidate.baseUrl, saved.username);
  const state = await Squiggly.keptState().catch(() => null);
  if (!state || state.account !== key || state.songs <= 0) return null;
  const mine = ++generation;
  const outcome = await withTimeout(Effect.runPromise(Effect.either(candidate.ping())), LAUNCH_WAIT, 'late' as const);
  if (mine !== generation) return { ok: false, error: 'Connection canceled.' };
  // Answered, or refused: the usual sign-in, which says why when it fails.
  if (outcome !== 'late' && (Either.isRight(outcome) || reachOf(outcome.left) === 'refused')) return null;
  client = candidate; unverified = saved;
  await Squiggly.setServer({ coverBase: candidate.coverArtBase(), key: coverKey(candidate, saved.username) }).catch(() => undefined);
  plays.bind(key);
  setSession({ connected: true, sessionId: crypto.randomUUID(), account: `${candidate.baseUrl}\n${saved.username}`, serverName: hostName(candidate) }, { reconnecting: false, reconnectError: null });
  reach.enter({ probeNow: outcome === 'late' });
  return { ok: true, value: undefined };
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
  // Away: answered at once, without the server, until a probe finds it again.
  if (away()) return { ok: false, error: OUT_OF_REACH, unreachable: true };
  const result = await Effect.runPromise(Effect.either(libraryCall(current, method, args)));
  // An answer from an account that has since been replaced must not reach the page.
  if (current !== client) return { ok: false, error: 'Server session changed. Try again.' };
  if (Either.isRight(result)) return { ok: true, value: result.right.value as T };
  const error = message(result.left, 'The request failed.');
  if (result.left instanceof Unreachable) { reach.failed(); return { ok: false, error, unreachable: true }; }
  return { ok: false, error };
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
  // Through PlayReports: a finished play waits while the server is out of reach.
  reportPlay: async (trackId, event) => { await plays.report(trackId, event); return { ok: true, value: undefined }; },
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
  // A station plays its own stream, from the station list this client read (sync reads it first
  // when it hasn't); it has no MP3 to fall back to. One the server no longer lists gets no
  // address, and the player says it failed.
  const station = track.source === 'station' ? current.knownStationLocation(stationIdOf(track)) ?? '' : null;
  return {
    id, trackId: track.id, url: station ?? current.streamLocation(track.id), fallbackUrl: station ?? current.streamLocation(track.id, 'mp3'),
    title: track.title, artist: track.artist, album: track.album, coverArt: track.coverArt ?? null, duration: track.duration,
    track: JSON.stringify(track), live: station !== null,
  };
}
let latest: { queue: readonly Track[]; entryIds: readonly string[] } = { queue: [], entryIds: [] };
// A station this client hasn't listed has no address yet: after a relaunch the page restores the
// queue before anything reads the station list. The list is read first, and the native queue,
// with the commands that name its entries, waits for it. The sync after the list (listedBy, the
// client that read it) sends what it has, so a station the server no longer lists, or a list
// that failed, can't hold the queue up.
let lookup: Promise<void> | null = null;
function sync(queue: readonly Track[], entryIds: readonly string[], listedBy: SubsonicClient | null = null) {
  latest = { queue, entryIds };
  if (lookup) return;
  const ops = planQueue(mirrored, entryIds);
  if (!ops.length) return;
  const current = client;
  const adds = ops.some(op => op.type === 'insert' || (op.type === 'replace' && op.ids.length));
  // Without an account there are no stream addresses; the next sync after connecting sends these.
  if (adds && !current) return;
  const byId = new Map(entryIds.map((id, i) => [id, queue[i]]));
  const unlisted = current && listedBy !== current && ops.some(op => (op.type === 'replace' || op.type === 'insert')
    && op.ids.some(id => isStation(byId.get(id)) && current.knownStationLocation(stationIdOf(byId.get(id)!)) === null));
  if (unlisted) {
    lookup = Effect.runPromise(Effect.either(current.radioStations())).then(() => { lookup = null; sync(latest.queue, latest.entryIds, current); });
    return;
  }
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
// Commands naming an entry the native queue may not hold yet.
const afterLookup = (run: () => void) => { if (lookup) void lookup.then(run); else run(); };
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

async function clearPlayer() {
  mirrored = [];
  latest = { queue: [], entryIds: [] };
  await Squiggly.edit({ ops: [{ type: 'replace', items: [] }], seq: ++seq }).catch(() => undefined);
  for (const listener of [...resetListeners]) listener();
}

function playback(native: NativePlayback): AndroidPlayback {
  const { entryId, playId, playing, buffering, ended, position, duration, fallback, error } = native;
  return { entryId, playId, playing, buffering, ended, position, duration, fallback, error, stationTitle: native.stationTitle ?? null, local: native.local === true };
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
  kept: createKept({ client: () => client, away, unreachable: () => reach.failed() }),
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
    // Retry while away: the probe, at once (passive: skipped when one was just made).
    async retry(passive = false) {
      const outcome = await reach.retry(passive);
      return outcome?.kind === 'answered' || !away() ? { ok: true, value: undefined } : { ok: false, error: OUT_OF_REACH, unreachable: true };
    },
    async disconnect() {
      generation++;
      reach.leave(); unverified = null;
      await clearPlayer();
      // Nothing on the connect screen can reach kept songs, so they go with the sign-in, and so do
      // plays waiting to be reported.
      await Squiggly.keptForgetAll().catch(() => undefined);
      plays.clear();
      client = null; savedAccount = null;
      await Squiggly.setServer({ coverBase: null, key: null }).catch(() => undefined);
      await Squiggly.forgetAccount().catch(() => undefined);
      setSession({ connected: false, serverName: null, sessionId: null, account: null }, { saved: null, reconnecting: false, reconnectError: null });
      return { ok: true, value: undefined };
    },
  },
  player: {
    restore,
    sync: (queue, entryIds) => sync(queue, entryIds),
    load(entryId, { play, position }) {
      const send = () => void Squiggly.load({ id: entryId, position, play, seq: ++seq });
      // Waiting on a station lookup: reports from before this load are dropped from now on, and it
      // goes after the queue edit it follows, with a later number than that edit's.
      if (lookup) { ++seq; void lookup.then(send); } else send();
    },
    play() { void Squiggly.play(); },
    pause() { void Squiggly.pause(); },
    seek(entryId, seconds) { afterLookup(() => void Squiggly.seek({ id: entryId, position: seconds })); },
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
