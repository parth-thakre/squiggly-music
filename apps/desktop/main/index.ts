/// <reference types="electron-vite/node" />
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, protocol, screen, session, Tray } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';
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
import type { AppSnapshot, Result, PlayerCommand, Settings, Track } from '../../../packages/core/contracts';
import type { HostMessage, HostRequest, PlayableTrack } from '../../../packages/player-mpv/protocol';
import { Metrics } from '../../../packages/core/metrics';
import { SubsonicClient, libraryCall, libraryMethods } from '../../../packages/adapter-opensubsonic/client';
import { JsonStore } from './store';
import { PlayTracker, type PlayEvent } from './plays';
import { QueueSync } from './queueSync';
import { Radio } from './radio';
import { startMpris, type MediaSession } from './mpris';

// Native Wayland where the session offers it (Fedora's default), XWayland otherwise. Must precede ready.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
// One instance owns the audio host, tray, and media keys. Launching again shows the existing window.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

const directory = dirname(fileURLToPath(import.meta.url));
const started = performance.now();
const metrics = new Metrics();
const loop = monitorEventLoopDelay({ resolution: 20 });
const state: AppSnapshot = { player: emptyPlayer(), diagnostics: emptyDiagnostics(), server: { connected: false, name: null, sessionId: null } };
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
  replace: (client, tracks) => send({ type: 'queue', tracks: tracks.map(track => client.playable(track)) }),
  append: (client, tracks) => send({ type: 'queue-add', tracks: tracks.map(track => client.playable(track)), where: 'end' }),
  // Already one request at a time, so it never takes a sync permit from the final queue save.
  background: task => Effect.runPromise(Effect.either(metrics.measure('sync.radio-top-up', task))),
  changed: () => { state.player = { ...state.player, radio: radio.view }; },
}, QUEUE_LIMIT);
// Starting any other playback, or losing the engine or session, ends radio. The queue stays.
const endRadio = () => radio.end();

// Must precede app ready. Covers are fetched here so server credentials never reach the renderer.
// CORS lets the renderer read cover pixels on a canvas for its palette.
protocol.registerSchemesAsPrivileged([{ scheme: 'squiggly-art', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
async function serveCover(request: Request): Promise<Response> {
  const cors = { 'access-control-allow-origin': '*' };
  const missing = () => new Response(null, { status: 404, headers: cors });
  try {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.hostname !== 'cover' || !server) return missing();
    const id = Schema.decodeUnknownEither(IdSchema)(decodeURIComponent(url.pathname.slice(1)));
    if (Either.isLeft(id)) return missing();
    const client = server;
    const result = await Effect.runPromise(Effect.either(semaphores.art.withPermits(1)(client.coverArt(id.right, Number(url.searchParams.get('size') ?? 300)))));
    if (Either.isLeft(result) || server !== client) return missing();
    return new Response(result.right.bytes, { headers: {
      ...cors, 'content-type': result.right.contentType, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff',
    } });
  } catch { return missing(); }
}

const alive = (target: BrowserWindow | null): target is BrowserWindow => target !== null && !target.isDestroyed();
const appWindows = () => [windows.main, windows.mini].filter(alive);
// Hidden windows catch up when shown (see createWindow) instead of receiving 4 Hz updates.
function broadcast() {
  for (const target of appWindows()) if (target.isVisible() && !target.webContents.isDestroyed()) target.webContents.send('squiggly:snapshot', state);
}
// Background consumers of each native snapshot: tray, OS media controls, play reports, queue sync.
function observePlayer() {
  const player = state.player;
  updateTray(); updateMedia(); void radio.topUp();
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
  queueSync.reset(); plays.reset();
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
  const child = fork(join(directory, 'player.js'), [], {
    execPath: process.env.SQUIGGLY_NODE_PATH || bundledRuntime(process.platform === 'win32' ? 'node.exe' : 'node') || 'node',
    env: {
      ...process.env, SQUIGGLY_LIBMPV_PATH: process.env.SQUIGGLY_LIBMPV_PATH || bundledRuntime('libmpv-2.dll'),
      SQUIGGLY_AUDIO_EXCLUSIVE: settings.value.exclusiveOutput ? '1' : '0',
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
    yield* send(command);
  }));
  handle('open-files', () => Effect.gen(function* () {
    const result = yield* Effect.promise(() => dialog.showOpenDialog(dialogParent(), {
      title: 'Add music', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['flac', 'wav', 'aiff', 'aif', 'alac', 'm4a', 'mp3', 'ogg', 'opus', 'aac', 'dsf', 'dff'] }],
    }));
    if (result.canceled) return;
    if (result.filePaths.length > QUEUE_LIMIT) return yield* Effect.fail(new Error(`Choose up to ${QUEUE_LIMIT.toLocaleString('en-US')} files at a time.`));
    const tracks: PlayableTrack[] = result.filePaths.map(path => ({
      location: path,
      track: {
        id: randomUUID(), title: basename(path, extname(path)), artist: 'Local file', album: '',
        source: 'local', duration: null, sourceFormat: extname(path).slice(1) || null,
        sourceSampleRate: null, sourceBitDepth: null,
      },
    }));
    endRadio();
    yield* send({ type: 'queue', tracks });
  }), 'dialog');
  handle('connect', (value, generation) => Effect.gen(function* () {
    if (generation !== connectionGeneration || quitting) return yield* Effect.fail(new Error('Connection canceled.'));
    const connection = yield* Schema.decodeUnknown(ConnectionSchema)(value).pipe(Effect.mapError(() => new Error('Enter a valid server address, username, and password.')));
    const candidate = yield* Effect.try(() => new SubsonicClient(connection, metrics));
    const info = yield* candidate.ping();
    if (generation !== connectionGeneration || quitting) return yield* Effect.fail(new Error('Connection canceled.'));
    // Credentials are session-only. No plaintext persistence or silent safeStorage fallback.
    // Stop playback and clear every authenticated URL before replacing the account,
    // while preserving the audio engine's volume and selected output device.
    endRadio();
    if (server) yield* send({ type: 'clear-session' });
    server = candidate; knownTracks.clear();
    connectionGeneration++; resetSessionState();
    state.server = { connected: true, name: `${info.name} (${new URL(candidate.baseUrl).host})`, sessionId: randomUUID() };
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
    yield* radio.start(seed);
  }), 'library');
  handle('radio:stop', () => Effect.sync(endRadio), 'library');
  // Loads the server-saved queue paused at its song and position. Playback starts only on play.
  handle('resume-queue', () => Effect.gen(function* () {
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
    yield* send({ type: 'queue', tracks: saved.tracks.map(track => client.playable(track)), startIndex: currentIndex, startPosition: positionSeconds, paused: true });
    queueSync.markSaved({ trackIds: saved.tracks.map(track => track.id), currentIndex, positionSeconds: Math.floor(positionSeconds) });
  }), 'server');
  ipcMain.handle('squiggly:get-settings', event => { assertSender(event); return settings.value; });
  handle('update-settings', value => Effect.gen(function* () {
    const changes = yield* Schema.decodeUnknown(SettingsPatchSchema)(value, { onExcessProperty: 'error' }).pipe(Effect.mapError(() => new Error('Invalid settings.')));
    const previous = settings.value;
    const next = { ...previous, ...changes };
    // A running engine applies exclusive output now; a stopped one reads the saved value at start.
    const exclusiveChanged = next.exclusiveOutput !== previous.exclusiveOutput && host !== null && state.player.engine === 'ready';
    if (exclusiveChanged) yield* send({ type: 'exclusive', on: next.exclusiveOutput });
    yield* Effect.tryPromise({ try: () => settings.save(next), catch: () => new Error('Could not save settings. Check that the app data folder is writable.') }).pipe(
      Effect.tapError(() => exclusiveChanged ? Effect.ignore(send({ type: 'exclusive', on: previous.exclusiveOutput })) : Effect.void));
    if (!next.syncQueue) queueSync.reset();
    applyMiniOnTop();
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
  handle('disconnect', () => Effect.gen(function* () {
    // Restart also removes authenticated stream URLs from the player's native playlist.
    connectionGeneration++;
    server = null; knownTracks.clear(); resetSessionState(); state.server = { connected: false, name: null, sessionId: null };
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
function createWindow(mini: boolean) {
  const target = new BrowserWindow({
    ...(mini ? {
      ...miniBounds(), minWidth: 320, minHeight: 96, maxWidth: 900, maxHeight: 240,
      frame: false, maximizable: false, fullscreenable: false, show: false, alwaysOnTop: settings.value.miniOnTop,
    } : { width: 1440, height: 940, minWidth: 850, minHeight: 650 }),
    backgroundColor: '#181d25', title: 'Squiggly Music',
    ...(process.platform === 'linux' ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(directory, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      ...(mini ? { additionalArguments: ['--squiggly-mini'] } : {}),
    },
  });
  target.setMenuBarVisibility(false);
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', event => event.preventDefault());
  target.on('show', () => { if (!target.webContents.isDestroyed()) target.webContents.send('squiggly:snapshot', state); });
  if (process.env.ELECTRON_RENDERER_URL) void target.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void target.loadFile(join(directory, '../renderer/index.html'));
  return target;
}
function createMainWindow() {
  const main = windows.main = createWindow(false);
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
  // Rebuild only when a label or enabled state changes, not on every snapshot.
  if (trayMenu === `${playing}:${ready}`) return;
  trayMenu = `${playing}:${ready}`;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: playing ? 'Pause' : 'Play', enabled: ready, click: () => transport({ type: playing ? 'pause' : 'play' }) },
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
let artDirectory: string | null = null;
let art: { coverArt: string; path: string } | null = null;
let artRequest: string | null = null;
let artFiles = 0;
function updateMedia() {
  if (!media) return;
  const track = state.player.queue[state.player.currentIndex];
  const coverArt = state.player.engine === 'ready' && track?.source === 'navidrome' ? track.coverArt ?? null : null;
  if (coverArt && art?.coverArt !== coverArt && artRequest !== coverArt && server && artDirectory) void fetchArt(coverArt, server, artDirectory);
  media.update(state.player, coverArt && art?.coverArt === coverArt ? pathToFileURL(art.path).href : null);
}
async function fetchArt(coverArt: string, client: SubsonicClient, directory: string) {
  artRequest = coverArt;
  const result = await Effect.runPromise(Effect.either(metrics.measure('shell.media-art', semaphores.art.withPermits(1)(client.coverArt(coverArt, 512)))));
  if (Either.isLeft(result) || artRequest !== coverArt || server !== client) return;
  const extension = result.right.contentType.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'img';
  const path = join(directory, `cover-${++artFiles}.${extension}`);
  try { await writeFile(path, result.right.bytes, { mode: 0o600 }); } catch { return; }
  if (artRequest !== coverArt || server !== client) { void rm(path, { force: true }).catch(() => undefined); return; }
  const previous = art; art = { coverArt, path };
  if (previous) void rm(previous.path, { force: true }).catch(() => undefined);
  updateMedia();
}
function startMediaControls() {
  if (process.platform === 'linux') {
    try { artDirectory = mkdtempSync(join(app.getPath('temp'), 'squiggly-art-')); } catch { artDirectory = null; }
    void startMpris({
      command: type => transport({ type }), seek: seekTo, volume: percent => transport({ type: 'volume', percent }),
      raise: showMain, quit: () => app.quit(),
    }, () => { media = null; metrics.record('shell.mpris-unavailable', 0, true); }).then(session => { media = session; updateMedia(); });
  }
  // Windows media keys. Chromium's handling only covers audio it plays itself. Registration
  // fails when another application owns a key; that key then stays with that application.
  // TODO(windows-smtc): the System Media Transport Controls overlay has no Electron API and no
  // maintained Node binding. Add it once one exists, rather than a silent HTML audio element.
  if (process.platform === 'win32') {
    const keys: Record<string, () => void> = {
      MediaPlayPause: () => transport({ type: state.player.playing ? 'pause' : 'play' }),
      MediaNextTrack: () => transport({ type: 'next' }), MediaPreviousTrack: () => transport({ type: 'previous' }),
      MediaStop: () => transport({ type: 'stop' }),
    };
    for (const [accelerator, run] of Object.entries(keys)) {
      try { if (!globalShortcut.register(accelerator, run)) metrics.record('shell.media-key-unavailable', 0, true); }
      catch { metrics.record('shell.media-key-unavailable', 0, true); }
    }
  }
}

if (primary) app.on('second-instance', () => showMain());
app.whenReady().then(async () => {
  if (!primary) return;
  app.setName('Squiggly Music');
  const userData = app.getPath('userData');
  settings = new JsonStore(join(userData, 'settings.json'), SettingsFileSchema, defaultSettings());
  windowState = new JsonStore(join(userData, 'window-state.json'), WindowStateSchema, {});
  await Promise.all([settings.load(), windowState.load()]);
  installHandlers(); loop.enable();
  protocol.handle('squiggly-art', serveCover);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  createMainWindow();
  createTray();
  startMediaControls();
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
    void Promise.all([bounded, stopped]).then(() => app.exit(0), () => app.exit(1));
  });
});
app.on('window-all-closed', () => app.quit());

// Keep this export type checked against the public command contract.
export type { PlayerCommand };
