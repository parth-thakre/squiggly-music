import { useSyncExternalStore } from 'react';
import type { AndroidPlayback, AndroidSession, AppSnapshot, AudioDevice, AudioPath, ConnectOutcome, Connection, Diagnostics, Reachability, Result, SavedQueue, ServerState, Track, UpdateState } from '../../../../../packages/core/contracts';
import type { RepeatMode } from '../../../../../packages/core/contracts';
import { emptyDiagnostics, ONLINE } from '../../../../../packages/core/contracts';
import { KEPT_MESSAGES, keptOnly } from '../../../../../packages/core/kept';
import { OUT_OF_REACH } from '../../../../../packages/core/reach';
import { following, preceding, repeatModes, shuffleOrder } from '../../../../../packages/core/playOrder';
import { finishThreshold } from '../../../../../packages/core/plays';
import { isStation, repeatFor, stationIdOf } from '../../../../../packages/core/stations';
import { onDisconnected, onSignedOut, webReach, webSession, type WebSessionStatus } from '../bridge/previewLibrary';
import { isKept, keptSupported } from './keptState';
import { VolumeCommandCoalescer } from '../volumeCommands';
import { api, resetLibraryCaches } from './library';
import { clearSearches, searchesFor } from './searches';
import { getSettings } from './settings';

// One small store for playback. Views subscribe with selectors so the frequent position
// snapshots only re-render the deck, never the library.
export interface PlayerState {
  // desktop: libmpv in the audio host. web: the browser's own audio element, for phones.
  // android: the Android app, where a native Media3 player plays the queue the page keeps.
  mode: 'desktop' | 'web' | 'android';
  engine: 'starting' | 'ready' | 'unavailable' | 'crashed';
  connected: boolean; serverName: string | null;
  // Changes when the desktop connects to a server or account; library caches are dropped with it.
  sessionId: string | null;
  // Browser only: whether this host wants its password first. Always 'open' on the desktop;
  // on Android, 'checking' until the saved sign-in has been read.
  access: 'checking' | 'sign-in' | 'signed-in' | 'open';
  // Browser only: the server is one this page connected to itself (not the host's configured
  // one), so the page can disconnect from it.
  pageConnection: boolean;
  // Browser only: the connect screen is open over the host's configured server, to connect this
  // page to another one instead.
  choosingServer: boolean;
  queue: Track[];
  // One id per queue entry, parallel to `queue`. Two copies of a song are two entries.
  entryIds: string[];
  // Changes whenever a song starts from the top (another entry, the same one again, a repeat-one
  // loop, a jump to the song playing), never on a seek: PlayerSnapshot.playId on the desktop, a
  // load in the browser, the native player's playId on Android. '' before anything has played.
  playId: string;
  index: number; playing: boolean; position: number; duration: number; buffering: boolean;
  volume: number; audio: AudioPath | null; devices: AudioDevice[]; device: string;
  // What was asked of the server for the current song. A request, not proof of what arrived.
  // 'device': the player opened the copy kept on this device instead.
  delivery: 'original-requested' | 'mp3-fallback' | 'device' | null;
  error: string | null; diagnostics: Diagnostics;
  // Radio keeps the queue topped up with songs like the last one.
  radio: { label: string } | null;
  // A station being put together (it can take several seconds on a slow server).
  radioStarting: string | null;
  // A queue saved on the server, offered once at startup when nothing is playing.
  resumable: SavedQueue | null;
  // Desktop and Android: the saved sign-in and reconnecting with it at launch.
  signIn: SignInState;
  // Desktop only: updates from GitHub releases. Null in the browser.
  update: UpdateState | null;
  // Queue modes. The desktop's audio host owns them; the browser and Android keep them here, in
  // local storage (MODES below).
  repeat: RepeatMode; shuffle: boolean;
  // An internet radio station playing: what its stream says is on (ICY), from mpv on the desktop
  // and ExoPlayer on Android. The browser can't read it, so it stays null there, as it does
  // whenever a station says nothing.
  stationTitle: string | null;
  // Whether the server answers. Away, the app shows what is kept and stops asking the server.
  reach: Reachability;
  // Finished plays waiting to be reported until the server is back (desktop and Android).
  queuedPlays: number;
}
export type SignInState = Pick<ServerState, 'saved' | 'canRemember' | 'reconnecting' | 'reconnectError'>;

// The most songs a queue holds, on both builds (QUEUE_LIMIT in packages/core/validation.ts).
// Kept here so the renderer doesn't bundle the schema library.
export const QUEUE_LIMIT = 1000;

const desktop = window.squiggly;
const android = desktop ? undefined : window.squigglyAndroid;
// The browser and Android keep the queue in the page; the desktop's main process keeps its own.
const local = !desktop;
// The browser's and Android's repeat and shuffle, kept like their settings (settings.ts).
const MODES = 'squiggly.playModes';
function storedModes(): Pick<PlayerState, 'repeat' | 'shuffle'> {
  try {
    const value = JSON.parse(localStorage.getItem(MODES) ?? '{}') as { repeat?: unknown; shuffle?: unknown };
    return { repeat: repeatModes.find(mode => mode === value.repeat) ?? 'off', shuffle: value.shuffle === true };
  } catch { return { repeat: 'off', shuffle: false }; }
}
const saveModes = () => { try { localStorage.setItem(MODES, JSON.stringify({ repeat: state.repeat, shuffle: state.shuffle })); } catch { /* Kept for this visit only. */ } };
let state: PlayerState = {
  mode: desktop ? 'desktop' : android ? 'android' : 'web', engine: desktop ? 'starting' : 'ready', connected: false, serverName: null,
  sessionId: null, access: desktop ? 'open' : 'checking', pageConnection: false, choosingServer: false,
  queue: [], entryIds: [], playId: '', index: -1, playing: false, position: 0, duration: 0, buffering: false, volume: 100, audio: null,
  devices: [{ name: 'auto', description: 'System default' }], device: 'auto', delivery: null, error: null, diagnostics: emptyDiagnostics(),
  radio: null, radioStarting: null, resumable: null,
  signIn: { saved: null, canRemember: false, reconnecting: false, reconnectError: null },
  update: null,
  ...(local ? storedModes() : { repeat: 'off', shuffle: false }),
  stationTitle: null,
  reach: ONLINE, queuedPlays: 0,
};
const listeners = new Set<() => void>();
// When the position last arrived, so livePosition() can count forward between reports.
let positionAt = performance.now();
const set = (patch: Partial<PlayerState>) => {
  const before = state;
  state = { ...state, ...patch };
  if ('position' in patch || state.playing !== before.playing) positionAt = performance.now();
  // The native player gets every change to the queue, before any command that names an entry.
  if (android && state.entryIds !== before.entryIds) android.player.sync(state.queue, state.entryIds);
  listeners.forEach(listener => listener());
  if (local && (state.index !== before.index || state.queue !== before.queue)) topUpRadio();
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getPlayer = () => state;
// For code outside components that follows the player, such as the sleep timer.
export const subscribePlayer = subscribe;
export function usePlayer<T>(select: (s: PlayerState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}
export const current = (s: PlayerState) => s.queue[s.index] as Track | undefined;
export const currentEntry = (s: PlayerState) => s.entryIds[s.index] as string | undefined;
// The position right now, not as of the last report. The browser asks its audio element; the
// desktop counts forward from the engine's last report (every 250 ms), at most one second ahead.
export function livePosition() {
  if (web && state.index >= 0 && Number.isFinite(web.active.currentTime)) return web.active.currentTime;
  if (!state.playing) return state.position;
  const ahead = Math.min((performance.now() - positionAt) / 1000, 1);
  return state.duration > 0 ? Math.min(state.duration, state.position + ahead) : state.position + ahead;
}

const report = (result: Result) => { if (!result.ok) set({ error: result.error }); return result; };
export const isAway = () => state.reach.away;
const sameReach = (a: Reachability, b: Reachability) => a.away === b.away && a.since === b.since && a.checking === b.checking && a.checkedAt === b.checkedAt;
// A song that can't play while the server is away says why.
const notKeptError = 'This song isn\'t kept on this device, and your server is out of reach.';
const awayError = (track: Track | undefined, fallback: string) =>
  state.reach.away && keptSupported && track?.source === 'navidrome' && !isKept(track.id) ? notKeptError : fallback;
const queueFull = (left: number) => left
  ? `The queue holds up to ${QUEUE_LIMIT.toLocaleString()} songs, so ${left.toLocaleString()} ${left === 1 ? 'song wasn\'t' : 'songs weren\'t'} added.`
  : `The queue holds up to ${QUEUE_LIMIT.toLocaleString()} songs. Remove some to add more.`;

// A list longer than the queue plays as a window of it that includes the chosen song. The
// window starts at that song (or ends with the list), and the index is translated, never
// clamped onto a different song.
export function queueWindow<T>(items: T[], start: number): { items: T[]; start: number } {
  if (items.length <= QUEUE_LIMIT) return { items, start };
  const from = Math.max(0, Math.min(start, items.length - QUEUE_LIMIT));
  return { items: items.slice(from, from + QUEUE_LIMIT), start: start - from };
}

// Desktop -------------------------------------------------------------------------------
// Snapshots arrive several times a second with fresh arrays. Unchanged parts keep their old
// references, so selectors (and everything rendered from them) only see real changes.
const sameTrack = (a: Track, b: Track) => a.id === b.id && a.title === b.title && a.artist === b.artist && a.album === b.album
  && a.duration === b.duration && a.coverArt === b.coverArt && a.starred === b.starred && a.sourceFormat === b.sourceFormat
  && a.sourceSampleRate === b.sourceSampleRate && a.sourceBitDepth === b.sourceBitDepth;
const sameList = <T,>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean) => a === b || (a.length === b.length && a.every((x, i) => same(x, b[i])));
// One level down too, for small objects inside (audio.sink arrives as a fresh copy every time).
const plainObject = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value);
function sameFields<T extends object>(a: T | null, b: T, nested = true): boolean {
  if (!a) return false;
  const keys = Object.keys(b) as (keyof T)[];
  return keys.length === Object.keys(a).length && keys.every(key => {
    const x = a[key], y = b[key];
    return x === y || (nested && plainObject(x) && plainObject(y) && sameFields(x, y, false));
  });
}

// The saved output's name, so Settings can still name it while it's unplugged. Kept across
// launches, since Squiggly may start without it.
const OUTPUT_NAME = 'squiggly.outputName';
let outputName: AudioDevice | null = (() => {
  try {
    const value = JSON.parse(localStorage.getItem(OUTPUT_NAME) ?? 'null') as Partial<AudioDevice> | null;
    return typeof value?.name === 'string' && typeof value.description === 'string' ? { name: value.name, description: value.description } : null;
  } catch { return null; }
})();
function rememberOutput(devices: readonly AudioDevice[]) {
  const saved = getSettings().outputDevice;
  const device = saved === 'auto' ? undefined : devices.find(d => d.name === saved);
  if (!device || (outputName?.name === device.name && outputName.description === device.description)) return;
  outputName = { name: device.name, description: device.description };
  try { localStorage.setItem(OUTPUT_NAME, JSON.stringify(outputName)); } catch { /* Kept for this visit only. */ }
}
export const outputDescription = (name: string) => outputName?.name === name ? outputName.description : null;

if (desktop) {
  // An engine error shows once; dismissing it keeps it dismissed until a different one arrives.
  // One the engine takes back goes here too (it clears its errors on the next command, and says
  // an output came back for a few seconds).
  let lastEngineError: string | null = null;
  const apply = (snapshot: AppSnapshot) => {
    const p = snapshot.player;
    const sessionId = snapshot.server.sessionId;
    // Another server or account: nothing cached from the last one may show.
    if (sessionId !== state.sessionId) resetLibraryCaches();
    searchesFor(snapshot.server.account ?? null);
    const error = p.error && p.error !== lastEngineError ? awayError(p.queue[p.currentIndex], p.error)
      : !p.error && lastEngineError && state.error === lastEngineError ? null : state.error;
    lastEngineError = p.error;
    const track = p.queue[p.currentIndex];
    rememberOutput(p.devices);
    const { saved, canRemember, reconnecting, reconnectError } = snapshot.server;
    const reach = snapshot.server.reach ?? ONLINE;
    const signIn = state.signIn.saved?.url === saved?.url && state.signIn.saved?.username === saved?.username && state.signIn.canRemember === canRemember
      && state.signIn.reconnecting === reconnecting && state.signIn.reconnectError === reconnectError ? state.signIn : { saved, canRemember, reconnecting, reconnectError };
    set({
      signIn,
      update: snapshot.update && sameFields(state.update, snapshot.update) ? state.update : snapshot.update ?? null,
      engine: p.engine, connected: snapshot.server.connected, serverName: snapshot.server.name, sessionId,
      queue: sameList(state.queue, p.queue, sameTrack) ? state.queue : p.queue,
      entryIds: sameList(state.entryIds, p.entryIds, Object.is) ? state.entryIds : p.entryIds, playId: p.playId ?? '',
      index: p.currentIndex, playing: p.playing, position: p.position, duration: p.duration, buffering: p.audio.buffering,
      volume: p.volume, audio: sameFields(state.audio, p.audio) ? state.audio : p.audio,
      devices: !p.devices.length || sameList(state.devices, p.devices, sameFields) ? state.devices : p.devices, device: p.audio.requestedDevice,
      radio: p.radio?.label === state.radio?.label ? state.radio : p.radio,
      // A queue loaded some other way (a play key resumes the saved one) replaces the offer.
      resumable: p.queue.length ? null : state.resumable,
      // The desktop asks Navidrome for the original file; the host doesn't verify what came back.
      // A kept song says so only when the host really opened its file.
      delivery: track?.source === 'navidrome' ? (p.fromDevice ? 'device' : 'original-requested') : null,
      reach: sameReach(state.reach, reach) ? state.reach : reach,
      queuedPlays: snapshot.server.queuedPlays ?? 0,
      error, diagnostics: snapshot.diagnostics,
      repeat: p.repeat ?? 'off', shuffle: p.shuffle ?? false,
      stationTitle: p.stationTitle ?? null,
    });
  };
  let received = false;
  const unsubscribe = desktop.subscribe(snapshot => { received = true; apply(snapshot); });
  void desktop.snapshot().then(snapshot => { if (!received) apply(snapshot); });
  import.meta.hot?.dispose(unsubscribe);
}

// Browser playback ----------------------------------------------------------------------
// Two elements take turns: while one plays, the other loads the next song near the end,
// so the change between songs is short. Streams come through the host's /api/stream,
// which keeps the Navidrome credentials off the device. A station comes through /api/station,
// which keeps its stream address on the host too.
const stream = (track: Track, mp3 = false) => isStation(track) ? `/api/station?id=${encodeURIComponent(stationIdOf(track))}`
  : `/api/stream?id=${encodeURIComponent(track.id)}${mp3 ? '&format=mp3' : ''}`;
const web = local && !android ? { active: new Audio(), standby: new Audio() } : null;
// Every real load is a new playback instance. Play reports belong to the instance, so
// replaying a song counts again and moving an already counted entry doesn't. Shared by the
// browser and Android, which both report plays and save the queue from the page.
const plays = {
  instance: 0, track: null as Track | null, started: -1, finished: -1,
  lastPosition: 0, listened: 0, startAt: 0,
};
// Entry ids for the page's own queue, with the desktop's meaning: unique, and kept across moves.
// Android's are unique per page load too, since the native player may still hold the last page's.
let entries = 0;
const entryPrefix = android ? `a${Date.now().toString(36)}-` : 'web-';
const mint = (count: number) => Array.from({ length: count }, () => `${entryPrefix}${++entries}`);
// Bumped by every new queue and by stopping radio, so a late radio request can tell it's stale.
let station = 0;
// Bumped by player.pause(), so a retry still waiting on the session doesn't start the song again.
let pauses = 0;
// Bumped by every request to play something else (a list, radio, a saved queue, a queue entry),
// so a page that asked the server for songs first can tell it was overtaken while it waited.
let requests = 0;
export const playRequests = () => requests;

function prepare(element: HTMLAudioElement, track: Track, entry: string, mp3 = false) {
  element.src = stream(track, mp3);
  element.dataset.entry = entry;
  element.dataset.mp3 = mp3 ? '1' : '';
  element.volume = state.volume / 100;
}
function webLoad(index: number, { play = true, startAt = 0, patch = {} }: { play?: boolean; startAt?: number; patch?: Partial<PlayerState> } = {}) {
  const queue = patch.queue ?? state.queue, entryIds = patch.entryIds ?? state.entryIds;
  const track = queue[index], entry = entryIds[index];
  if (android && track && entry) {
    // set() sends the queue to the native player before the load that names the entry. The new
    // play instance begins when the player reports the entry started (see nativePlayback).
    set({ ...patch, index, position: startAt, duration: track.duration ?? 0, buffering: play, error: null, playing: false,
      delivery: isStation(track) ? null : 'original-requested', stationTitle: null });
    android.player.load(entry, { play, position: startAt });
    saveSoon();
    return;
  }
  if (!web || !track || !entry) return;
  web.active.pause();
  // The standby element may already hold this entry; one that failed to load starts over.
  if (web.standby.dataset.entry === entry && !web.standby.error) [web.active, web.standby] = [web.standby, web.active];
  else prepare(web.active, track, entry);
  web.standby.removeAttribute('src'); web.standby.dataset.entry = ''; web.standby.load();
  plays.instance++; plays.track = track; plays.lastPosition = startAt; plays.listened = 0; plays.startAt = startAt;
  if (startAt && web.active.readyState >= HTMLMediaElement.HAVE_METADATA) { web.active.currentTime = startAt; plays.startAt = 0; }
  set({ ...patch, index, position: startAt, duration: track.duration ?? 0, buffering: play, error: null, playing: false, playId: `web.${plays.instance}`,
    delivery: isStation(track) ? null : web.active.dataset.mp3 ? 'mp3-fallback' : 'original-requested' });
  if (play) void web.active.play().catch(() => set({ playing: false, buffering: false }));
  session(track);
  saveSoon();
}
// Play reporting in the browser and on Android, by time actually listened, with the desktop's
// rule: songs of 30 seconds or less start but never finish.
function listened(seconds: number) {
  if (!local || !plays.track || !getSettings().reportPlays || plays.track.source !== 'navidrome') return;
  const { track, instance } = plays;
  // Now playing means nothing later: skipped while the server is away. The Android bridge keeps
  // finished plays for later itself; the browser build can't.
  if (plays.started !== instance) { plays.started = instance; if (!state.reach.away) void api.reportPlay(track.id, 'started'); }
  plays.listened += seconds;
  const threshold = finishThreshold(track.duration ?? (web ? web.active.duration : state.duration));
  if (plays.finished !== instance && threshold !== null && plays.listened >= threshold) { plays.finished = instance; void api.reportPlay(track.id, 'finished'); }
}
if (web) {
  for (const element of [web.active, web.standby]) {
    element.preload = 'auto';
    const mine = () => element === web.active;
    element.addEventListener('playing', () => { if (mine()) set({ playing: true, buffering: false }); });
    element.addEventListener('pause', () => { if (mine() && !element.ended) { set({ playing: false }); saveSoon(); } });
    element.addEventListener('waiting', () => { if (mine()) set({ buffering: true }); });
    element.addEventListener('loadedmetadata', () => { if (mine() && plays.startAt) { element.currentTime = plays.startAt; plays.startAt = 0; } });
    element.addEventListener('durationchange', () => { if (mine() && Number.isFinite(element.duration)) set({ duration: element.duration }); });
    element.addEventListener('timeupdate', () => {
      if (!mine()) return;
      const position = element.currentTime;
      const step = position - plays.lastPosition;
      if (Math.abs(step) >= .25) {
        if (step > 0 && step < 2 && !element.paused) listened(step);
        plays.lastPosition = position; set({ position });
      }
      // The song that follows, which is this one again under repeat one: the standby element
      // then holds a second copy, and the swap starts it over as quickly as a new song.
      const upcoming = following(state.index, state.queue.length, repeatFor(state.repeat, current(state)), 'ended');
      const next = state.queue[upcoming], nextEntry = state.entryIds[upcoming];
      // A station waits for its turn: loaded early, it would start its stream early and fall behind.
      if (next && nextEntry && !isStation(next) && web.standby.dataset.entry !== nextEntry && element.duration - position < 25) { prepare(web.standby, next, nextEntry); web.standby.load(); }
      if (Math.floor(position) % 5 === 0) positionState();
    });
    element.addEventListener('ended', () => {
      if (!mine()) return;
      // A station's stream only ends when it drops; repeat one doesn't dial it again.
      const next = following(state.index, state.queue.length, repeatFor(state.repeat, current(state)), 'ended');
      if (next >= 0) webLoad(next);
      else set({ playing: false, position: 0 });
    });
    element.addEventListener('error', () => {
      if (!mine() || !element.dataset.entry) return;
      const { instance, track } = plays;
      const wanted = state.playing || state.buffering, paused = pauses;
      const network = element.error?.code === MediaError.MEDIA_ERR_NETWORK;
      // A refused stream (an ended session) looks like an unsupported file, so check the session
      // before blaming the format. A dropped connection is reported as one, without that check.
      void (network ? Promise.resolve(true) : stillSignedIn()).then(signedIn => {
        if (!signedIn || instance !== plays.instance || !mine() || !track) return;
        // Some originals (ALAC, DSD) are beyond the browser; ask the server for a 320 kbps MP3 once.
        if (!network && !element.dataset.mp3 && !isStation(track)) {
          plays.startAt = plays.lastPosition;
          prepare(element, track, element.dataset.entry!, true);
          set({ delivery: 'mp3-fallback' });
          if (wanted && paused === pauses) void element.play().catch(() => undefined);
          return;
        }
        set({ playing: false, buffering: false, error: isStation(track) ? stationFailed : awayError(track, 'This song could not be played here. Try another, or check the connection.') });
      });
    });
  }
  // The browser saves the queue itself; the desktop main process does this on its own.
  setInterval(() => { if (!web.active.paused) saveSoon(); }, 30000);
  addEventListener('pagehide', () => saveNow());
}
const stationFailed = 'This station could not be played here. It may be off the air, or its stream may be in a format this player can\'t play.';
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveSoon() { if (local) { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 3000); } }
function saveNow() {
  if (!local || !state.connected || state.reach.away || !getSettings().syncQueue || !state.queue.length || state.index < 0) return;
  // The queue never holds more than the server keeps, so the saved index is the playing song's own.
  if (state.queue.length > QUEUE_LIMIT || state.queue.some(t => t.source !== 'navidrome')) return;
  void api.saveQueue(state.queue.map(t => t.id), state.index, (web ? plays.startAt || web.active.currentTime : livePosition()) || 0);
}
// Appends at the end, making room by dropping songs already played from the front.
function webAppend(tracks: Track[]) {
  let { queue, entryIds, index } = state;
  const over = queue.length + tracks.length - QUEUE_LIMIT;
  if (over > 0) { const drop = Math.min(over, Math.max(0, index)); queue = queue.slice(drop); entryIds = entryIds.slice(drop); index -= drop; }
  const adding = tracks.slice(0, QUEUE_LIMIT - queue.length);
  if (adding.length) { set({ queue: [...queue, ...adding], entryIds: [...entryIds, ...mint(adding.length)], index }); saveSoon(); }
}

// Radio (browser) -----------------------------------------------------------------------
// The desktop main process runs radio itself so it keeps going in the tray. In the browser,
// when three or fewer songs remain, fetch songs like the last one and append the new ones.
let topping = -1;
function topUpRadio() {
  if (!state.radio || topping === station || state.index < 0 || state.queue.length - state.index > 3) return;
  const last = state.queue[state.queue.length - 1];
  if (!last) return;
  const mine = topping = station;
  void api.similarSongs(last.id, 30).then(result => {
    if (topping === mine) topping = -1;
    if (mine !== station || !state.radio || !result.ok) return;
    const seen = new Set(state.queue.map(t => t.id));
    const fresh = result.value.filter(t => !seen.has(t.id)).slice(0, 20);
    if (fresh.length) webAppend(fresh);
  });
}

// Lock screen, notification shade, headphones, and the Flip's cover screen.
function session(track: Track) {
  if (!('mediaSession' in navigator)) return;
  const art = track.coverArt ? [96, 256, 512].map(size => ({ src: new URL(api.coverUrl(track.coverArt!, size), location.href).href, sizes: `${size}x${size}` })) : [];
  navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album, artwork: art });
}
function positionState() {
  if (!web || !('mediaSession' in navigator) || !Number.isFinite(web.active.duration)) return;
  try { navigator.mediaSession.setPositionState({ duration: web.active.duration, position: Math.min(web.active.currentTime, web.active.duration), playbackRate: 1 }); }
  catch { /* Some browsers reject position updates during a source change. */ }
}
if (web && 'mediaSession' in navigator) {
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => player.toggle()], ['pause', () => player.pause()],
    ['previoustrack', () => player.previous()], ['nexttrack', () => player.next()],
    ['seekto', details => { if (details.seekTime !== undefined) player.seek(details.seekTime); }],
    ['seekbackward', () => player.seek(Math.max(0, state.position - 10))], ['seekforward', () => player.seek(state.position + 10)],
  ];
  for (const [action, handler] of handlers) { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ } }
}

// Browser sign-in -----------------------------------------------------------------------
// The host may protect itself with a password. Until it's given, the browser shows only the
// sign-in screen; any 401 from /api (an expired or ended session) returns there.
// An unreachable host reads as signed out; signing in then says it couldn't be reached.
// Past that, the host needs a server: one this page connects to (the connect screen), or one
// from the host's environment. Without either the page shows the connect screen.
// Recent searches belong to the account the page uses: the host's configured server, or the
// page's own connection, as the host names it. Without a server there is none. The host doesn't
// say which username a connection uses, so connecting from the page always starts with none.
const webAccount = (status: { connected: boolean; serverName: string | null; pageConnection: boolean }) =>
  status.connected ? `web\n${status.pageConnection ? 'page' : 'host'}\n${status.serverName ?? ''}` : null;
function allowed(status: WebSessionStatus) {
  // Signed out while the page was away: the searches go too.
  if (status.required && !status.signedIn) { clearSearches(); signedOut(); return; }
  // The queue's songs belong to the server they came from. When the host now has another one for
  // this page (its own connection is gone and the host's configured server stands in, say), they
  // don't carry over to it.
  if ((state.connected || state.queue.length > 0) && !sameServer(status)) disconnected();
  searchesFor(webAccount(status));
  const was = state.connected;
  set({
    access: status.required ? 'signed-in' : 'open', connected: status.connected, serverName: status.serverName,
    pageConnection: status.pageConnection,
  });
  if (status.connected && !was) void offerResume();
}
const checkAccess = async () => allowed(await webSession.status());
// The host names a server the same way each time it's asked. Another name, or the page's own
// connection where the configured server was (or the reverse), is another account.
const sameServer = (status: WebSessionStatus) => status.connected && status.serverName === state.serverName && status.pageConnection === state.pageConnection;
function signedOut() {
  if (!web || state.access === 'sign-in') return;
  // A sign-out from any tab makes the host forget this page's own connection, and an expired
  // session may be followed by someone else's, so its queue goes now. The host's configured
  // server is the same account after signing in again, so its queue waits, paused.
  if (state.pageConnection) disconnected();
  web.active.pause();
  resetLibraryCaches();
  searchesFor(null);
  set({ access: 'sign-in', connected: false, playing: false, buffering: false, resumable: null, choosingServer: false });
}
// Disconnected, or the host forgot the connection (it restarted): playback stops and the queue
// empties, since its songs belong to that server. A queue saved there is offered again after
// connecting to it.
function disconnected() {
  if (!web) return;
  station++; requests++;
  for (const element of [web.active, web.standby]) { element.pause(); element.dataset.entry = ''; element.removeAttribute('src'); element.load(); }
  plays.track = null;
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  webReach.leave();
  resetLibraryCaches();
  // The account is gone with its server, and its searches with it.
  searchesFor(null);
  set({
    connected: false, pageConnection: false, serverName: null, choosingServer: false, queue: [], entryIds: [], index: -1,
    playing: false, buffering: false, position: 0, duration: 0, radio: null, radioStarting: null, resumable: null, delivery: null, error: null,
  });
}
// Checked when a stream fails, since media elements can't report a lost session or connection.
// A server that is gone, or another one in its place (the host forgot this page's connection
// and offers its configured server), stops playback and empties the queue as a disconnect does:
// the song is never asked for again from an account it didn't come from.
async function stillSignedIn() {
  if (state.access !== 'signed-in' && state.access !== 'open') return true;
  const status = await webSession.status();
  if (status.required && !status.signedIn) { signedOut(); return false; }
  if (!sameServer(status)) { disconnected(); allowed(status); return false; }
  return true;
}
if (web) {
  // Library calls report a lost session (expired, or ended from another tab) through the bridge.
  // Media and artwork can't report one; playback errors check the session instead (stillSignedIn).
  onSignedOut(signedOut);
  // A call the host had no server for: back to the connect screen, unless the host has a
  // configured server to fall back on.
  onDisconnected(() => { if (!state.connected) return; disconnected(); void checkAccess(); });
  void checkAccess();
}

// Android ----------------------------------------------------------------------------------
// The page keeps the queue, as in the browser, and the native player plays a copy of it (see
// apps/android/web/bridge.ts). It moves between songs, and takes the notification's and lock
// screen's buttons, on its own; the page follows its reports. Sign-in works as on the desktop.
let native: AndroidPlayback | null = null;
// Reports whose entry the page doesn't know (a queue edit still on its way) are left alone.
function nativePlayback(playback: AndroidPlayback) {
  const before = native;
  native = playback;
  const index = playback.entryId ? state.entryIds.indexOf(playback.entryId) : -1;
  if (index < 0) { if (state.playing || state.buffering) set({ playing: false, buffering: false }); return; }
  const track = state.queue[index];
  const patch: Partial<PlayerState> = {
    index, playing: playback.playing, buffering: playback.buffering,
    delivery: isStation(track) ? null : playback.fallback ? 'mp3-fallback' : playback.local ? 'device' : 'original-requested',
    duration: playback.duration > 0 ? playback.duration : track.duration ?? 0,
    stationTitle: isStation(track) ? playback.stationTitle ?? null : null,
  };
  if (!before || before.playId !== playback.playId) {
    // The entry started from its beginning: a new play, as a load is in the browser.
    plays.instance++; plays.track = track; plays.listened = 0; plays.lastPosition = playback.position; plays.startAt = 0;
    patch.playId = `android.${playback.playId}`;
    if (before) saveSoon();
  } else {
    const step = playback.position - plays.lastPosition;
    if (step > 0 && step < 2 && playback.playing) listened(step);
    plays.lastPosition = playback.position;
  }
  patch.position = playback.position;
  // The last song ended: like the browser, the deck rests at its start.
  if (playback.ended) { patch.playing = false; patch.buffering = false; patch.position = 0; }
  // A song that can't be played says so once.
  if (playback.error && (before?.error !== playback.error || before.playId !== playback.playId)) {
    patch.error = isStation(track) ? stationFailed : awayError(track, 'This song could not be played here. Try another, or check the connection.');
  }
  set(patch);
}
function nativeSession(next: AndroidSession) {
  const was = state.connected;
  // Another server or account: nothing cached from the last one may show.
  if (next.sessionId !== state.sessionId) resetLibraryCaches();
  searchesFor(next.account);
  const { saved, canRemember, reconnecting, reconnectError } = next.signIn;
  const signIn = state.signIn.saved?.url === saved?.url && state.signIn.saved?.username === saved?.username && state.signIn.canRemember === canRemember
    && state.signIn.reconnecting === reconnecting && state.signIn.reconnectError === reconnectError ? state.signIn : next.signIn;
  const reach = next.reach ?? ONLINE;
  const before = state.reach;
  set({ access: next.ready ? 'open' : 'checking', connected: next.connected, serverName: next.serverName, sessionId: next.sessionId, signIn,
    reach: sameReach(state.reach, reach) ? state.reach : reach, queuedPlays: next.queuedPlays ?? 0 });
  if (next.connected && !was) void offerResume();
  else reachChanged(before, state.reach);
}
// The page keeps the queue in the browser and on Android: when the server is back, a queue that
// changed meanwhile is saved, and an empty one is offered the saved queue.
function reachChanged(before: Reachability, after: Reachability) {
  if (!local || !before.away || after.away) return;
  if (!state.queue.length) void offerResume(); else saveSoon();
}
if (web) webReach.subscribe(next => { const before = state.reach; set({ reach: next }); reachChanged(before, next); });
if (android) {
  android.player.subscribe(nativePlayback);
  android.player.onReset(() => {
    station++; native = null;
    set({ queue: [], entryIds: [], index: -1, playing: false, buffering: false, position: 0, duration: 0, radio: null, resumable: null, error: null, delivery: null });
  });
  android.session.subscribe(nativeSession);
  nativeSession(android.session.get());
  // The native player wraps the queue or repeats a song itself, so it does so with the page asleep.
  android.player.repeat(state.repeat);
  // The app was swiped away while playing and the player kept going: show what it holds.
  void android.player.restore().then(held => {
    if (!held || state.queue.length) return;
    set({ queue: held.queue, entryIds: held.entryIds, index: held.index, resumable: null });
    nativePlayback(held.playback);
  });
  setInterval(() => { if (state.playing) saveSoon(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
}

// A queue saved on the server is offered once, when nothing is playing yet.
async function offerResume() {
  if (!getSettings().syncQueue || state.queue.length || state.reach.away) return;
  const saved = await api.savedQueue();
  if (saved.ok && saved.value?.tracks.length && !state.queue.length) set({ resumable: saved.value });
}
if (desktop) { const stop = subscribe(() => { if (state.connected) { stop(); setTimeout(() => void offerResume(), 400); } }); }

async function startStation(seed: RadioStart) {
  if (state.reach.away) { set({ error: 'Radio needs your server.' }); return; }
  if (desktop) {
    report(await desktop.radio.start(seed.kind === 'song' ? { kind: 'song', trackId: seed.track.id, label: seed.label } : seed));
    return;
  }
  const mine = ++station;
  let start: Track | undefined;
  if (seed.kind === 'song' && isStation(seed.track)) { set({ error: 'Radio starts from a song, record, or artist, not from a station.' }); return; }
  if (seed.kind === 'song') start = seed.track;
  else if (seed.kind === 'artist') { const top = await api.topSongs(seed.id, 5); start = top.ok ? top.value[0] : undefined; }
  else { const album = await api.album(seed.id); start = album.ok ? album.value.tracks[0] : undefined; }
  // Something else was played, or another station started, while this one was on its way.
  if (mine !== station) return;
  if (!start) { set({ error: 'Radio needs a song to start from, and none was found.' }); return; }
  const result = await api.similarSongs(start.id, 40);
  if (mine !== station) return;
  if (!result.ok) { set({ error: result.error }); return; }
  const tracks = [start, ...result.value.filter(t => t.id !== start!.id)];
  if (tracks.length < 2) { set({ error: 'Your server found nothing similar to play. Radio needs artist information on the server.' }); return; }
  // Radio from the song that's playing carries on from it rather than starting it over.
  const playing = current(state), entry = currentEntry(state);
  if (playing?.id === start.id && entry && !(web?.active.ended || native?.ended)) {
    station++;
    set({ queue: [playing, ...tracks.slice(1)], entryIds: [entry, ...mint(tracks.length - 1)], index: 0, radio: { label: seed.label }, error: null, resumable: null });
    saveSoon();
  } else await player.play(tracks, 0, { label: seed.label });
  // Radio and repeat exclude each other, as on the desktop (setPlayMode in main/index.ts): radio
  // keeps adding songs, so a station turns repeat off, and turning repeat on stops the station.
  if (state.radio && state.repeat !== 'off') player.repeat('off');
}

const volumeCommands = desktop ? new VolumeCommandCoalescer(percent => desktop.command({ type: 'volume', percent }), error => set({ error })) : null;
export const optimisticVolume = volumeCommands;

export type RadioStart = { kind: 'song'; track: Track; label: string } | { kind: 'album' | 'artist'; id: string; label: string };

// Away, only kept songs play. Null, after saying so, when none of these are kept.
function playableNow(tracks: Track[], start: number): { items: Track[]; start: number } | null {
  if (!state.reach.away || !keptSupported) return { items: tracks, start };
  const chosen = keptOnly(tracks, start, track => track.source !== 'navidrome' || isKept(track.id));
  if (!chosen) set({ error: KEPT_MESSAGES.notKept });
  return chosen;
}

export const player = {
  // Resolves true once the queue was replaced, false when it wasn't (the error is shown).
  async play(tracks: Track[], start: number, radio: PlayerState['radio'] = null): Promise<boolean> {
    if (!tracks.length) return false;
    const playable = playableNow(tracks, start);
    if (!playable) return false;
    ({ items: tracks, start } = playable);
    requests++;
    let chosen = queueWindow(tracks, start);
    // With shuffle on, a list plays from the chosen song with the rest in random order. Radio
    // keeps its own order. The desktop's audio host does this itself (the 'queue' case in
    // packages/player-mpv/host.ts), for opened files too.
    if (local && state.shuffle && !radio) {
      const order = shuffleOrder(chosen.items.length, chosen.start);
      chosen = { items: order.map(i => chosen.items[i]), start: chosen.start };
    }
    set({ error: null, resumable: null });
    if (local) { station++; webLoad(chosen.start, { patch: { queue: chosen.items, entryIds: mint(chosen.items.length), radio } }); return true; }
    return report(await desktop!.playTracks(chosen.items.map(track => track.id), chosen.start)).ok;
  },
  // Plays the seed, then songs like it, and keeps adding more as the queue runs low.
  // Artist and record radio start from one of their songs: asking the server for songs like
  // a song is fast, while asking by artist can take longer than the request limit.
  async radio(seed: RadioStart) {
    // The deck says a station is on its way until it plays or fails; servers can take seconds.
    requests++;
    set({ error: null, radioStarting: seed.label });
    try { await startStation(seed); } finally { if (state.radioStarting === seed.label) set({ radioStarting: null }); }
  },
  showError(message: string) { set({ error: message }); },
  // Asks the server again while it is out of reach. passive: a check the page made on its own
  // (focus, the network coming back), skipped when one was just made.
  async retryServer(passive = false): Promise<Result> {
    if (desktop) return desktop.retryServer ? desktop.retryServer(passive) : { ok: true, value: undefined };
    if (android) return android.session.retry ? android.session.retry(passive) : { ok: true, value: undefined };
    const outcome = await webReach.retry(passive);
    return !outcome || outcome.kind !== 'unreachable' || !state.reach.away ? { ok: true, value: undefined } : { ok: false, error: OUT_OF_REACH, unreachable: true };
  },
  stopRadio() {
    if (desktop) { void desktop.radio.stop().then(report); return; }
    station++; set({ radio: null });
  },
  async resume() {
    const saved = state.resumable;
    set({ resumable: null });
    if (!saved) return;
    requests++;
    if (desktop) { report(await desktop.resumeQueue()); return; }
    const chosen = queueWindow(saved.tracks, saved.currentIndex);
    station++;
    webLoad(chosen.start, { play: true, startAt: saved.positionSeconds, patch: { queue: chosen.items, entryIds: mint(chosen.items.length), radio: null } });
  },
  dismissResume() { set({ resumable: null }); },

  // Browser sign-in -----------------------------------------------------------------------
  async signIn(password: string): Promise<Result> {
    const result = await webSession.signIn(password);
    if (result.ok) { set({ error: null }); await checkAccess(); }
    return result;
  },
  // The browser's connect screen. The login goes to the host once and stays there.
  async connect(connection: Connection): Promise<Result<ConnectOutcome>> {
    const result = await webSession.connect(connection);
    if (!result.ok) return result;
    // Only plain HTTP answered: nothing changed, and the connect screen asks first.
    if ('type' in result.value) return { ok: true, value: result.value };
    // A queue from the server before (the host's configured one, say) doesn't carry over.
    disconnected();
    // A new connection may be another account on the same server, so the last one's searches go,
    // even those stored before this page load knew of an account.
    clearSearches();
    searchesFor(webAccount({ connected: true, pageConnection: true, serverName: result.value.serverName }));
    set({ connected: true, pageConnection: true, serverName: result.value.serverName, error: null });
    void offerResume();
    return { ok: true, value: { type: 'connected' } };
  },
  async disconnect(): Promise<Result> {
    const result = await webSession.disconnect();
    if (!result.ok) return result;
    disconnected();
    // The host may still have its own server to fall back on.
    await checkAccess();
    return result;
  },
  // Browser: opens the connect screen over the host's configured server, or closes it again.
  chooseServer(on: boolean) { if (web) set({ choosingServer: on && state.connected && !state.pageConnection }); },
  async signOut() {
    // A successful sign-out also arrives through onSignedOut; signedOut() runs once either way,
    // and drops this page's own connection with its queue (the host forgets it with the session).
    const result = await webSession.signOut();
    if (result.ok) signedOut(); else set({ error: result.error });
  },

  // Queue editing ------------------------------------------------------------------------
  // A number inserts before the song at that index (a drop onto the queue). Resolves to how
  // many songs joined the queue: fewer when it filled up, 0 when none could (the error is shown).
  async add(tracks: Track[], where: 'next' | 'end' | number): Promise<number> {
    if (!tracks.length) return 0;
    const playable = playableNow(tracks, 0);
    if (!playable) return 0;
    tracks = playable.items;
    if (state.index < 0) {
      if (!await player.play(tracks, 0)) return 0;
      if (tracks.length > QUEUE_LIMIT) set({ error: queueFull(tracks.length - QUEUE_LIMIT) });
      return Math.min(tracks.length, QUEUE_LIMIT);
    }
    const adding = tracks.slice(0, Math.max(0, QUEUE_LIMIT - state.queue.length));
    if (!adding.length) { set({ error: queueFull(0) }); return 0; }
    const left = tracks.length - adding.length;
    if (local) {
      const at = where === 'next' ? state.index + 1 : where === 'end' ? state.queue.length : Math.max(0, Math.min(where, state.queue.length));
      const queue = [...state.queue], entryIds = [...state.entryIds];
      queue.splice(at, 0, ...adding); entryIds.splice(at, 0, ...mint(adding.length));
      // Songs put before the playing one push it down; it keeps playing.
      const index = at <= state.index ? state.index + adding.length : state.index;
      set({ queue, entryIds, index, error: left ? queueFull(left) : state.error }); saveSoon(); return adding.length;
    }
    if (!report(await desktop!.queue.add(adding.map(t => t.id), where)).ok) return 0;
    if (left) set({ error: queueFull(left) });
    return adding.length;
  },
  async move(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= state.queue.length || to >= state.queue.length) return;
    if (local) {
      const queue = [...state.queue], entryIds = [...state.entryIds];
      const [moved] = queue.splice(from, 1); queue.splice(to, 0, moved);
      const [entry] = entryIds.splice(from, 1); entryIds.splice(to, 0, entry);
      const index = from === state.index ? to : from < state.index && to >= state.index ? state.index - 1 : from > state.index && to <= state.index ? state.index + 1 : state.index;
      set({ queue, entryIds, index }); saveSoon(); return;
    }
    report(await desktop!.queue.move(from, to));
  },
  async remove(indexes: number[]) {
    const drop = new Set(indexes.filter(i => i !== state.index));
    if (!drop.size) return;
    if (local) {
      const keep = (_: unknown, i: number) => !drop.has(i);
      const index = state.index - [...drop].filter(i => i < state.index).length;
      set({ queue: state.queue.filter(keep), entryIds: state.entryIds.filter(keep), index }); saveSoon(); return;
    }
    report(await desktop!.queue.remove([...drop]));
  },
  async clear() {
    if (local) {
      const now = current(state), entry = currentEntry(state);
      station++;
      set({ queue: now ? [now] : [], entryIds: entry ? [entry] : [], index: now ? 0 : -1, radio: null }); saveSoon(); return;
    }
    if (state.radio) report(await desktop!.radio.stop());
    report(await desktop!.queue.clear());
  },

  toggle() {
    if (android) {
      if (state.index < 0) return;
      // A song that already ended starts over as a new play, as in the browser.
      if (native?.ended || !native?.entryId) { webLoad(state.index); return; }
      if (state.playing) android.player.pause(); else android.player.play();
      return;
    }
    if (web) {
      if (state.index < 0) return;
      // A song that already ended starts over as a new play (and a new report), not a resume.
      if (web.active.ended) { webLoad(state.index); return; }
      if (web.active.paused) void web.active.play().catch(() => undefined); else web.active.pause();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = web.active.paused ? 'paused' : 'playing';
      return;
    }
    void desktop!.command({ type: state.playing ? 'pause' : 'play' }).then(report);
  },
  // Pauses whatever is playing or starting to play, for requests that mean pause: the media
  // session's, and the sleep timer's. Unlike toggle, it never starts anything, and it doesn't
  // trust the page's copy of the state (a hidden desktop window gets no snapshots).
  pause() {
    if (android) { if (state.index >= 0) android.player.pause(); return; }
    if (web) {
      // A song still starting (or retrying as MP3) stays stopped, and the deck stops waiting for it.
      pauses++;
      web.active.pause();
      if (state.buffering) set({ buffering: false });
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      return;
    }
    void desktop!.command({ type: 'pause' }).then(report);
  },
  // Android: the native player keeps the sleep timer too, so it still pauses once the app is swiped
  // away and the page's own timers are gone. `afterPlay` is a PlayerState.playId.
  sleepNatively(at: number | null, afterPlay: string | null) {
    if (!android) return;
    android.player.sleepAt(at);
    android.player.sleepAfterPlay(afterPlay?.startsWith('android.') ? Number(afterPlay.slice('android.'.length)) : null);
  },
  // Plays the queue entry at this index. Pass the entry id the click saw: if the queue changed
  // underneath, the entry is refused rather than playing whatever now sits at that index.
  jump(index: number, entryId: string | undefined = state.entryIds[index]) {
    if (!state.queue[index] || !entryId) return;
    requests++;
    if (local) { if (state.entryIds[index] === entryId) webLoad(index); return; }
    void desktop!.queue.jump(index, entryId).then(report);
  },
  // Next moves on under repeat one too, and wraps to the first song under repeat all.
  next() {
    if (local) { const next = following(state.index, state.queue.length, state.repeat, 'skip'); if (next >= 0) webLoad(next); return; }
    void desktop!.command({ type: 'next' }).then(report);
  },
  previous() {
    if (local) {
      const previous = preceding(state.index, state.queue.length, state.repeat);
      // A station has no start to go back to: Previous only moves back in the queue.
      if (!isStation(current(state)) && ((web ? web.active.currentTime : livePosition()) > 3 || previous < 0)) player.seek(0);
      else if (previous >= 0) webLoad(previous);
      return;
    }
    void desktop!.command({ type: 'previous' }).then(report);
  },
  repeat(mode: RepeatMode) {
    if (desktop) { void desktop.command({ type: 'repeat', mode }).then(report); return; }
    // Turning repeat on stops radio (see startStation), and a station still on its way: its
    // request finds the counter moved and gives up.
    if (mode !== 'off') station++;
    set({ repeat: mode, ...(mode !== 'off' && state.radio ? { radio: null } : {}) });
    android?.player.repeat(mode);
    saveModes();
  },
  // Shuffle on puts the songs after the current one in random order; the current song and the
  // ones before it stay where they are. Off leaves the queue as it is, as on the desktop (the
  // 'shuffle' case in packages/player-mpv/host.ts).
  shuffle(on: boolean) {
    if (desktop) { void desktop.command({ type: 'shuffle', on }).then(report); return; }
    if (on && !state.shuffle && state.queue.length) {
      const order = shuffleOrder(state.queue.length, state.index);
      set({ queue: order.map(i => state.queue[i]), entryIds: order.map(i => state.entryIds[i]), shuffle: true });
      saveSoon();
    } else set({ shuffle: on });
    saveModes();
  },
  // `entryId`, when given, is the entry the gesture started on; another entry is never seeked.
  seek(seconds: number, entryId?: string) {
    const track = current(state);
    // A station is live: there is no position to seek to.
    if (!track || isStation(track) || (entryId !== undefined && entryId !== currentEntry(state))) return;
    if (android) {
      android.player.seek(currentEntry(state)!, seconds);
      plays.lastPosition = seconds; set({ position: seconds }); saveSoon(); return;
    }
    if (web) {
      if (web.active.readyState >= HTMLMediaElement.HAVE_METADATA) web.active.currentTime = seconds; else plays.startAt = seconds;
      plays.lastPosition = seconds; set({ position: seconds }); positionState(); saveSoon(); return;
    }
    // The host refuses the seek if that entry is no longer the one playing.
    void desktop!.command({ type: 'seek', seconds, queueIndex: state.index, trackId: track.id, entryId: entryId ?? currentEntry(state) }).then(report);
  },
  volume(percent: number, final = false) {
    if (android) { android.player.volume(percent); set({ volume: percent }); return; }
    if (web) { web.active.volume = web.standby.volume = percent / 100; set({ volume: percent }); return; }
    volumeCommands!.enqueue(percent);
    if (final) volumeCommands!.finish();
  },
  dismissError() { set({ error: null }); },
};
