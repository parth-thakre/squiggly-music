import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Effect, Either, Schema } from 'effect';
import { emptyPlayer, emptyDiagnostics } from '../../../packages/core/contracts';
import { CommandSchema, ConnectionSchema, IdSchema } from '../../../packages/core/validation';
import type { AppSnapshot, Result, PlayerCommand } from '../../../packages/core/contracts';
import type { HostMessage, HostRequest, PlayableTrack } from '../../../packages/player-mpv/protocol';
import { Metrics } from '../../../packages/core/metrics';
import { SubsonicClient } from '../../../packages/adapter-opensubsonic/client';

const directory = dirname(fileURLToPath(import.meta.url));
const started = performance.now();
const metrics = new Metrics();
const loop = monitorEventLoopDelay({ resolution: 20 });
const state: AppSnapshot = { player: emptyPlayer(), diagnostics: emptyDiagnostics(), server: { connected: false, name: null, sessionId: null } };
let window: BrowserWindow | null = null;
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
};
let connectionGeneration = 0;

function broadcast() {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('squiggly:snapshot', state);
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
async function launchPlayer() {
  const previous = host;
  rejectPending('Audio engine restarted.');
  if (previous) await terminateHost(previous);
  if (quitting) return;
  state.player = emptyPlayer();
  const child = fork(join(directory, 'player.js'), [], {
    execPath: process.env.SQUIGGLY_NODE_PATH || 'node', execArgv: [], windowsHide: true,
    stdio: ['ignore', 'ignore', process.env.SQUIGGLY_SMOKE_TEST === '1' ? 'pipe' : 'ignore', 'ipc'],
  });
  if (process.env.SQUIGGLY_SMOKE_TEST === '1') child.stderr?.on('data', data => process.stderr.write(data));
  host = child;
  child.on('message', (message: HostMessage) => {
    if (host !== child || retiredHosts.has(child) || unresponsiveHosts.has(child)) return;
    messages++; bytes += Buffer.byteLength(JSON.stringify(message));
    if (message.type === 'snapshot') {
      state.player = message.player; hostResources = message.resources; broadcast();
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
    rejectPending('Audio process exited.');
    state.player.engine = 'crashed'; state.player.playing = false;
    state.player.error = 'The audio process exited. Restart the audio engine to continue.';
    broadcast();
  });
  child.on('error', () => {
    if (host !== child || retiredHosts.has(child) || quitting) return;
    retiredHosts.add(child); rejectPending('Audio host could not start.');
    state.player.engine = 'unavailable'; state.player.playing = false;
    state.player.error = 'Could not start the Node audio host. Install Node 22.16+ or set SQUIGGLY_NODE_PATH to its executable.';
    broadcast();
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

function assertSender(event: IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Untrusted IPC sender.');
  }
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
        if (['connect', 'albums', 'play-album'].includes(channel) && generation !== connectionGeneration) {
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
    const result = yield* Effect.promise(() => dialog.showOpenDialog(window!, {
      title: 'Add music', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['flac', 'wav', 'aiff', 'aif', 'alac', 'm4a', 'mp3', 'ogg', 'opus', 'aac', 'dsf', 'dff'] }],
    }));
    if (result.canceled) return;
    if (result.filePaths.length > 500) return yield* Effect.fail(new Error('This prototype accepts up to 500 tracks at a time.'));
    const tracks: PlayableTrack[] = result.filePaths.map(path => ({
      location: path,
      track: {
        id: randomUUID(), title: basename(path, extname(path)), artist: 'Local file', album: '',
        source: 'local', duration: null, sourceFormat: extname(path).slice(1) || null,
        sourceSampleRate: null, sourceBitDepth: null,
      },
    }));
    yield* send({ type: 'queue', tracks });
  }), 'dialog');
  handle('connect', (value, generation) => Effect.gen(function* () {
    if (generation !== connectionGeneration || quitting) return yield* Effect.fail(new Error('Connection canceled.'));
    const connection = yield* Schema.decodeUnknown(ConnectionSchema)(value).pipe(Effect.mapError(() => new Error('Enter a valid server address, username, and password.')));
    const candidate = yield* Effect.try(() => new SubsonicClient(connection, metrics));
    const info = yield* candidate.ping();
    if (generation !== connectionGeneration || quitting) return yield* Effect.fail(new Error('Connection canceled.'));
    // Credentials are session-only. No plaintext persistence or silent safeStorage fallback.
    // Replacing a session must also discard the previous account's stream tokens.
    if (server) launchPlayer();
    server = candidate;
    connectionGeneration++;
    state.server = { connected: true, name: `${info.name} (${new URL(candidate.baseUrl).host})`, sessionId: randomUUID() };
  }), 'server');
  handle('albums', value => Effect.gen(function* () {
    const offset = yield* Schema.decodeUnknown(Schema.Number.pipe(Schema.int(), Schema.between(0, 1_000_000)))(value);
    if (!server) return yield* Effect.fail(new Error('Connect to a server first.'));
    const client = server;
    const albums = yield* client.albums(offset);
    if (server !== client) return yield* Effect.fail(new Error('Server session changed. Refresh the library.'));
    return albums;
  }), 'server');
  handle('play-album', value => Effect.gen(function* () {
    const id = yield* Schema.decodeUnknown(IdSchema)(value);
    if (!server) return yield* Effect.fail(new Error('Connect to a server first.'));
    const client = server;
    const tracks = yield* client.albumQueue(id);
    if (server !== client) return yield* Effect.fail(new Error('Server session changed. Select the album again.'));
    if (tracks.length > 500) return yield* Effect.fail(new Error('This prototype supports albums with up to 500 tracks.'));
    yield* send({ type: 'queue', tracks });
  }), 'server');
  handle('disconnect', () => Effect.gen(function* () {
    // Restart also removes authenticated stream URLs from the player's native playlist.
    connectionGeneration++;
    server = null; state.server = { connected: false, name: null, sessionId: null };
    yield* Effect.tryPromise(() => launchPlayer());
  }));
  handle('export-diagnostics', () => Effect.gen(function* () {
    const result = yield* Effect.promise(() => dialog.showSaveDialog(window!, {
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

app.whenReady().then(async () => {
  app.setName('Squiggly Music');
  installHandlers(); loop.enable();
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 850, minHeight: 650,
    backgroundColor: '#181d25', title: 'Squiggly Music',
    webPreferences: {
      preload: join(directory, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.once('did-finish-load', () => {
    state.diagnostics.startupMs = performance.now() - started; broadcast();
  });
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(directory, '../renderer/index.html'));
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
    quitting = true; connectionGeneration++;
    server = null; clearInterval(timer); loop.disable(); rejectPending('Application closing.');
    // Also covers a cleanup already in progress during a restart or disconnect.
    void (host ? terminateHost(host) : Promise.resolve()).then(() => app.exit(0), () => app.exit(1));
  });
});
app.on('window-all-closed', () => app.quit());

// Keep this export type checked against the public command contract.
export type { PlayerCommand };
