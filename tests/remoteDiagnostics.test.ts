import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyDiagnostics, emptyPlayer, type AppSnapshot } from '../packages/core/contracts';

const electron = vi.hoisted(() => ({
  app: {
    on: vi.fn(), getName: () => 'Squiggly Music', getVersion: () => '0.2.0', isPackaged: false,
    getGPUFeatureStatus: () => ({}), getLocale: () => 'en-US', getSystemLocale: () => 'en-US', getPreferredSystemLanguages: () => ['en-US'],
    getGPUInfo: () => Promise.resolve({}),
  },
  powerMonitor: { on: vi.fn() },
}));
vi.mock('electron', () => electron);

import { remote, RemoteDiagnostics, scrub } from '../apps/desktop/main/remoteDiagnostics';

const snapshot = (): AppSnapshot => ({
  player: emptyPlayer(), diagnostics: emptyDiagnostics(),
  update: { mode: 'off', status: 'idle', current: '0.2.0', version: null, percent: null, error: null },
  server: { connected: true, name: 'Navidrome (music.example)', sessionId: 'x', account: 'https://account-server-7q.example\naccount-user-7q', saved: { url: 'https://saved-server-7q.example', username: 'saved-user-7q' }, canRemember: true, reconnecting: false, reconnectError: null },
});
const source = { snapshot, outputDevice: () => 'auto', exclusiveOutput: () => false };

describe('scrub', () => {
  it('removes Subsonic credential parameters and keeps the rest', () => {
    const url = 'https://music.example/rest/stream.view?id=42&u=parth&t=abc123&s=salt&v=1.16.1&c=squiggly&f=json';
    expect(scrub(url)).toBe('https://music.example/rest/stream.view?id=42&u=***&t=***&s=***&v=1.16.1&c=squiggly&f=json');
    expect(scrub('GET /rest/ping?p=enc:736563726574&apiKey=K1&token=T2&password=hunter2#top'))
      .toBe('GET /rest/ping?p=***&apiKey=***&token=***&password=***#top');
    // A URL inside a URL, percent-encoded.
    expect(scrub('open?next=https%3A%2F%2Fh%2Frest%3Fu%3Dparth%26t%3Dabc%26id%3D7')).toBe('open?next=https%3A%2F%2Fh%2Frest%3Fu%3D***%26t%3D***%26id%3D7');
    // Names that only start with a secret one are left alone.
    expect(scrub('/albums?page=2&size=50&type=newest')).toBe('/albums?page=2&size=50&type=newest');
  });

  it('replaces known secrets anywhere', () => {
    expect(scrub('login failed for pa$$ word, pa%24%24%20word', ['pa$$ word', encodeURIComponent('pa$$ word')])).toBe('login failed for ***, ***');
  });
});

describe('remote diagnostics', () => {
  let directory: string | null = null;
  afterEach(async () => {
    vi.restoreAllMocks(); vi.useRealTimers();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it('is off, and sends and writes nothing, when the build defined no URL and token', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const log = console.log, error = console.error, listeners = process.listenerCount('unhandledRejection');
    // The build's own instance: the constants are undefined outside electron-vite.
    expect(remote.enabled).toBe(false);
    expect(remote.titleSuffix).toBe('');
    const fetchSpy = vi.fn();
    directory = await mkdtemp(join(tmpdir(), 'squiggly-diag-'));
    for (const diagnostics of [remote, new RemoteDiagnostics({ url: '', token: '', fetch: fetchSpy }), new RemoteDiagnostics({ url: 'http://127.0.0.1:1/ingest', token: '', fetch: fetchSpy })]) {
      expect(diagnostics.enabled).toBe(false);
      diagnostics.installEarly();
      diagnostics.start(directory, source);
      diagnostics.addSecret('secret');
      diagnostics.event('main.console', { text: 'hello' }, true);
      diagnostics.ipcCall('command'); diagnostics.ipcFailed('command', 'boom', 3);
      diagnostics.hostSnapshot(emptyPlayer());
      diagnostics.hostSpawn(new EventEmitter() as never, { execPath: 'node', script: 'player.js' });
      diagnostics.update('error', { message: 'x' });
      diagnostics.extensions([]);
      expect((await diagnostics.flush(true)).sent).toBe(0);
      await diagnostics.close();
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(electron.app.on).not.toHaveBeenCalled();
    expect(existsSync(join(directory, 'diagnostics'))).toBe(false);
    expect([console.log, console.error, process.listenerCount('unhandledRejection')]).toEqual([log, error, listeners]);
  });

  it('batches scrubbed events with the bearer token, keeps a local copy, and backs off quietly', async () => {
    directory = await mkdtemp(join(tmpdir(), 'squiggly-diag-'));
    const bodies: unknown[][] = [];
    let fail = true;
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (fail) throw new Error('connect ECONNREFUSED');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    });
    const diagnostics = new RemoteDiagnostics({ url: 'http://127.0.0.1:1/ingest', token: 'tok', fetch: fetchSpy as typeof fetch, flushMs: 60_000, heartbeatMs: 60_000, maxQueue: 5 });
    expect(diagnostics.titleSuffix).toBe(' — Beta · sends diagnostics');
    diagnostics.start(directory, source);
    diagnostics.addSecret('hunter2');
    for (let i = 0; i < 6; i++) diagnostics.event('test', { i, url: `http://h/rest/x?u=me&p=hunter2&id=${i}`, note: 'pw hunter2' });

    expect((await diagnostics.flush()).error).toContain('ECONNREFUSED');
    // Backing off: an ordinary flush doesn't try again yet, and nothing throws.
    await diagnostics.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(diagnostics.stats().dropped).toBeGreaterThan(0);

    fail = false;
    const result = await diagnostics.flush(true);
    expect(result.error).toBeNull();
    const sent = bodies.flat() as Record<string, unknown>[];
    expect(sent.map(event => event.kind)).toContain('test');
    const last = sent.filter(event => event.kind === 'test').at(-1)!;
    expect(last).toMatchObject({ i: 5, url: 'http://h/rest/x?u=***&p=***&id=5', note: 'pw ***', session: diagnostics.session });
    expect(Object.keys(last).slice(0, 4)).toEqual(['t', 'seq', 'session', 'kind']);
    expect(JSON.stringify(sent)).not.toContain('hunter2');
    expect(JSON.stringify(sent)).not.toContain('saved-user-7q');

    await diagnostics.close();
    const files = await readdir(join(directory, 'diagnostics'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^remote-\d{8}\.ndjson$/);
    const text = await readFile(join(directory, 'diagnostics', files[0]), 'utf8');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('saved-user-7q');
    expect(text).not.toContain('saved-server-7q');
    // Nor the signed-in account (ServerState.account): its address and username.
    expect(text).not.toContain('account-server-7q');
    expect(text).not.toContain('account-user-7q');
    const lines = text.trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(line => line.kind)).toEqual(expect.arrayContaining(['startup', 'diag.note', 'heartbeat', 'test', 'diag.stop']));
    expect(lines.filter(line => line.kind === 'test')).toHaveLength(6);
    const heartbeat = lines.find(line => line.kind === 'heartbeat');
    expect(heartbeat.server).toEqual({ connected: true, name: 'Navidrome (music.example)', reconnecting: false, reconnectError: null, canRemember: true });
  });

  // The Settings switch (the diagnostics setting), as main applies it.
  const collector = 'http://pc.tail1e2a66.ts.net:47800/ingest';
  const recording = () => {
    const kinds: string[] = [];
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      kinds.push(...(JSON.parse(String(init?.body)) as { kind: string }[]).map(event => event.kind));
      return new Response(null, { status: 204 });
    });
    return { kinds, fetchSpy, fetch: fetchSpy as typeof fetch };
  };

  it('sends and writes nothing while the setting is off, and picks up when it is on again', async () => {
    directory = await mkdtemp(join(tmpdir(), 'squiggly-diag-'));
    const { kinds, fetchSpy, fetch } = recording();
    const diagnostics = new RemoteDiagnostics({ url: collector, token: 'tok', fetch, flushMs: 60_000, heartbeatMs: 60_000 });
    diagnostics.start(directory, source, true);
    diagnostics.event('before', {});
    await diagnostics.flush(true); await diagnostics['fileWork'];
    expect(kinds).toEqual(expect.arrayContaining(['startup', 'heartbeat', 'before']));
    const file = join(directory, 'diagnostics', (await readdir(join(directory, 'diagnostics')))[0]);
    const written = await readFile(file, 'utf8');

    // Queued but not yet sent or written when the switch goes off: dropped.
    diagnostics.event('queued-then-dropped', {});
    diagnostics.setActive(false);
    expect([diagnostics.live, diagnostics.titleSuffix]).toEqual([false, '']);
    diagnostics.event('while-off', {}, true);
    diagnostics.hostSnapshot({ ...emptyPlayer(), engine: 'crashed' });
    diagnostics.ipcFailed('command', 'boom', 1);
    diagnostics.update('error', { message: 'x' });
    expect(await diagnostics.flush(true)).toEqual({ sent: 0, queued: 0, error: 'Diagnostics are turned off in Settings.' });
    await new Promise(resolve => setTimeout(resolve, 300));
    await diagnostics['fileWork'];
    const callsWhileOff = fetchSpy.mock.calls.length;
    expect(await readFile(file, 'utf8')).toBe(written);
    expect(diagnostics.stats().queued).toBe(0);

    diagnostics.setActive(true);
    expect([diagnostics.live, diagnostics.titleSuffix]).toEqual([true, ' — Beta · sends diagnostics']);
    diagnostics.event('after', {});
    await diagnostics.flush(true); await diagnostics['fileWork'];
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsWhileOff);
    expect(kinds).toEqual(expect.arrayContaining(['diag.resumed', 'after']));
    for (const kind of ['queued-then-dropped', 'while-off', 'host.state', 'ipc.error', 'update.error']) expect(kinds).not.toContain(kind);
    const text = await readFile(file, 'utf8');
    expect(text.startsWith(written)).toBe(true);
    const appended = text.slice(written.length).trim().split('\n').map(line => JSON.parse(line).kind);
    expect(appended).toEqual(expect.arrayContaining(['diag.resumed', 'heartbeat', 'after']));
    expect(appended).not.toContain('while-off');

    // Quitting with the switch off sends nothing more, not even the stop event.
    diagnostics.setActive(false);
    const callsBeforeQuit = fetchSpy.mock.calls.length;
    await diagnostics.close();
    expect(fetchSpy.mock.calls.length).toBe(callsBeforeQuit);
    expect(kinds).not.toContain('diag.stop');
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('started with the setting off, it keeps nothing from before and waits to be turned on', async () => {
    directory = await mkdtemp(join(tmpdir(), 'squiggly-diag-'));
    const { kinds, fetchSpy, fetch } = recording();
    const diagnostics = new RemoteDiagnostics({ url: collector, token: 'tok', fetch, flushMs: 60_000, heartbeatMs: 60_000 });
    // Before settings load, as main's console and error hooks do.
    diagnostics.event('before-settings', {}, true);
    diagnostics.start(directory, source, false);
    diagnostics.event('while-off', {}, true);
    await diagnostics.flush(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(directory, 'diagnostics'))).toBe(false);
    expect(diagnostics.titleSuffix).toBe('');

    diagnostics.setActive(true);
    await diagnostics.flush(true);
    expect(kinds).toEqual(expect.arrayContaining(['startup', 'diag.note', 'heartbeat']));
    expect(kinds).not.toContain('before-settings');
    expect(kinds).not.toContain('while-off');
    expect(kinds).not.toContain('diag.resumed');
    expect(existsSync(join(directory, 'diagnostics'))).toBe(true);
    await diagnostics.close();
  });
});

// A MagicDNS name (pc.<tailnet>.ts.net) resolves only on the tailnet. Anywhere else the send
// fails at the lookup; that must stay quiet: no console output, no throw, and fewer tries over time.
describe('a collector hostname that does not resolve', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('fails quietly and backs off to once a minute', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] });
    const quiet = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level));
    const url = 'http://pc.tail1e2a66.ts.net:47800/ingest';
    const fetchSpy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND pc.tail1e2a66.ts.net'), { code: 'ENOTFOUND' }) });
    });
    const diagnostics = new RemoteDiagnostics({ url, token: 'tok', fetch: fetchSpy as typeof fetch });
    diagnostics.event('test', {});
    expect(await diagnostics.flush()).toEqual({ sent: 0, queued: 1, error: 'fetch failed (ENOTFOUND)' });
    expect(fetchSpy).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'POST' }));

    // The periodic flush runs every 2 s; only some of those try the network.
    const attempts = [0];
    for (let now = 500; now <= 400_000; now += 500) {
      vi.setSystemTime(now);
      const before = fetchSpy.mock.calls.length;
      await diagnostics.flush();
      if (fetchSpy.mock.calls.length > before) attempts.push(now);
    }
    const gaps = attempts.slice(1).map((at, index) => at - attempts[index]);
    expect(gaps.slice(0, 6)).toEqual([2000, 4000, 8000, 16000, 32000, 60000]);
    expect(gaps.slice(5).every(gap => gap === 60_000)).toBe(true);
    expect(diagnostics.stats()).toMatchObject({ queued: 1, failedAttempts: attempts.length, lastError: 'fetch failed (ENOTFOUND)' });
    for (const spy of quiet) expect(spy).not.toHaveBeenCalled();
  });

  it('settles without throwing for a real lookup that fails', async () => {
    // .invalid never resolves (RFC 6761); offline, the lookup fails too.
    const diagnostics = new RemoteDiagnostics({ url: 'http://squiggly-collector.invalid:47800/ingest', token: 'tok' });
    diagnostics.event('test', {});
    const result = await diagnostics.flush(true);
    expect(result).toMatchObject({ sent: 0, queued: 1 });
    expect(result.error).toMatch(/fetch failed|timeout/i);
  }, 15_000);
});
