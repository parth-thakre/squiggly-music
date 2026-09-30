import { app, powerMonitor, type BrowserWindow, type WebContents } from 'electron';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { release } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { format } from 'node:util';
import type { AppSnapshot, ExtensionInfo, PlayerSnapshot } from '../../../packages/core/contracts';

// TEST BUILDS ONLY. Streams the main process's logs and state to a collector
// (scripts/diag-collector.mjs) so a real install can be debugged live.
//
// Compiled in only when SQUIGGLY_DIAG_URL and SQUIGGLY_DIAG_TOKEN are set while building
// (electron.vite.config.ts defines the constants below, for the main process only). Without
// them every method here returns at once: nothing is hooked, written, or sent. Nothing is ever
// read from the runtime environment.
//
// Every string is scrubbed before it's queued (scrub): Subsonic credential query parameters and
// the connected account's password never leave the process, and no stored account object is
// ever passed in.

declare const __SQUIGGLY_DIAG_URL__: string | undefined;
declare const __SQUIGGLY_DIAG_TOKEN__: string | undefined;
declare const __SQUIGGLY_DIAG_BUILD__: Record<string, unknown> | undefined;

export const TITLE_SUFFIX = ' — diagnostics build';
const SECRET_PARAMS = ['u', 't', 's', 'p', 'apiKey', 'token', 'password'];
// A parameter after ? & or ; (or their percent-encoded forms, for a URL inside a URL), up to the
// next separator. The name and = stay so the log still shows which parameter was there.
const PARAMS = new RegExp(`((?:[?&;]|%3F|%26)(?:${SECRET_PARAMS.join('|')})(?:=|%3D))((?:(?!%26)[^&#\\s"'<>\\\\])*)`, 'gi');

// Removes credential query parameter values, then every known secret (the password as typed and
// URL-encoded). Applied to every string an event carries.
export function scrub(text: string, secrets: Iterable<string> = []): string {
  let out = text.replace(PARAMS, (_match, key: string, value: string) => value ? `${key}***` : key);
  for (const secret of secrets) if (secret) out = out.split(secret).join('***');
  return out;
}

export interface DiagnosticEvent { t: string; seq: number; session: string; kind: string; [key: string]: unknown }
export interface DiagnosticsSource {
  snapshot(): AppSnapshot;
  // The saved output device setting, which may differ from what the engine reports.
  outputDevice(): string;
  exclusiveOutput(): boolean;
}
export interface DiagnosticsOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
  flushMs?: number;
  heartbeatMs?: number;
  maxQueue?: number;
  maxFileBytes?: number;
}

const MAX_STRING = 8000;
const BATCH = 500;
// Lines waiting for the local file (only before userData is known, or between writes).
const MAX_LINES = 20_000;
const URGENT_GAP = 250;
// Noisy streams: at most this many events per kind in each window, then a count of the rest.
const NOISY = new Set(['main.console', 'renderer.console', 'host.stderr', 'host.stdout']);
const NOISE_LIMIT = 300;
const NOISE_WINDOW = 10_000;

const errorFields = (error: unknown) => error instanceof Error
  ? { name: error.name, message: error.message, stack: error.stack ?? null }
  : { name: typeof error, message: typeof error === 'string' ? error : safeFormat(error), stack: null };
function safeFormat(value: unknown) { try { return format('%o', value); } catch { return String(value); } }

export class RemoteDiagnostics {
  readonly enabled: boolean;
  readonly titleSuffix: string;
  private readonly url: string;
  private readonly token: string;
  private readonly fetch: typeof fetch;
  private readonly flushMs: number;
  private readonly heartbeatMs: number;
  private readonly maxQueue: number;
  private readonly maxFileBytes: number;
  readonly session = randomBytes(6).toString('hex');
  private seq = 0;
  private secrets = new Set<string>();
  // Longest first, so a secret containing another is replaced whole.
  private secretList: string[] = [];
  private queue: DiagnosticEvent[] = [];
  private lines: string[] = [];
  private dropped = 0;
  private sent = 0;
  private failures = 0;
  private retryAt = 0;
  private offlineSince = 0;
  private lastError: string | null = null;
  private sending: Promise<number> | null = null;
  private urgentTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUrgent = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private noise = new Map<string, { at: number; count: number; suppressed: number }>();
  private inConsole = false;
  private installed = false;
  private started = false;
  private closed = false;
  // The local NDJSON copy.
  private directory: string | null = null;
  private file: { day: string; part: number; path: string; bytes: number } | null = null;
  private fileWork: Promise<void> = Promise.resolve();
  private fileErrors = 0;
  // Change tracking.
  private hostState: { engine: string; error: string | null } | null = null;
  private extensionState: Map<string, { version: string; enabled: boolean; error: string | null }> | null = null;
  private ipcCalls = new Map<string, number>();
  private ipcFailures = new Map<string, number>();
  private windowNames = new WeakMap<WebContents, string>();
  private source: DiagnosticsSource | null = null;

  constructor(options: DiagnosticsOptions) {
    this.url = options.url; this.token = options.token;
    this.enabled = Boolean(options.url && options.token);
    this.titleSuffix = this.enabled ? TITLE_SUFFIX : '';
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.flushMs = options.flushMs ?? 2000;
    this.heartbeatMs = options.heartbeatMs ?? 5000;
    this.maxQueue = options.maxQueue ?? 5000;
    this.maxFileBytes = options.maxFileBytes ?? 20 * 1024 * 1024;
  }

  // Events ------------------------------------------------------------------------------

  addSecret(secret: string | null | undefined) {
    if (!this.enabled || !secret) return;
    this.secrets.add(secret);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) this.secrets.add(encoded);
    this.secretList = [...this.secrets].sort((a, b) => b.length - a.length);
  }

  private clean(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
      const text = scrub(value, this.secretList);
      return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…[${text.length - MAX_STRING} more]` : text;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (depth > 8) return '[too deep]';
    if (value instanceof Error) return this.clean(errorFields(value), depth + 1);
    if (Array.isArray(value)) return value.slice(0, 300).map(item => this.clean(item, depth + 1) ?? null);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 300)) {
      const cleaned = this.clean(item, depth + 1);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }

  // Queues one event for the collector and the local file. Urgent ones are sent within a moment.
  event(kind: string, data: Record<string, unknown> = {}, urgent = false) {
    if (!this.enabled || this.closed) return;
    if (NOISY.has(kind) && !this.allowNoise(kind)) return;
    const base = { t: new Date().toISOString(), seq: ++this.seq, session: this.session, kind };
    const event = Object.assign({ ...base }, this.clean(data) as Record<string, unknown>, base) as DiagnosticEvent;
    this.queue.push(event);
    if (this.queue.length > this.maxQueue) { const over = this.queue.length - this.maxQueue; this.queue.splice(0, over); this.dropped += over; }
    let line: string;
    try { line = JSON.stringify(event); } catch { line = JSON.stringify({ ...base, unserializable: true }); }
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    if (urgent) this.urgent();
  }

  private allowNoise(kind: string) {
    const now = Date.now();
    let entry = this.noise.get(kind);
    if (!entry || now - entry.at > NOISE_WINDOW) {
      const suppressed = entry?.suppressed ?? 0;
      entry = { at: now, count: 0, suppressed: 0 };
      this.noise.set(kind, entry);
      if (suppressed) this.event('diag.suppressed', { of: kind, count: suppressed, windowMs: NOISE_WINDOW });
    }
    if (entry.count >= NOISE_LIMIT) { entry.suppressed++; return false; }
    entry.count++;
    return true;
  }

  private urgent() {
    if (this.urgentTimer) return;
    const wait = Math.max(0, this.lastUrgent + URGENT_GAP - Date.now());
    this.urgentTimer = setTimeout(() => {
      this.urgentTimer = null; this.lastUrgent = Date.now();
      void this.flush();
    }, wait);
    this.urgentTimer.unref?.();
  }

  // Transport ---------------------------------------------------------------------------

  // Writes pending lines to the local file and posts queued events. Never throws. A failed post
  // keeps its events and waits (2 s doubling to 60 s) before the next; force skips that wait.
  async flush(force = false): Promise<{ sent: number; queued: number; error: string | null }> {
    if (!this.enabled) return { sent: 0, queued: 0, error: 'Diagnostics are not built in.' };
    this.writeLines();
    if (this.sending) { await this.sending.catch(() => 0); if (!force) return this.result(0); }
    if (!this.queue.length || (!force && Date.now() < this.retryAt)) return this.result(0);
    const sending = this.post();
    this.sending = sending;
    try { return this.result(await sending); } finally { if (this.sending === sending) this.sending = null; }
  }
  private result(sent: number) { return { sent, queued: this.queue.length, error: this.failures ? this.lastError : null }; }

  private async post(): Promise<number> {
    let sent = 0;
    while (this.queue.length) {
      const batch = this.queue.splice(0, BATCH);
      try {
        const response = await this.fetch(this.url, {
          method: 'POST', body: JSON.stringify(batch), signal: AbortSignal.timeout(5000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        });
        await response.arrayBuffer().catch(() => undefined);
        if (!response.ok) throw new Error(`Collector answered HTTP ${response.status}.`);
      } catch (error) {
        // Back to the front, oldest first, within the bound.
        this.queue.unshift(...batch);
        if (this.queue.length > this.maxQueue) { const over = this.queue.length - this.maxQueue; this.queue.splice(0, over); this.dropped += over; }
        if (!this.failures) this.offlineSince = Date.now();
        this.failures++;
        this.lastError = error instanceof Error ? error.message : 'Send failed.';
        this.retryAt = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(this.failures - 1, 5));
        return sent;
      }
      sent += batch.length; this.sent += batch.length;
      if (this.failures) {
        const failures = this.failures;
        this.failures = 0; this.retryAt = 0;
        this.event('diag.reconnected', { failedAttempts: failures, offlineMs: Date.now() - this.offlineSince, lastError: this.lastError, droppedTotal: this.dropped });
      }
    }
    return sent;
  }

  // The local copy: <userData>/diagnostics/remote-YYYYMMDD.ndjson, a new -N part past the cap.
  private target(bytes: number) {
    if (!this.directory) return null;
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    if (!this.file || this.file.day !== day) this.file = this.open(day, 1);
    while (this.file.bytes > 0 && this.file.bytes + bytes > this.maxFileBytes) this.file = this.open(day, this.file.part + 1);
    this.file.bytes += bytes;
    return this.file.path;
  }
  private open(day: string, part: number) {
    const path = join(this.directory!, `remote-${day}${part > 1 ? `-${part}` : ''}.ndjson`);
    let bytes = 0;
    try { bytes = statSync(path).size; } catch { bytes = 0; }
    return { day, part, path, bytes };
  }
  private takeLines() {
    if (!this.directory || !this.lines.length) return null;
    const text = `${this.lines.join('\n')}\n`;
    this.lines = [];
    const path = this.target(Buffer.byteLength(text));
    return path ? { path, text } : null;
  }
  private writeLines() {
    const chunk = this.takeLines();
    if (!chunk) return;
    this.fileWork = this.fileWork.then(() => appendFile(chunk.path, chunk.text)).catch(() => { this.fileErrors++; });
  }
  // For a fatal error, when the process may not live to the next tick.
  private writeLinesNow() {
    const chunk = this.takeLines();
    if (!chunk) return;
    try { appendFileSync(chunk.path, chunk.text); } catch { this.fileErrors++; }
  }

  stats() {
    return {
      queued: this.queue.length, sent: this.sent, dropped: this.dropped, failedAttempts: this.failures, lastError: this.failures ? this.lastError : null,
      file: this.file?.path ?? null, fileBytes: this.file?.bytes ?? 0, fileErrors: this.fileErrors,
    };
  }

  // Hooks -------------------------------------------------------------------------------

  // Before ready: console, uncaught exceptions, unhandled rejections.
  installEarly() {
    if (!this.enabled || this.installed) return;
    this.installed = true;
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        original(...args);
        if (this.inConsole) return;
        this.inConsole = true;
        try { this.event('main.console', { level, text: format(...args) }, level === 'error'); } catch { /* Never let logging throw. */ }
        finally { this.inConsole = false; }
      };
    }
    // The monitor observes without replacing Electron's own handling (its error dialog).
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      this.event('main.uncaught', { origin, ...errorFields(error) }, true);
      this.writeLinesNow();
    });
    process.on('unhandledRejection', reason => this.event('main.rejection', errorFields(reason), true));
    process.on('warning', warning => this.event('main.warning', errorFields(warning)));
  }

  // At ready: the startup report, the heartbeat, and Chromium's process events.
  start(userData: string, source: DiagnosticsSource) {
    if (!this.enabled || this.started) return;
    this.started = true; this.source = source;
    this.installEarly();
    const directory = join(userData, 'diagnostics');
    try { mkdirSync(directory, { recursive: true }); this.directory = directory; } catch { this.fileErrors++; }

    const every = (ms: number, run: () => void) => { const timer = setInterval(() => { try { run(); } catch { /* Keep going. */ } }, ms); timer.unref?.(); this.timers.push(timer); };
    every(this.flushMs, () => void this.flush());
    every(this.heartbeatMs, () => this.heartbeat());
    every(60_000, () => this.ipcCounts());
    // Diagnostics must never stop the app starting.
    try {
      const runtime = (file: string) => { const path = join(process.resourcesPath ?? '', 'runtime', file); return { path, exists: existsSync(path) }; };
      this.event('startup', {
        app: { name: app.getName(), version: app.getVersion(), isPackaged: app.isPackaged, portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE) },
        os: { platform: process.platform, release: release(), arch: process.arch },
        versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 },
        paths: { execPath: process.execPath, resourcesPath: process.resourcesPath, userData, cwd: process.cwd() },
        argv: process.argv,
        gpu: app.getGPUFeatureStatus(),
        locale: { app: app.getLocale(), system: app.getSystemLocale(), preferred: app.getPreferredSystemLanguages() },
        runtime: process.platform === 'win32'
          ? { node: runtime('node.exe'), libmpv: runtime('libmpv-2.dll') }
          : { node: runtime('node') },
        build: typeof __SQUIGGLY_DIAG_BUILD__ === 'object' ? __SQUIGGLY_DIAG_BUILD__ : null,
      }, true);
      const collector = (() => { try { const url = new URL(this.url); return `${url.origin}${url.pathname}`; } catch { return null; } })();
      const file = this.target(0);
      this.event('diag.note', {
        message: file
          ? `Diagnostics build. Every event is also appended to ${file} (a new remote-YYYYMMDD[-N].ndjson each day or past ${Math.round(this.maxFileBytes / 1048576)} MB).`
          : 'Diagnostics build. No local copy: the diagnostics folder could not be created.',
        file, collector, flushMs: this.flushMs, heartbeatMs: this.heartbeatMs, maxQueue: this.maxQueue,
      }, true);
      void app.getGPUInfo('basic').then(info => this.event('gpu.info', { info }), error => this.event('gpu.info', { error: errorFields(error) }));

      app.on('child-process-gone', (_event, details) => this.event('chromium.child-gone', {
        type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name ?? null, serviceName: details.serviceName ?? null,
      }, details.reason !== 'clean-exit'));
      app.on('render-process-gone', (_event, contents, details) => this.event('renderer.gone', {
        window: this.windowNames.get(contents) ?? 'other', reason: details.reason, exitCode: details.exitCode,
      }, true));
      for (const name of ['suspend', 'resume', 'lock-screen', 'unlock-screen'] as const) powerMonitor.on(name as 'suspend', () => this.event('system.power', { state: name }));

      this.heartbeat();
    } catch (error) { this.event('diag.start-failed', errorFields(error), true); }
  }

  private heartbeat() {
    const source = this.source;
    if (!source) return;
    const { player, diagnostics, server, update } = source.snapshot();
    const track = player.queue[player.currentIndex];
    this.event('heartbeat', {
      diagnostics,
      player: {
        engine: player.engine, playing: player.playing, error: player.error,
        position: player.position, duration: player.duration, volume: player.volume,
        currentIndex: player.currentIndex, queueLength: player.queue.length, repeat: player.repeat, shuffle: player.shuffle, radio: player.radio !== null,
        deviceCount: player.devices.length, selectedDevice: player.audio.requestedDevice,
        settingsDevice: source.outputDevice(), exclusiveOutput: source.exclusiveOutput(), audio: player.audio,
        track: track ? { id: track.id, source: track.source, format: track.sourceFormat, sampleRate: track.sourceSampleRate, bitDepth: track.sourceBitDepth, duration: track.duration } : null,
      },
      // Never the saved sign-in: no username, no server URL.
      server: { connected: server.connected, name: server.name, reconnecting: server.reconnecting, reconnectError: server.reconnectError, canRemember: server.canRemember },
      update,
      diag: this.stats(),
    });
  }

  private ipcCounts() {
    if (!this.ipcCalls.size && !this.ipcFailures.size) return;
    this.event('ipc.counts', { periodSeconds: 60, calls: Object.fromEntries(this.ipcCalls), failures: Object.fromEntries(this.ipcFailures) });
    this.ipcCalls.clear(); this.ipcFailures.clear();
  }

  // Both app windows: renderer console, load failures, hangs. Adds the build's title marker.
  watchWindow(window: BrowserWindow, name: string) {
    if (!this.enabled) return;
    const contents = window.webContents;
    this.windowNames.set(contents, name);
    window.setTitle(`${window.getTitle()}${TITLE_SUFFIX}`);
    window.on('page-title-updated', (event, title) => { event.preventDefault(); window.setTitle(`${title}${TITLE_SUFFIX}`); });
    contents.on('console-message', details => this.event('renderer.console', {
      window: name, level: details.level, message: details.message, source: details.sourceId, line: details.lineNumber,
    }, details.level === 'error'));
    contents.on('unresponsive', () => this.event('renderer.unresponsive', { window: name }, true));
    contents.on('responsive', () => this.event('renderer.responsive', { window: name }, true));
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => this.event('renderer.load-failed', { window: name, code, description, url, isMainFrame }, true));
    contents.on('preload-error', (_event, preloadPath, error) => this.event('renderer.preload-error', { window: name, preloadPath, ...errorFields(error) }, true));
    contents.on('did-finish-load', () => {
      this.event('renderer.loaded', { window: name, url: contents.getURL() });
      // A small corner marker, so a screenshot shows which build it is.
      if (name === 'main') void contents.insertCSS(`body::after{content:'diagnostics build';position:fixed;left:6px;bottom:4px;z-index:2147483647;font:10px/1 ui-monospace,monospace;opacity:.55;pointer-events:none;color:#f0c;}`).catch(() => undefined);
    });
  }

  // The audio host: where it runs from, its lifecycle, and its output (piped in this build).
  hostSpawn(child: ChildProcess, info: { execPath: string; script: string; libmpv?: string | undefined }) {
    if (!this.enabled) return;
    this.hostState = null;
    const pid = child.pid ?? null;
    this.event('host.spawn', {
      pid, execPath: info.execPath, execPathExists: existsSync(info.execPath), fromPath: !/[\\/]/.test(info.execPath),
      script: info.script, scriptExists: existsSync(info.script),
      libmpv: info.libmpv ?? null, libmpvExists: info.libmpv ? existsSync(info.libmpv) : null,
    });
    child.once('spawn', () => this.event('host.spawned', { pid: child.pid ?? pid }));
    child.on('error', error => this.event('host.error', { pid: child.pid ?? pid, message: error.message, code: (error as NodeJS.ErrnoException).code ?? null }, true));
    child.on('exit', (code, signal) => this.event('host.exit', { pid: child.pid ?? pid, code, signal }, code !== 0));
    this.pipeLines(child.stderr, 'host.stderr', child.pid ?? pid);
    this.pipeLines(child.stdout, 'host.stdout', child.pid ?? pid);
  }
  private pipeLines(stream: Readable | null, kind: string, pid: number | null) {
    if (!stream) return;
    let partial = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop() ?? '';
      if (partial.length > 16_000) { parts.push(partial); partial = ''; }
      for (const line of parts) if (line.trim()) this.event(kind, { pid, line }, /error|fatal|exception/i.test(line));
    });
    stream.on('end', () => { if (partial.trim()) this.event(kind, { pid, line: partial }); partial = ''; });
    stream.on('error', () => undefined);
  }

  // Every host snapshot where the engine or its error changed.
  hostSnapshot(player: PlayerSnapshot) {
    if (!this.enabled) return;
    const previous = this.hostState;
    if (previous && previous.engine === player.engine && previous.error === player.error) return;
    this.hostState = { engine: player.engine, error: player.error };
    this.event('host.state', {
      engine: player.engine, error: player.error, previousEngine: previous?.engine ?? null, previousError: previous?.error ?? null,
      deviceCount: player.devices.length, audio: player.audio,
    }, player.error !== null || player.engine === 'crashed' || player.engine === 'unavailable');
  }

  ipcCall(channel: string) {
    if (!this.enabled) return;
    this.ipcCalls.set(channel, (this.ipcCalls.get(channel) ?? 0) + 1);
  }
  ipcFailed(channel: string, error: string, ms: number) {
    if (!this.enabled) return;
    this.ipcFailures.set(channel, (this.ipcFailures.get(channel) ?? 0) + 1);
    this.event('ipc.error', { channel, error, ms: Math.round(ms * 10) / 10 }, true);
  }

  // The extension list the window gets: the first in full, then what changed.
  extensions(list: readonly ExtensionInfo[]) {
    if (!this.enabled) return;
    const next = new Map(list.map(item => [item.id, { version: item.version, enabled: item.enabled, error: item.error }]));
    const previous = this.extensionState;
    this.extensionState = next;
    if (!previous) {
      this.event('ext.list', { extensions: list.map(item => ({ id: item.id, version: item.version, enabled: item.enabled, isNew: item.isNew, error: item.error })) }, list.some(item => item.error));
      return;
    }
    for (const [id, now] of next) {
      const before = previous.get(id);
      if (!before) this.event('ext.change', { id, change: 'added', ...now }, now.error !== null);
      else {
        if (before.enabled !== now.enabled) this.event('ext.change', { id, change: now.enabled ? 'enabled' : 'disabled', version: now.version });
        if (before.error !== now.error) this.event('ext.change', { id, change: now.error ? 'error' : 'error-cleared', error: now.error, version: now.version }, now.error !== null);
        else if (before.version !== now.version) this.event('ext.change', { id, change: 'version', from: before.version, to: now.version });
      }
    }
    for (const id of previous.keys()) if (!next.has(id)) this.event('ext.change', { id, change: 'removed' });
  }

  // electron-updater's events, including the error text the window doesn't show.
  update(name: string, data: Record<string, unknown> = {}) {
    if (!this.enabled) return;
    this.event(`update.${name}`, data, name === 'error');
  }

  // At quit: a last event, then a flush bounded by the caller.
  async close() {
    if (!this.enabled || this.closed) return;
    this.event('diag.stop', { stats: this.stats() });
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.urgentTimer) clearTimeout(this.urgentTimer);
    this.writeLines();
    await Promise.race([Promise.all([this.flush(true), this.fileWork]), new Promise(resolve => setTimeout(resolve, 1500))]);
  }
}

// The build's instance. Off unless both constants were defined at build time.
export const remote = new RemoteDiagnostics({
  url: typeof __SQUIGGLY_DIAG_URL__ === 'string' ? __SQUIGGLY_DIAG_URL__ : '',
  token: typeof __SQUIGGLY_DIAG_TOKEN__ === 'string' ? __SQUIGGLY_DIAG_TOKEN__ : '',
});
