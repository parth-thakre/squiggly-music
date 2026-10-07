/// <reference types="electron-vite/node" />
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, protocol, safeStorage, screen, session, shell, Tray } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Effect, Either, Schema } from 'effect';
import iconPath from './assets/icon.png?asset';
import { emptyPlayer, emptyDiagnostics } from '../../../packages/core/contracts';
import { CommandSchema, ConnectionSchema, IdSchema, PlayTracksSchema } from '../../../packages/core/validation';
import {
  defaultSettings, QUEUE_LIMIT, QueueAddSchema, QueueJumpSchema, QueueMoveSchema, QueueRemoveSchema, RadioSeedSchema,
  SettingsFileSchema, SettingsPatchSchema, WindowStateSchema,
} from '../../../packages/core/desktopValidation';
import { defaultPlayModes, OpenPathsSchema, PlayModesSchema } from '../../../packages/core/desktopValidation';
import type { AppSnapshot, Connection, Result, PlayerCommand, Settings, SystemMediaState, Track } from '../../../packages/core/contracts';
import type { HostMessage, HostRequest, PlayableTrack } from '../../../packages/player-mpv/protocol';
import { Metrics } from '../../../packages/core/metrics';
import { SubsonicClient, libraryCall, libraryMethods, resolveServerAddress } from '../../../packages/adapter-opensubsonic/client';
import { JsonStore } from './store';
import { PlayTracker, type PlayEvent } from './plays';
import { QueueSync } from './queueSync';
import { Radio } from './radio';
import { startMpris, type MediaSession } from './mpris';
import { Account } from './account';
import { initialUpdateState, Updates } from './updates';
import { AUDIO_EXTENSIONS, checkAudioPaths, isLocalCover, readLocalCover, readLocalTracks } from './localFiles';
import { configDirectory } from './config';
import { startConfigFolder } from './configBridge';
import { extensionScheme, startExtensions } from './extensions/electron';

// Native Wayland where the session offers it (Fedora's default), XWayland otherwise. Must precede ready.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
// Windows names the app in the media flyout and notifications by finding a Start menu shortcut
// with this id (appId in electron-builder.yml; the installer's shortcuts carry it). Without one it
// says "Unknown app". Set before Chromium creates its windows, which take the id they start with.
const APP_ID = 'dev.squiggly.music';
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
// The portable exe has no installer, so it adds that shortcut itself, once, unless one exists.
function ensurePortableShortcut() {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (process.platform !== 'win32' || !exe) return;
  const link = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Squiggly Music.lnk');
  try {
    // An installed copy's shortcut, or one for a portable exe that still exists, already names the app.
    const existing = existsSync(link) ? shell.readShortcutLink(link) : null;
    if (existing?.appUserModelId === APP_ID && existsSync(existing.target)) return;
    shell.writeShortcutLink(link, existing ? 'replace' : 'create', { target: exe, appUserModelId: APP_ID, icon: exe, iconIndex: 0, description: 'Squiggly Music' });
  } catch { metrics.record('shell.shortcut-unavailable', 0, true); }
}
// One instance owns the audio host, tray, and media keys. Launching again shows the existing window.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

const directory = dirname(fileURLToPath(import.meta.url));
const started = performance.now();
const metrics = new Metrics();
const loop = monitorEventLoopDelay({ resolution: 20 });
const state: AppSnapshot = {
  player: emptyPlayer(), diagnostics: emptyDiagnostics(), update: initialUpdateState(),
  server: { connected: false, name: null, sessionId: null, account: null, saved: null, canRemember: false, reconnecting: false, reconnectError: null },
};
const windows: { main: BrowserWindow | null; mini: BrowserWindow | null } = { main: null, mini: null };
let tray: Tray | null = null;
let media: MediaSession | null = null;
let host: ChildProcess | null = null;
const retiredHosts = new WeakSet<ChildProcess>();
const unresponsiveHosts = new WeakSet<ChildProcess>();
const terminations = new WeakMap<ChildProcess, Promise<void>>();
const unresponsiveError = 'Audio engine is not responding. Restart the engine.';
let hostResources = { cpuPercent: 0, memoryMB: 0 };
let server: SubsonicClient | null = null;
let sequence = 0;
let ipcCount = 0;
let messages = 0;
let bytes = 0;
let quitting = false;
let config: ReturnType<typeof startConfigFolder> | null = null;
let extensions: ReturnType<typeof startExtensions> | null = null;
const pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
const semaphores = {
  audio: Effect.runSync(Effect.makeSemaphore(1)),
  server: Effect.runSync(Effect.makeSemaphore(1)),
  dialog: Effect.runSync(Effect.makeSemaphore(1)),
  // Library reads may overlap each other; session checks guard every result.
  library: Effect.runSync(Effect.makeSemaphore(4)),
  art: Effect.runSync(Effect.makeSemaphore(6)),
  settings: Effect.runSync(Effect.makeSemaphore(1)),
  window: Effect.runSync(Effect.makeSemaphore(1)),
  // Background play reports and queue saves. They never hold a renderer-facing permit.
  sync: Effect.runSync(Effect.makeSemaphore(2)),
};
let connectionGeneration = 0;
// Library tracks the renderer may queue by ID. Bounded; re-inserting on use keeps recent entries.
const knownTracks = new Map<string, Track>();
// Created at ready, once userData is final. Reads fall back to defaults until loaded.
let settings = new JsonStore('', SettingsFileSchema, defaultSettings());
let windowState = new JsonStore('', WindowStateSchema, {});
let account = new Account('', safeStorage);
// Repeat and shuffle, as last chosen. The audio host owns them while it runs (they're in its
// snapshots); this copy survives restarts and starts the next host with them.
let playModes = new JsonStore('', PlayModesSchema, defaultPlayModes());
const updates = new Updates(() => state.update, next => { state.update = next; broadcast(); }, () => settings.value.checkForUpdates);
const plays = new PlayTracker();
// Quit clears the session at once, but the final queue save (possibly queued behind a save
// still in flight) belongs to the session that was current when quit began.
let finalSession: { generation: number; client: SubsonicClient } | null = null;
const queueSync = new QueueSync((saved, generation) => {
  const client = generation === connectionGeneration ? server : generation === finalSession?.generation ? finalSession.client : null;
  if (!client || !settings.value.syncQueue) return Promise.resolve();
  return Effect.runPromise(metrics.measure('sync.save-queue', semaphores.sync.withPermits(1)(client.saveQueue(saved.trackIds, saved.currentIndex, saved.positionSeconds))));
});
function rememberTracks(tracks: readonly Track[]) {
  for (const track of tracks) {
    knownTracks.delete(track.id); knownTracks.set(track.id, track);
    if (knownTracks.size > 20_000) knownTracks.delete(knownTracks.keys().next().value!);
  }
}

// Radio keeps going while every window is hidden: top-ups follow host snapshots, not the renderer.
const radio = new Radio<SubsonicClient>({
  client: () => server, player: () => state.player, known: id => knownTracks.get(id), remember: rememberTracks,
  replace: (client, tracks) => send({ type: 'queue', tracks: tracks.map(track => client.playable(track)), ordered: true }),
  follow: (client, tracks) => send({ type: 'queue-clear' }).pipe(Effect.zipRight(send({ type: 'queue-add', tracks: tracks.map(track => client.playable(track)), where: 'end' }))),
  append: (client, tracks) => send({ type: 'queue-add', tracks: tracks.map(track => client.playable(track)), where: 'end' }),
  // Already one request at a time, so it never takes a sync permit from the final queue save.
  background: task => Effect.runPromise(Effect.either(metrics.measure('sync.radio-top-up', task))),
  changed: () => { state.player = { ...state.player, radio: radio.view }; },
}, QUEUE_LIMIT);
// Starting any other playback, or losing the engine or session, ends radio. The queue stays.
const endRadio = () => radio.end();

// Must precede app ready. Covers are fetched here so server credentials never reach the renderer.
// CORS lets the renderer read cover pixels on a canvas for its palette.
// squiggly-ext serves extension renderer modules (see extensions/electron.ts).
protocol.registerSchemesAsPrivileged([{ scheme: 'squiggly-art', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }, extensionScheme]);
async function serveCover(request: Request): Promise<Response> {
  const cors = { 'access-control-allow-origin': '*' };
  const missing = () => new Response(null, { status: 404, headers: cors });
  try {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.hostname !== 'cover') return missing();
    const id = Schema.decodeUnknownEither(IdSchema)(decodeURIComponent(url.pathname.slice(1)));
    if (Either.isLeft(id)) return missing();
    const cover = await coverBytes(id.right, Number(url.searchParams.get('size') ?? 300));
    if (!cover) return missing();
    return new Response(cover.bytes, { headers: {
      ...cors, 'content-type': cover.contentType, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff',
    } });
  } catch { return missing(); }
}
// A cover's bytes. A local file's (localFiles.ts) is scaled down to the size asked for, since
// embedded pictures are often several thousand pixels across; the server scales its own.
async function coverBytes(id: string, requested: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string } | null> {
  const size = Math.min(1200, Math.max(32, Math.round(requested) || 300));
  if (isLocalCover(id)) {
    const cover = await semaphores.art.withPermits(1)(Effect.promise(() => readLocalCover(id))).pipe(Effect.runPromise);
    if (!cover) return null;
    const image = nativeImage.createFromBuffer(cover.bytes);
    if (image.isEmpty() || image.getSize().width <= size) return { bytes: new Uint8Array(cover.bytes), contentType: cover.contentType };
    return { bytes: new Uint8Array(image.resize({ width: size, quality: 'best' }).toJPEG(90)), contentType: 'image/jpeg' };
  }
  const client = server;
  if (!client) return null;
  const result = await Effect.runPromise(Effect.either(semaphores.art.withPermits(1)(client.coverArt(id, size))));
  return Either.isRight(result) && server === client ? result.right : null;
}

const alive = (target: BrowserWindow | null): target is BrowserWindow => target !== null && !target.isDestroyed();
const appWindows = () => [windows.main, windows.mini].filter(alive);
// Hidden windows catch up when shown (see createWindow) instead of receiving 4 Hz updates, unless
// they asked to follow while hidden (the sleep timer waiting for the song to end).
const followingHidden = new WeakSet<WebContents>();
function broadcast() {
  for (const target of appWindows()) {
    if ((target.isVisible() || followingHidden.has(target.webContents)) && !target.webContents.isDestroyed()) target.webContents.send('squiggly:snapshot', state);
  }
}
// Background consumers of each native snapshot: tray, OS media controls, play reports, queue sync.
function observePlayer() {
  const player = state.player;
  updateTray(); updateMedia(); updateSystemMedia(); void radio.topUp();
  queueSync.observe(player, connectionGeneration, settings.value.syncQueue && server !== null);
  const events = plays.update(player, performance.now());
  if (settings.value.reportPlays) for (const event of events) reportPlay(event);
}
// Silent by design: failures appear only in operation metrics.
function reportPlay({ trackId, event }: PlayEvent) {
  const client = server;
  if (!client) return;
  void Effect.runPromise(Effect.either(metrics.measure(`sync.play-${event}`, semaphores.sync.withPermits(1)(client.reportPlay(trackId, event)))));
}
// Per-session state that must not carry across an account switch or disconnect.
function resetSessionState() {
  queueSync.reset(); plays.reset(); savedSong = null;
  artRequest = null;
  if (art) void rm(art.path, { force: true }).catch(() => undefined);
  art = null;
}
function rejectPending(message: string) {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
  pending.clear();
}
function terminateHost(child: ChildProcess): Promise<void> {
  const existing = terminations.get(child);
  if (existing) return existing;
  retiredHosts.add(child);
  const termination = new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) { resolve(); return; }
    let timer: ReturnType<typeof setTimeout>;
    const onExit = () => { clearTimeout(timer); resolve(); };
    const fail = () => {
      clearTimeout(timer); child.off('exit', onExit);
      reject(new Error('Audio process did not exit. Close the app before trying again.'));
    };
    child.once('exit', onExit);
    timer = setTimeout(() => {
      // Native calls can block the host's JavaScript SIGTERM handler.
      timer = setTimeout(fail, 2500);
      try { child.kill('SIGKILL'); } catch { fail(); }
    }, 2500);
    try { child.kill('SIGTERM'); } catch { fail(); }
  }).then(() => {
    if (host === child) host = null;
  }, error => {
    // Keep the child reference and permit another cleanup attempt, never spawn over it.
    terminations.delete(child);
    throw error;
  });
  terminations.set(child, termination);
  return termination;
}
// Packaged builds ship the audio-host runtime under resources/runtime. Environment overrides still win.
function bundledRuntime(file: string) {
  if (!app.isPackaged) return undefined;
  const path = join(process.resourcesPath, 'runtime', file);
  return existsSync(path) ? path : undefined;
}
async function launchPlayer() {
  const previous = host;
  rejectPending('Audio engine restarted.');
  if (previous) await terminateHost(previous);
  if (quitting) return;
  endRadio(); state.player = emptyPlayer();
  // Packaged builds keep the app in app.asar, which the bundled Node can't read; the audio host
  // and its imports are unpacked beside it (see asarUnpack in electron-builder.yml).
  const hostDirectory = directory.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
  const child = fork(join(hostDirectory, 'player.js'), [], {
    execPath: process.env.SQUIGGLY_NODE_PATH || bundledRuntime(process.platform === 'win32' ? 'node.exe' : 'node') || 'node',
    env: {
      ...process.env, SQUIGGLY_LIBMPV_PATH: process.env.SQUIGGLY_LIBMPV_PATH || bundledRuntime('libmpv-2.dll'),
      SQUIGGLY_AUDIO_EXCLUSIVE: settings.value.exclusiveOutput ? '1' : '0',
      SQUIGGLY_AUDIO_DEVICE: settings.value.outputDevice,
      SQUIGGLY_REPEAT: playModes.value.repeat, SQUIGGLY_SHUFFLE: playModes.value.shuffle ? '1' : '0',
    },
    execArgv: [], windowsHide: true,
    stdio: ['ignore', 'ignore', process.env.SQUIGGLY_SMOKE_TEST === '1' ? 'pipe' : 'ignore', 'ipc'],
  });
  if (process.env.SQUIGGLY_SMOKE_TEST === '1') child.stderr?.on('data', data => process.stderr.write(data));
  host = child;
  child.on('message', (message: HostMessage) => {
    if (host !== child || retiredHosts.has(child) || unresponsiveHosts.has(child)) return;
    messages++; bytes += Buffer.byteLength(JSON.stringify(message));
    if (message.type === 'snapshot') {
      state.player = { ...message.player, radio: radio.view }; hostResources = message.resources; broadcast(); observePlayer();
      if (message.player.engine === 'crashed') {
        // The host publishes its reason before native teardown. Enforce a bound
        // here because mpv_terminate_destroy may block inside the child.
        void terminateHost(child).catch(() => undefined);
      }
    } else {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error)); else request.resolve();
    }
  });
  child.on('exit', code => {
    if (process.env.SQUIGGLY_SMOKE_TEST === '1') console.error('Audio process exit code:', code);
    if (host !== child || retiredHosts.has(child) || quitting) return;
    host = null;
    rejectPending('Audio process exited.'); endRadio();
    state.player.engine = 'crashed'; state.player.playing = false;
    state.player.error = 'The audio process exited. Restart the audio engine to continue.';
    broadcast(); observePlayer();
  });
  child.on('error', () => {
    if (host !== child || retiredHosts.has(child) || quitting) return;
    retiredHosts.add(child); rejectPending('Audio host could not start.'); endRadio();
    state.player.engine = 'unavailable'; state.player.playing = false;
    state.player.error = 'Could not start the Node audio host. Install Node 22.16+ or set SQUIGGLY_NODE_PATH to its executable.';
    broadcast(); observePlayer();
  });
  broadcast();
}

function send(action: HostRequest['action']) {
  return Effect.tryPromise({
    try: () => new Promise<void>((resolve, reject) => {
      const child = host;
      if (child && unresponsiveHosts.has(child)) return reject(new Error(unresponsiveError));
      if (!child || retiredHosts.has(child) || quitting) return reject(new Error('Audio process is not running. Restart the audio engine.'));
      const id = ++sequence;
      const timer = setTimeout(() => {
        unresponsiveHosts.add(child);
        state.player.engine = 'unavailable'; state.player.playing = false;
        state.player.error = unresponsiveError;
        rejectPending(unresponsiveError); broadcast();
      }, 8000);
      pending.set(id, { resolve, reject, timer });
      try { child.send({ id, action } satisfies HostRequest, error => {
        if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(new Error('Could not reach the audio process.')); }
      }); }
      catch { clearTimeout(timer); pending.delete(id); reject(new Error('Could not reach the audio process.')); }
    }),
    catch: error => error instanceof Error ? error : new Error('Audio command failed.'),
  });
}

// Transport from the tray, media keys, and MPRIS. Failures surface through the player snapshot.
// Bounded, so a client dragging an MPRIS position slider cannot queue unlimited seeks.
let shellPending = 0;
function transport(action: HostRequest['action']) {
  if (shellPending >= 8) return;
  shellPending++;
  void Effect.runPromise(Effect.either(metrics.measure('shell.command', semaphores.audio.withPermits(1)(send(action)))))
    .then(() => { shellPending--; broadcast(); });
}
// Repeat and shuffle, from a window, MPRIS, or radio starting. The host applies the mode, then it
// is saved for the next launch. Radio keeps topping up the queue, which doesn't sit well with
// repeating it, so the two exclude each other: turning repeat on (all or one) stops radio, and
// starting radio turns repeat off (see radio:start).
function setPlayMode(command: Extract<PlayerCommand, { type: 'repeat' | 'shuffle' }>) {
  return Effect.gen(function* () {
    yield* send(command);
    if (command.type === 'repeat' && command.mode !== 'off') endRadio();
    const next = command.type === 'repeat' ? { ...playModes.value, repeat: command.mode } : { ...playModes.value, shuffle: command.on };
    // A mode that couldn't be saved still holds until the app closes.
    yield* Effect.promise(() => playModes.save(next).catch(() => undefined));
  });
}
// MPRIS's LoopStatus and Shuffle, on the audio lane like the window's commands.
function shellPlayMode(command: Extract<PlayerCommand, { type: 'repeat' | 'shuffle' }>) {
  void Effect.runPromise(Effect.either(metrics.measure('shell.play-mode', semaphores.audio.withPermits(1)(setPlayMode(command))))).then(broadcast);
}
// Loads the server-saved queue at its song and position, paused or playing.
function resumeSaved(paused: boolean) {
  return Effect.gen(function* () {
    if (!server) return yield* Effect.fail(new Error('Connect to a server first.'));
    const client = server;
    const saved = yield* client.savedQueue();
    if (server !== client) return yield* Effect.fail(new Error('Server session changed. Try again.'));
    if (!saved || !saved.tracks.length) return yield* Effect.fail(new Error('There is no saved queue on this server.'));
    if (saved.tracks.length > QUEUE_LIMIT) return yield* Effect.fail(new Error(`The saved queue has more than ${QUEUE_LIMIT.toLocaleString('en-US')} songs.`));
    rememberTracks(saved.tracks);
    const currentIndex = Math.min(Math.max(0, Math.trunc(saved.currentIndex) || 0), saved.tracks.length - 1);
    const positionSeconds = Number.isFinite(saved.positionSeconds) ? Math.max(0, saved.positionSeconds) : 0;
    endRadio();
    yield* send({ type: 'queue', tracks: saved.tracks.map(track => client.playable(track)), startIndex: currentIndex, startPosition: positionSeconds, paused, ordered: true });
    queueSync.markSaved({ trackIds: saved.tracks.map(track => track.id), currentIndex, positionSeconds: Math.floor(positionSeconds) });
  });
}
// Play from a media key, MPRIS, or the tray. With nothing loaded, the queue saved on the server
// (when queue sync is on) starts where it left off, so a play key works right after launch.
const canResume = () => state.player.engine === 'ready' && !state.player.queue.length && server !== null && settings.value.syncQueue;
function shellPlay() {
  if (!canResume()) { transport({ type: 'play' }); return; }
  const generation = connectionGeneration;
  const resume = Effect.suspend(() => generation === connectionGeneration && canResume() ? resumeSaved(false) : Effect.void);
  void Effect.runPromise(Effect.either(metrics.measure('shell.resume', semaphores.server.withPermits(1)(resume)))).then(broadcast);
}
// Connects to a server, replacing any current one. Stops playback and clears every authenticated
// URL before replacing the account, while keeping the audio engine's volume and output device.
function connectTo(typed: Connection, generation: number) {
  return Effect.gen(function* () {
    if (generation !== connectionGeneration || quitting) return yield* Effect.fail(new Error('Connection canceled.'));
    const connection = yield* resolveAddress(typed);
    // The address check's own message (a bad address says how), not Effect's generic one.
    const candidate = yield* Effect.try({ try: () => new SubsonicClient(connection, metrics), catch: error => error instanceof Error ? error : new Error('Check the server address.') });
    const info = yield* candidate.ping();
    if (generation !== connectionGeneration || quitting) return yield* Effect.fail(new Error('Connection canceled.'));
    endRadio();
    if (server) yield* send({ type: 'clear-session' });
    server = candidate; knownTracks.clear();
    connectionGeneration++; resetSessionState();
    // A plain HTTP server is named with its scheme, since nothing sent to it is encrypted.
    const address = new URL(candidate.baseUrl);
    state.server = { ...state.server, connected: true, name: `${info.name} (${address.protocol === 'http:' ? 'http://' : ''}${address.host})`, sessionId: randomUUID(), account: `${candidate.baseUrl}\n${connection.username}`, reconnectError: null };
    // Play in the tray, MPRIS, and the system media controls can now resume the saved queue.
    updateTray(); updateMedia(); void loadSavedSong(candidate);
    return connection;
  });
}
// HTTPS, then HTTP, for an address typed without a scheme (resolveServerAddress in the connector).
const resolveAddress = (connection: Connection) => resolveServerAddress(connection, candidate => new SubsonicClient(candidate, metrics));
// At launch, with a saved sign-in. A failure leaves the connect screen filled in, with the reason.
async function reconnect() {
  const connection = account.connection();
  if (!connection) return;
  state.server = { ...state.server, reconnecting: true }; broadcast();
  const generation = connectionGeneration;
  const result = await Effect.runPromise(Effect.either(metrics.measure('shell.reconnect', semaphores.server.withPermits(1)(connectTo(connection, generation)))));
  const reconnectError = Either.isLeft(result) && !state.server.connected ? (result.left instanceof Error ? result.left.message : 'Could not connect.') : null;
  state.server = { ...state.server, reconnecting: false, reconnectError };
  broadcast();
}
function seekTo(seconds: number) {
  const index = state.player.currentIndex; const track = state.player.queue[index];
  const entryId = state.player.entryIds[index];
  if (track && Number.isFinite(seconds)) transport({ type: 'seek', seconds: Math.max(0, seconds), queueIndex: index, trackId: track.id, ...(entryId ? { entryId } : {}) });
}

function assertSender(event: IpcMainInvokeEvent) {
  const trusted = appWindows().some(target => event.sender === target.webContents && event.senderFrame === target.webContents.mainFrame);
  if (!trusted) throw new Error('Untrusted IPC sender.');
}
function handle<A>(channel: string, task: (value: unknown, generation: number) => Effect.Effect<A, unknown>, lane: keyof typeof semaphores = 'audio') {
  ipcMain.handle(`squiggly:${channel}`, async (event, value): Promise<Result<A>> => {
    assertSender(event);
    ipcCount++;
    if (ipcCount > 32) { ipcCount--; return { ok: false, error: 'Too many pending operations. Try again shortly.' }; }
    state.diagnostics.ipcCommands++;
    const generation = connectionGeneration;
    try {
      const program = Effect.suspend(() => {
        // Requests queued before a disconnect or account switch must not run
        // against a later session, even when the album IDs happen to match.
        if ((['connect', 'play-tracks', 'queue:add', 'resume-queue', 'radio:start'].includes(channel) || channel.startsWith('library:')) && generation !== connectionGeneration) {
          return Effect.fail(new Error('Server session changed. Try again.'));
        }
        return task(value, generation);
      });
      const result = await Effect.runPromise(Effect.either(metrics.measure(`ipc.${channel}`, semaphores[lane].withPermits(1)(program))));
      if (Either.isLeft(result)) return { ok: false, error: result.left instanceof Error ? result.left.message : 'Operation failed.' };
      return { ok: true, value: result.right };
    } catch { return { ok: false, error: 'Invalid request or unexpected desktop error.' }; }
    finally { ipcCount--; broadcast(); }
  });
}

function installHandlers() {
  ipcMain.handle('squiggly:get-snapshot', event => { assertSender(event); return state; });
  handle('command', value => Effect.gen(function* () {
    const command = yield* Schema.decodeUnknown(CommandSchema)(value).pipe(Effect.mapError(() => new Error('Invalid player command.')));
    if (command.type === 'restart') { yield* Effect.tryPromise(() => launchPlayer()); return; }
    // Play with nothing loaded (the system media controls after launch) resumes the saved queue.
    if (command.type === 'play' && canResume()) { yield* resumeSaved(false); return; }
    if (command.type === 'repeat' || command.type === 'shuffle') { yield* setPlayMode(command); return; }
    yield* send(command);
  }));
  handle('open-files', () => Effect.gen(function* () {
    const result = yield* Effect.promise(() => dialog.showOpenDialog(dialogParent(), {
      title: 'Add music', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: [...AUDIO_EXTENSIONS] }],
    }));
    if (result.canceled) return;
    if (result.filePaths.length > QUEUE_LIMIT) return yield* Effect.fail(new Error(`Choose up to ${QUEUE_LIMIT.toLocaleString('en-US')} files at a time.`));
    // Titles, artists, and covers from the files' own tags (localFiles.ts).
    const read = yield* Effect.promise(() => readLocalTracks(result.filePaths));
    const tracks: PlayableTrack[] = result.filePaths.map((path, i) => ({ location: path, track: read[i] }));
    endRadio();
    yield* send({ type: 'queue', tracks });
  }), 'dialog');
  // Files dropped on the window. The preload sends their paths ('' for one with none), which
  // never reach the page; they are checked here as Open files limits its dialog: audio
  // extensions, regular files, up to a full queue. Folders aren't walked. `queue` adds them to
  // the end when something is loaded.
  handle('open-paths', value => Effect.gen(function* () {
    if (Array.isArray(value) && Array.isArray(value[0]) && value[0].length > QUEUE_LIMIT) return yield* Effect.fail(new Error(`Drop up to ${QUEUE_LIMIT.toLocaleString('en-US')} files at a time.`));
    const [paths, mode] = yield* Schema.decodeUnknown(OpenPathsSchema)(value).pipe(Effect.mapError(() => new Error('Those files could not be opened.')));
    const { files, skipped } = yield* Effect.promise(() => checkAudioPaths(paths));
    if (!files.length) return yield* Effect.fail(new Error('Nothing dropped could be played. Drop audio files, such as FLAC, WAV, or MP3; folders aren’t opened.'));
    const read = yield* Effect.promise(() => readLocalTracks(files));
    const tracks: PlayableTrack[] = files.map((path, i) => ({ location: path, track: read[i] }));
    if (mode === 'queue' && state.player.queue.length) yield* send({ type: 'queue-add', tracks, where: 'end' });
    else { endRadio(); yield* send({ type: 'queue', tracks }); }
    return { opened: files.length, skipped };
  }), 'dialog');
  handle('connect', (value, generation) => Effect.gen(function* () {
    const connection = yield* Schema.decodeUnknown(ConnectionSchema)(value).pipe(Effect.mapError(() => new Error('Enter a valid server address, username, and password.')));
    const resolved = yield* connectTo(connection, generation);
    // A sign-in that can't be saved securely stays in memory for this session (account.ts).
    yield* Effect.promise(() => account.remember(resolved).catch(() => undefined));
    state.server = { ...state.server, saved: account.saved };
  }), 'server');
  for (const method of libraryMethods) handle(`library:${method}`, value => Effect.gen(function* () {
    if (!server) return yield* Effect.fail(new Error('Connect to a server first.'));
    // The main process reports plays and saves the queue itself; renderer calls still honor the settings.
    if (method === 'reportPlay' && !settings.value.reportPlays) return yield* Effect.fail(new Error('Play reporting is turned off in Settings.'));
    if ((method === 'saveQueue' || method === 'savedQueue') && !settings.value.syncQueue) return yield* Effect.fail(new Error('Queue sync is turned off in Settings.'));
    const client = server;
    // LRCLIB is a third party. Contact it only when both the caller and the stored setting allow it.
    const args = method === 'lyrics' && Array.isArray(value) ? [value[0], value[1] === true && settings.value.lyricsLookup] : value;
    const result = yield* libraryCall(client, method, args);
    if (server !== client) return yield* Effect.fail(new Error('Server session changed. Refresh the library.'));
    rememberTracks(result.tracks);
    return result.value;
  }), 'library');
  handle('play-tracks', value => Effect.gen(function* () {
    const [ids, startIndex] = yield* Schema.decodeUnknown(PlayTracksSchema)(value).pipe(Effect.mapError(() => new Error('Invalid track selection.')));
    if (startIndex >= ids.length) return yield* Effect.fail(new Error('Invalid track selection.'));
    if (!server) return yield* Effect.fail(new Error('Connect to a server first.'));
    const client = server;
    const tracks: PlayableTrack[] = [];
    for (const id of ids) {
      const track = knownTracks.get(id);
      if (!track) return yield* Effect.fail(new Error('Some tracks are no longer loaded. Refresh the library and try again.'));
      tracks.push(client.playable(track));
    }
    rememberTracks(tracks.map(item => item.track));
    endRadio();
    yield* send({ type: 'queue', tracks, startIndex });
  }), 'server');
  handle('queue:add', value => Effect.gen(function* () {
    const [ids, where] = yield* Schema.decodeUnknown(QueueAddSchema)(value).pipe(Effect.mapError(() => new Error('Invalid track selection.')));
    if (!server) return yield* Effect.fail(new Error('Connect to a server first.'));
    const client = server;
    const tracks: PlayableTrack[] = [];
    for (const id of ids) {
      const track = knownTracks.get(id);
      if (!track) return yield* Effect.fail(new Error('Some tracks are no longer loaded. Refresh the library and try again.'));
      tracks.push(client.playable(track));
    }
    rememberTracks(tracks.map(item => item.track));
    yield* send({ type: 'queue-add', tracks, where });
  }), 'server');
  handle('queue:move', value => Effect.gen(function* () {
    const [from, to] = yield* Schema.decodeUnknown(QueueMoveSchema)(value).pipe(Effect.mapError(() => new Error('Invalid queue position.')));
    yield* send({ type: 'queue-move', from, to });
  }));
  handle('queue:remove', value => Effect.gen(function* () {
    const [indexes] = yield* Schema.decodeUnknown(QueueRemoveSchema)(value).pipe(Effect.mapError(() => new Error('Invalid queue position.')));
    yield* send({ type: 'queue-remove', indexes: [...indexes] });
  }));
  handle('queue:clear', () => Effect.suspend(() => { endRadio(); return send({ type: 'queue-clear' }); }));
  handle('queue:jump', value => Effect.gen(function* () {
    const [index, entryId] = yield* Schema.decodeUnknown(QueueJumpSchema)(value).pipe(Effect.mapError(() => new Error('Invalid queue position.')));
    yield* send({ type: 'queue-jump', index, entryId });
  }));
  handle('radio:start', value => Effect.gen(function* () {
    const seed = yield* Schema.decodeUnknown(RadioSeedSchema)(value).pipe(Effect.mapError(() => new Error('Invalid radio request.')));
    const began = yield* radio.start(seed);
    // Radio and repeat exclude each other (setPlayMode): a station turns repeat off. A start that
    // other playback overtook began no station, so repeat stays as it is.
    if (began && state.player.repeat !== 'off') yield* semaphores.audio.withPermits(1)(setPlayMode({ type: 'repeat', mode: 'off' }));
  }), 'library');
  handle('radio:stop', () => Effect.sync(endRadio), 'library');
  // Loads the server-saved queue paused at its song and position. Playback starts only on play.
  handle('resume-queue', () => resumeSaved(true), 'server');
  ipcMain.handle('squiggly:get-settings', event => { assertSender(event); return settings.value; });
  handle('update-settings', value => Effect.gen(function* () {
    const changes = yield* Schema.decodeUnknown(SettingsPatchSchema)(value, { onExcessProperty: 'error' }).pipe(Effect.mapError(() => new Error('Invalid settings.')));
    const previous = settings.value;
    const next = { ...previous, ...changes };
    // A running engine applies exclusive output now; a stopped one reads the saved value at start.
    const exclusiveChanged = next.exclusiveOutput !== previous.exclusiveOutput && host !== null && state.player.engine === 'ready';
    if (exclusiveChanged) yield* send({ type: 'exclusive', on: next.exclusiveOutput });
    // A running engine switches output now; a stopped one reads the saved device at start.
    const deviceChanged = next.outputDevice !== previous.outputDevice && host !== null && state.player.engine === 'ready';
    if (deviceChanged) yield* send({ type: 'device', id: next.outputDevice });
    yield* Effect.tryPromise({ try: () => settings.save(next), catch: () => new Error('Could not save settings. Check that the app data folder is writable.') }).pipe(
      Effect.tapError(() => exclusiveChanged ? Effect.ignore(send({ type: 'exclusive', on: previous.exclusiveOutput })) : Effect.void));
    if (!next.syncQueue) queueSync.reset();
    applyMiniOnTop(); applyMediaKeys(); updateTray(); updateMedia(); updateSystemMedia();
    if (next.checkForUpdates && !previous.checkForUpdates) updates.check();
    return settings.value;
  }), 'settings');
  handle('window:toggle-mini', () => Effect.sync(toggleMini), 'window');
  // The mini player's pin button. Stored as the miniOnTop setting, on the settings lane so it
  // cannot interleave with another settings write.
  handle('window:always-on-top', value => Effect.gen(function* () {
    const on = yield* Schema.decodeUnknown(Schema.Boolean)(value).pipe(Effect.mapError(() => new Error('Invalid window setting.')));
    const next: Settings = { ...settings.value, miniOnTop: on };
    yield* Effect.tryPromise({ try: () => settings.save(next), catch: () => new Error('Could not save the window setting.') });
    applyMiniOnTop();
  }), 'settings');
  // The main window's buttons take the room's ink as the palette changes.
  ipcMain.handle('squiggly:window:tint-controls', (event, value) => {
    assertSender(event);
    const target = BrowserWindow.fromWebContents(event.sender);
    const ink = Schema.decodeUnknownEither(Schema.String.pipe(Schema.pattern(/^#[0-9a-f]{6}$/i)))(value);
    if (!FRAMELESS || !target || target !== windows.main || Either.isLeft(ink)) return { ok: false, error: 'Invalid window colour.' };
    target.setTitleBarOverlay({ color: '#00000000', symbolColor: ink.right, height: CONTROLS_HEIGHT });
    return { ok: true, value: undefined };
  });
  ipcMain.handle('squiggly:window:follow-while-hidden', (event, value) => {
    assertSender(event);
    if (typeof value !== 'boolean') return { ok: false, error: 'Invalid window setting.' };
    if (value) followingHidden.add(event.sender); else followingHidden.delete(event.sender);
    return { ok: true, value: undefined };
  });
  // Updates (updates.ts): check now, restart into a downloaded update, or open the release page.
  handle('update:check', () => Effect.sync(() => updates.check(true)), 'window');
  handle('update:install', () => Effect.suspend(() => updates.installNow() ? Effect.void : Effect.fail(new Error('No update is ready to install.'))), 'window');
  handle('update:open', () => Effect.tryPromise({ try: () => shell.openExternal(updates.releaseUrl()), catch: () => new Error('Could not open the release page.') }), 'window');
  handle('disconnect', () => Effect.gen(function* () {
    // Restart also removes authenticated stream URLs from the player's native playlist.
    connectionGeneration++;
    server = null; knownTracks.clear(); resetSessionState();
    // Disconnecting also forgets the saved sign-in.
    yield* Effect.promise(() => account.forget().catch(() => undefined));
    state.server = { ...state.server, connected: false, name: null, sessionId: null, account: null, saved: account.saved, reconnectError: null };
    yield* Effect.tryPromise(() => launchPlayer());
  }));
  handle('export-diagnostics', () => Effect.gen(function* () {
    const result = yield* Effect.promise(() => dialog.showSaveDialog(dialogParent(), {
      defaultPath: 'squiggly-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }],
    }));
    if (result.canceled || !result.filePath) return;
    const report = {
      version: app.getVersion(), platform: process.platform, capturedAt: new Date().toISOString(),
      diagnostics: state.diagnostics, engine: state.player.engine, audio: state.player.audio,
      verification: 'OS mixer and physical DAC format are not verified. Bit-perfect output is not established.',
    };
    yield* Effect.tryPromise(() => writeFile(result.filePath!, JSON.stringify(report, null, 2), { mode: 0o600 }));
  }), 'dialog');
}

// Both windows load the same renderer with the same sandbox, isolation, and navigation limits.
// The mini player differs only in size, frame, and the argument its preload exposes as isMini.
// Windows and Linux: no title bar on the main window. The system's window buttons are drawn over
// the top of the page (window controls overlay), tinted to the room by tintControls. macOS keeps
// its title bar, since its window buttons would sit on the wordmark.
const FRAMELESS = process.platform !== 'darwin';
const CONTROLS_HEIGHT = 40;
function createWindow(mini: boolean) {
  const target = new BrowserWindow({
    ...(mini ? {
      ...miniBounds(), minWidth: 320, minHeight: 96, maxWidth: 900, maxHeight: 240,
      frame: false, maximizable: false, fullscreenable: false, show: false, alwaysOnTop: settings.value.miniOnTop,
    } : {
      width: 1440, height: 940, minWidth: 850, minHeight: 650,
      ...(FRAMELESS ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#00000000', symbolColor: '#1c1b18', height: CONTROLS_HEIGHT } } : {}),
    }),
    backgroundColor: '#181d25', title: 'Squiggly Music',
    ...(process.platform === 'linux' ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(directory, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      // The preload reads the config folder's path from here, so ConfigApi.dir is ready at once.
      // Only the main window, which lives as long as the app, hosts the system media session.
      additionalArguments: [
        ...(mini ? ['--squiggly-mini'] : process.platform !== 'linux' ? ['--squiggly-media-session'] : []),
        ...(!mini && FRAMELESS ? ['--squiggly-frameless'] : []),
        `--squiggly-config=${configDirectory()}`,
      ],
    },
  });
  target.setMenuBarVisibility(false);
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', event => event.preventDefault());
  target.on('show', () => { if (!target.webContents.isDestroyed()) target.webContents.send('squiggly:snapshot', state); });
  // A reloaded page starts with no sleep timer.
  target.webContents.on('did-start-loading', () => followingHidden.delete(target.webContents));
  if (process.env.ELECTRON_RENDERER_URL) void target.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void target.loadFile(join(directory, '../renderer/index.html'));
  return target;
}
function createMainWindow() {
  const main = windows.main = createWindow(false);
  // A freshly loaded window needs the current song for its media session.
  main.webContents.on('did-finish-load', () => { systemMediaKey = null; updateSystemMedia(); });
  main.webContents.once('did-finish-load', () => {
    state.diagnostics.startupMs ??= performance.now() - started; broadcast();
  });
  main.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    // Closing to the tray keeps playback running. Otherwise closing the main window quits,
    // even while a hidden mini player still exists.
    if (settings.value.closeToTray && tray) main.hide(); else app.quit();
  });
  main.on('closed', () => { if (windows.main === main) windows.main = null; });
  return main;
}
// Saved bounds are reused only while they still overlap a connected display. Wayland
// compositors do not let clients place windows, so only the size is restored there.
function miniBounds() {
  const saved = windowState.value.mini;
  if (!saved) return { width: 420, height: 112 };
  const area = screen.getDisplayMatching(saved).workArea;
  const visible = saved.x < area.x + area.width && saved.x + saved.width > area.x && saved.y < area.y + area.height && saved.y + saved.height > area.y;
  return visible ? saved : { width: saved.width, height: saved.height };
}
// The stored preference, applied at creation and whenever it changes.
function applyMiniOnTop() { if (alive(windows.mini)) windows.mini.setAlwaysOnTop(settings.value.miniOnTop, 'floating'); }
function createMiniWindow() {
  const mini = windows.mini = createWindow(true);
  applyMiniOnTop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remember = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!mini.isDestroyed()) void windowState.save({ ...windowState.value, mini: mini.getBounds() }).catch(() => undefined);
    }, 500);
  };
  mini.on('move', remember); mini.on('resize', remember);
  // Closing the mini player returns to the full window rather than quitting.
  mini.on('close', event => { if (quitting) return; event.preventDefault(); showMain(); });
  mini.on('closed', () => { clearTimeout(timer); if (windows.mini === mini) windows.mini = null; });
  return mini;
}
function showMain() {
  const main = alive(windows.main) ? windows.main : createMainWindow();
  if (main.isMinimized()) main.restore();
  main.show(); main.focus();
  if (alive(windows.mini)) windows.mini.hide();
}
function toggleMini() {
  if (alive(windows.mini) && windows.mini.isVisible()) { showMain(); return; }
  const mini = alive(windows.mini) ? windows.mini : createMiniWindow();
  mini.show();
  if (alive(windows.main)) windows.main.hide();
}
// Dialogs attach to the focused app window; with none, the main window is shown for them.
function dialogParent() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && appWindows().includes(focused)) return focused;
  showMain();
  return windows.main!;
}

let trayMenu = '';
function updateTray() {
  if (!tray) return;
  const playing = state.player.playing;
  const ready = state.player.engine === 'ready' && state.player.queue.length > 0;
  const resumable = canResume();
  // Rebuild only when a label or enabled state changes, not on every snapshot.
  if (trayMenu === `${playing}:${ready}:${resumable}`) return;
  trayMenu = `${playing}:${ready}:${resumable}`;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: playing ? 'Pause' : 'Play', enabled: ready || resumable, click: () => playing ? transport({ type: 'pause' }) : shellPlay() },
    { label: 'Next', enabled: ready, click: () => transport({ type: 'next' }) },
    { label: 'Previous', enabled: ready, click: () => transport({ type: 'previous' }) },
    { type: 'separator' },
    { label: 'Show Squiggly', click: showMain },
    { label: 'Mini player', click: toggleMini },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}
function createTray() {
  // nativeImage cannot rasterize SVG; assets/icon.png is rendered from renderer/public/icon.svg.
  const source = nativeImage.createFromPath(iconPath);
  if (source.isEmpty()) return;
  const size = process.platform === 'win32' ? 16 : 22;
  const image = nativeImage.createEmpty();
  for (const scaleFactor of [1, 1.5, 2]) {
    const pixels = Math.round(size * scaleFactor);
    image.addRepresentation({ scaleFactor, buffer: source.resize({ width: pixels, height: pixels, quality: 'best' }).toPNG() });
  }
  try { tray = new Tray(image); } catch { tray = null; return; }
  tray.setToolTip('Squiggly Music');
  tray.on('click', showMain);
  updateTray();
}

// Linux: MPRIS. Its cover is a private temporary copy, since artUrl must not carry credentials.
// Windows and macOS use Chromium's media session instead (updateSystemMedia, systemMedia.ts).
let artDirectory: string | null = null;
let art: { coverArt: string; path: string } | null = null;
let artRequest: string | null = null;
let artFiles = 0;
function updateMedia() {
  if (!media) return;
  const track = state.player.queue[state.player.currentIndex];
  const coverArt = state.player.engine === 'ready' ? track?.coverArt ?? null : null;
  if (coverArt && art?.coverArt !== coverArt && artRequest !== coverArt && (server || isLocalCover(coverArt)) && artDirectory) void fetchArt(coverArt, artDirectory);
  media.update(state.player, coverArt && art?.coverArt === coverArt ? pathToFileURL(art.path).href : null, canResume());
}
async function fetchArt(coverArt: string, directory: string) {
  artRequest = coverArt;
  // A server's cover belongs to that session; a local one to no session.
  const client = isLocalCover(coverArt) ? null : server;
  const stale = () => artRequest !== coverArt || (client !== null && server !== client);
  const cover = await metrics.measure('shell.media-art', Effect.promise(() => coverBytes(coverArt, 512))).pipe(Effect.runPromise);
  if (!cover || stale()) return;
  const extension = cover.contentType.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'img';
  const path = join(directory, `cover-${++artFiles}.${extension}`);
  try { await writeFile(path, cover.bytes, { mode: 0o600 }); } catch { return; }
  if (stale()) { void rm(path, { force: true }).catch(() => undefined); return; }
  const previous = art; art = { coverArt, path };
  if (previous) void rm(previous.path, { force: true }).catch(() => undefined);
  updateMedia();
}
// Windows media keys, taken directly only with exclusive output, when there is no media session
// (see updateSystemMedia). Otherwise Windows routes them to the session. Registering a media key
// here also switches off Chromium's own media key handling, which the session needs, so the two
// never overlap. Registration fails when another application owns a key; that key then stays
// with that application.
const mediaKeys: Record<string, () => void> = {
  MediaPlayPause: () => state.player.playing ? transport({ type: 'pause' }) : shellPlay(),
  MediaNextTrack: () => transport({ type: 'next' }), MediaPreviousTrack: () => transport({ type: 'previous' }),
  MediaStop: () => transport({ type: 'stop' }),
};
let mediaKeysHeld = false;
function applyMediaKeys() {
  if (process.platform !== 'win32') return;
  const want = settings.value.exclusiveOutput && !quitting;
  if (want === mediaKeysHeld) return;
  mediaKeysHeld = want;
  for (const [accelerator, run] of Object.entries(mediaKeys)) {
    if (!want) { globalShortcut.unregister(accelerator); continue; }
    try { if (!globalShortcut.register(accelerator, run)) metrics.record('shell.media-key-unavailable', 0, true); }
    catch { metrics.record('shell.media-key-unavailable', 0, true); }
  }
}
// Windows and macOS: what the main window's media session shows (systemMedia.ts). Sent only on a
// change of song or state, or a jump in position, and whether or not the window is visible. With
// exclusive output, the session's silent stream would contend with mpv for the device, so there is
// no session and the media keys come here instead. With nothing loaded, the session shows the song
// saved on the server, paused, so a play key right after connecting resumes it.
let savedSong: { track: Track; position: number } | null = null;
async function loadSavedSong(client: SubsonicClient) {
  savedSong = null;
  if (process.platform === 'linux' || !settings.value.syncQueue) return;
  const saved = await Effect.runPromise(Effect.either(metrics.measure('shell.saved-song', semaphores.sync.withPermits(1)(client.savedQueue()))));
  if (Either.isLeft(saved) || !saved.right?.tracks.length || server !== client) return;
  const track = saved.right.tracks[Math.min(Math.max(0, Math.trunc(saved.right.currentIndex) || 0), saved.right.tracks.length - 1)];
  savedSong = { track, position: Number.isFinite(saved.right.positionSeconds) ? Math.max(0, saved.right.positionSeconds) : 0 };
  updateSystemMedia();
}
let systemMediaKey: string | null = null;
let systemMediaClock = { position: 0, at: 0, playing: false };
function updateSystemMedia() {
  const target = windows.main;
  if (process.platform === 'linux' || !alive(target) || target.webContents.isDestroyed()) return;
  const p = state.player;
  const exclusive = settings.value.exclusiveOutput || p.audio.exclusiveRequested === true;
  const saved = canResume() && savedSong ? savedSong : null;
  const track = p.engine === 'ready' && !exclusive ? p.queue[p.currentIndex] ?? saved?.track : undefined;
  const entryId = saved ? 'saved' : p.entryIds[p.currentIndex];
  const now = performance.now();
  const next: SystemMediaState | null = track && entryId ? {
    index: saved ? -1 : p.currentIndex, entryId, trackId: track.id, title: track.title, artist: track.artist, album: track.album,
    coverArt: track.coverArt ?? null,
    duration: saved ? track.duration ?? 0 : p.duration > 0 ? p.duration : track.duration ?? 0,
    position: saved ? saved.position : p.position, playing: saved ? false : p.playing,
  } : null;
  const expected = systemMediaClock.position + (systemMediaClock.playing ? (now - systemMediaClock.at) / 1000 : 0);
  const key = next ? JSON.stringify({ ...next, position: 0 }) : '';
  if (key === systemMediaKey && (!next || Math.abs(next.position - expected) <= 1.5)) return;
  systemMediaKey = key;
  systemMediaClock = { position: next?.position ?? 0, at: now, playing: next?.playing ?? false };
  target.webContents.send('squiggly:media', next);
}
function startMediaControls() {
  if (process.platform === 'linux') {
    try { artDirectory = mkdtempSync(join(app.getPath('temp'), 'squiggly-art-')); } catch { artDirectory = null; }
    void startMpris({
      command: type => type === 'play' ? shellPlay() : transport({ type }), seek: seekTo, volume: percent => transport({ type: 'volume', percent }),
      raise: showMain, quit: () => app.quit(),
      repeat: mode => shellPlayMode({ type: 'repeat', mode }), shuffle: on => shellPlayMode({ type: 'shuffle', on }),
    }, () => { media = null; metrics.record('shell.mpris-unavailable', 0, true); }).then(session => { media = session; updateMedia(); });
  }
  applyMediaKeys();
}

if (primary) app.on('second-instance', () => showMain());
app.whenReady().then(async () => {
  if (!primary) return;
  app.setName('Squiggly Music');
  ensurePortableShortcut();
  const userData = app.getPath('userData');
  settings = new JsonStore(join(userData, 'settings.json'), SettingsFileSchema, defaultSettings());
  windowState = new JsonStore(join(userData, 'window-state.json'), WindowStateSchema, {});
  account = new Account(join(userData, 'account.json'), safeStorage);
  await Promise.all([settings.load(), windowState.load(), account.load()]);
  playModes = new JsonStore(join(userData, 'play-modes.json'), PlayModesSchema, playModes.value);
  await playModes.load();
  state.server = { ...state.server, saved: account.saved, canRemember: account.canRemember };
  installHandlers(); loop.enable();
  const windowContents = () => appWindows().map(target => target.webContents);
  config = startConfigFolder({ assertSender, windows: windowContents });
  extensions = startExtensions({ configDir: config.dir, assertSender, windows: windowContents });
  protocol.handle('squiggly-art', serveCover);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  createMainWindow();
  createTray();
  startMediaControls();
  void reconnect();
  updates.start();
  await launchPlayer();
  let sampledAt = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(); const seconds = (now - sampledAt) / 1000; sampledAt = now;
    state.diagnostics = {
      ...state.diagnostics, uptimeSeconds: (now - started) / 1000,
      playerMessagesPerSecond: messages / seconds, playerBytesPerSecond: bytes / seconds,
      pendingCommands: ipcCount, eventLoopDelayMs: Number.isFinite(loop.mean) ? loop.mean / 1e6 : 0,
      processes: [...app.getAppMetrics().map(metric => ({
        name: metric.name ?? metric.type, cpuPercent: metric.cpu.percentCPUUsage,
        memoryMB: metric.memory.workingSetSize / 1024,
      })), ...(host ? [{ name: 'Native audio host', ...hostResources }] : [])],
      operations: metrics.snapshot(),
    };
    messages = 0; bytes = 0; loop.reset(); broadcast();
  }, 1000);
  app.on('before-quit', event => {
    event.preventDefault();
    if (quitting) return;
    // A downloaded update installs as the app quits (updates.ts); the rest of the quit goes on.
    updates.installOnQuit(); updates.stop();
    // Starts the final queue save while the session is still current. Waits at most 1.5 s.
    const saved = settings.value.syncQueue ? queueSync.flush() : Promise.resolve();
    if (server) finalSession = { generation: connectionGeneration, client: server };
    quitting = true; connectionGeneration++; endRadio();
    server = null; knownTracks.clear(); clearInterval(timer); loop.disable(); rejectPending('Application closing.');
    globalShortcut.unregisterAll(); tray?.destroy(); tray = null; media = null;
    if (artDirectory) try { rmSync(artDirectory, { recursive: true, force: true }); } catch { /* Temporary files only. */ }
    const bounded = Promise.race([saved.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 1500))]);
    // Also covers a cleanup already in progress during a restart or disconnect.
    const stopped = host ? terminateHost(host) : Promise.resolve();
    config?.close();
    const closed = extensions?.close().catch(() => undefined);
    void Promise.all([bounded, stopped, closed]).then(() => app.exit(0), () => app.exit(1));
  });
});
app.on('window-all-closed', () => app.quit());

// Keep this export type checked against the public command contract.
export type { PlayerCommand };
