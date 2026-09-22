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
import { CommandSchema, ConnectionSchema } from '../../../packages/core/validation';
import type { AppSnapshot, Result, PlayerCommand } from '../../../packages/core/contracts';
import type { HostMessage, HostRequest, PlayableTrack } from '../../../packages/player-mpv/protocol';
import { Metrics } from '../../../packages/core/metrics';
import { SubsonicClient } from '../../../packages/adapter-opensubsonic/client';

const directory = dirname(fileURLToPath(import.meta.url));
const started = performance.now();
const metrics = new Metrics();
const loop = monitorEventLoopDelay({ resolution: 20 });
const state: AppSnapshot = { player: emptyPlayer(), diagnostics: emptyDiagnostics(), server: { connected: false, name: null } };
let window: BrowserWindow | null = null;
let host: ChildProcess | null = null;
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
function launchPlayer() {
  const previous = host;
  host = null;
  previous?.kill();
  rejectPending('Audio engine restarted.');
  state.player = emptyPlayer();
  const child = fork(join(directory, 'player.js'), [], {
    execPath: process.env.SQUIGGLY_NODE_PATH || 'node', execArgv: [], windowsHide: true,
    stdio: ['ignore', 'ignore', process.env.SQUIGGLY_SMOKE_TEST === '1' ? 'pipe' : 'ignore', 'ipc'],
  });
  if (process.env.SQUIGGLY_SMOKE_TEST === '1') child.stderr?.on('data', data => process.stderr.write(data));
  host = child;
  child.on('message', (message: HostMessage) => {
    if (host !== child) return;
    messages++; bytes += Buffer.byteLength(JSON.stringify(message));
    if (message.type === 'snapshot') { state.player = message.player; hostResources = message.resources; broadcast(); }
    else {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error)); else request.resolve();
    }
  });
  child.on('exit', code => {
    if (process.env.SQUIGGLY_SMOKE_TEST === '1') console.error('Audio process exit code:', code);
    if (host !== child || quitting) return;
    host = null;
    rejectPending('Audio process exited.');
    state.player.engine = 'crashed'; state.player.playing = false;
    state.player.error = 'The audio process exited. Restart the audio engine to continue.';
    broadcast();
  });
  child.on('error', () => {
    if (host !== child || quitting) return;
    host = null; rejectPending('Audio host could not start.');
    state.player.engine = 'unavailable'; state.player.playing = false;
    state.player.error = 'Could not start the Node audio host. Install Node 22.16+ or set SQUIGGLY_NODE_PATH to its executable.';
    broadcast();
  });
  broadcast();
}

function send(action: HostRequest['action']) {
  return Effect.tryPromise({
    try: () => new Promise<void>((resolve, reject) => {
      if (!host) return reject(new Error('Audio process is not running. Restart the audio engine.'));
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id); reject(new Error('Audio command timed out. Restart the audio engine.'));
      }, 8000);
      pending.set(id, { resolve, reject, timer });
      try { host.send({ id, action } satisfies HostRequest, error => {
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
function handle<A>(channel: string, task: (value: unknown) => Effect.Effect<A, unknown>, lane: keyof typeof semaphores = 'audio') {
  ipcMain.handle(`squiggly:${channel}`, async (event, value): Promise<Result<A>> => {
    assertSender(event);
    ipcCount++;
    if (ipcCount > 32) { ipcCount--; return { ok: false, error: 'Too many pending operations. Try again shortly.' }; }
    state.diagnostics.ipcCommands++;
    try {
      const program = Effect.suspend(() => task(value));
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
    if (command.type === 'restart') { launchPlayer(); return; }
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
  handle('connect', value => Effect.gen(function* () {
    const generation = connectionGeneration;
    const connection = yield* Schema.decodeUnknown(ConnectionSchema)(value).pipe(Effect.mapError(() => new Error('Enter a valid server address, username, and password.')));
    const candidate = yield* Effect.try(() => new SubsonicClient(connection, metrics));
    yield* candidate.ping();
    if (generation !== connectionGeneration) return yield* Effect.fail(new Error('Connection canceled.'));
    // Credentials are session-only. No plaintext persistence or silent safeStorage fallback.
    server = candidate;
    state.server = { connected: true, name: new URL(candidate.baseUrl).host };
  }), 'server');
  handle('albums', value => Effect.gen(function* () {
    const offset = yield* Schema.decodeUnknown(Schema.Number.pipe(Schema.int(), Schema.between(0, 1_000_000)))(value);
    if (!server) return yield* Effect.fail(new Error('Connect to a server first.'));
    return yield* server.albums(offset);
  }), 'server');
  handle('play-album', value => Effect.gen(function* () {
    const id = yield* Schema.decodeUnknown(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)))(value);
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
    server = null; state.server = { connected: false, name: null }; launchPlayer();
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

app.whenReady().then(() => {
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
  launchPlayer();
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
  app.once('before-quit', () => {
    quitting = true; clearInterval(timer); loop.disable(); host?.kill(); rejectPending('Application closing.');
  });
});
app.on('window-all-closed', () => app.quit());

// Keep this export type checked against the public command contract.
export type { PlayerCommand };
