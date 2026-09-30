import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubsonicClient } from '../packages/adapter-opensubsonic/client';
import { connectFailed, connectionIdle, connectionInUse, connectionsFull, maxConnections, notConnected } from '../scripts/navidrome-preview';
import { previewServer, webPassword } from './previewHarness';

const login = { username: 'ana', password: 'navidrome secret' };
const audio = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

// A small Subsonic server the real connector talks to over HTTP: ping and getPlaylists check the
// token login, and stream sends fixed bytes. Every request's path is kept.
async function subsonic() {
  const paths: string[] = [];
  // Set to hold ping answers until it settles.
  const held = { ping: null as Promise<void> | null };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://subsonic');
    paths.push(url.pathname);
    const params = url.searchParams;
    const reply = (body: object) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', openSubsonic: true, ...body } }));
    };
    const signedIn = params.get('u') === login.username && params.get('t') === md5(login.password + params.get('s'));
    if (url.pathname === '/rest/getOpenSubsonicExtensions.view') return reply({ openSubsonicExtensions: [] });
    if (!signedIn) return reply({ status: 'failed', error: { code: 40 } });
    if (url.pathname === '/rest/ping.view') { if (held.ping) await held.ping; return reply({}); }
    if (url.pathname === '/rest/getPlaylists.view') return reply({ playlists: { playlist: [{ id: 'pl-own', name: 'Own list', owner: login.username }] } });
    if (url.pathname === '/rest/stream.view') { response.writeHead(200, { 'content-type': 'audio/flac' }); return void response.end(audio); }
    reply({ status: 'failed', error: { code: 0 } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  cleanup.push(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, paths, held };
}

// `client` stands in for the environment's connector; without it one is built from `env`, as the host does.
async function setup({ password = null as string | null, env = {} as NodeJS.ProcessEnv, client = undefined as SubsonicClient | undefined } = {}) {
  const server = await subsonic();
  const clock = { now: 1_800_000_000_000 };
  const preview = await previewServer({ env: { ...env, ...(password ? { SQUIGGLY_WEB_PASSWORD: password } : {}) }, ...(client ? { client } : {}), now: () => clock.now });
  cleanup.push(preview.close);
  const connect = async (body: unknown, cookie?: string, headers: Record<string, string> = {}) => {
    const response = await preview.post('/api/connect', body, cookie, headers);
    const setCookie = response.headers.get('set-cookie') ?? '';
    return { response, body: await response.json() as unknown, setCookie, cookie: /squiggly-connection=[0-9a-f]{64}/.exec(setCookie)?.[0] ?? '' };
  };
  const session = async (cookie?: string) => (await (await preview.fetch('/api/session', { headers: cookie ? { cookie } : {} })).json() as { value: unknown }).value;
  const playlists = async (cookie?: string) => {
    const response = await preview.post('/api/playlists', [], cookie);
    return { status: response.status, body: await response.json() as unknown };
  };
  return { server, preview, clock, connect, session, playlists };
}
const disconnected = { status: 503, body: { ok: false, error: notConnected } };
const ownList = { status: 200, body: { ok: true, value: [expect.objectContaining({ id: 'pl-own', name: 'Own list' })] } };

describe('connecting from the page', () => {
  it('connects, keeps the connection for this browser only, and serves the library through it', async () => {
    const { server, preview, connect, session, playlists } = await setup();
    // Nothing to use until a page connects.
    expect(await session()).toEqual({ signedIn: true, required: false, connected: false, serverName: null, pageConnection: false });
    expect(await playlists()).toEqual(disconnected);
    expect((await preview.fetch('/api/stream?id=s1')).status).toBe(503);

    const connected = await connect({ url: server.url, ...login });
    expect(connected.response.status).toBe(200);
    const serverName = `Navidrome (http://${server.host})`;
    expect(connected.body).toEqual({ ok: true, value: { serverName } });
    expect(connected.setCookie).toMatch(/^squiggly-connection=[0-9a-f]{64}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/);
    expect(JSON.stringify(connected.body)).not.toContain(login.password);

    const { cookie } = connected;
    expect(await session(cookie)).toEqual({ signedIn: true, required: false, connected: true, serverName, pageConnection: true });
    expect(await playlists(cookie)).toEqual(ownList);
    const stream = await preview.fetch('/api/stream?id=s1', { headers: { cookie } });
    expect(stream.status).toBe(200);
    expect(Buffer.from(await stream.arrayBuffer())).toEqual(audio);
    expect(server.paths).toContain('/rest/stream.view');
    // Another browser has no connection of its own.
    expect(await playlists()).toEqual(disconnected);
    expect(await playlists('squiggly-connection=' + 'a'.repeat(64))).toEqual(disconnected);
    expect(preview.errors).toEqual([]);
  });

  it('tries HTTPS, then HTTP, for an address without a scheme', async () => {
    const { server, connect } = await setup();
    const connected = await connect({ url: server.host, ...login });
    expect(connected.body).toEqual({ ok: true, value: { serverName: `Navidrome (http://${server.host})` } });
  });

  it('answers one message for a wrong login, an unreachable server, a page that is not a server, or a bad address, and sets no cookie', async () => {
    const { server, preview, connect } = await setup();
    const cases: [unknown, number, string][] = [
      [{ url: server.url, username: login.username, password: 'wrong' }, 502, connectFailed],
      [{ url: 'http://127.0.0.1:1', ...login }, 502, connectFailed],
      [{ url: preview.url, ...login }, 502, connectFailed],
      [{ url: 'ftp://music.example.com', ...login }, 502, connectFailed],
      [{ url: '', ...login }, 400, 'Enter the server address, username, and password.'],
      [{ url: server.url, username: login.username }, 400, 'Enter the server address, username, and password.'],
    ];
    for (const [body, status, error] of cases) {
      const attempt = await connect(body);
      expect(attempt.response.status, JSON.stringify(body)).toBe(status);
      expect(attempt.body).toEqual({ ok: false, error });
      expect(attempt.setCookie).toBe('');
    }
  });

  it('disconnects: the host forgets the connection and clears the cookie', async () => {
    const { server, preview, connect, session, playlists } = await setup();
    const { cookie } = await connect({ url: server.url, ...login });
    expect((await preview.fetch('/api/disconnect', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', cookie } })).status).toBe(403);
    const response = await preview.post('/api/disconnect', {}, cookie);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('set-cookie')).toBe('squiggly-connection=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
    expect(await playlists(cookie)).toEqual(disconnected);
    // Asking for the session with the forgotten cookie drops it.
    const status = await preview.fetch('/api/session', { headers: { cookie } });
    expect((await status.json() as { value: unknown }).value).toEqual({ signedIn: true, required: false, connected: false, serverName: null, pageConnection: false });
    expect(status.headers.get('set-cookie')).toBe('squiggly-connection=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
    expect(await session()).toMatchObject({ connected: false });
  });

  it(`keeps at most ${maxConnections} connections, making room only with one left unused, and forgets one after a day unused`, async () => {
    const { server, connect, playlists, clock } = await setup();
    const cookies: string[] = [];
    for (let i = 0; i < maxConnections; i++) { cookies.push((await connect({ url: server.url, ...login })).cookie); clock.now += 1000; }
    expect(new Set(cookies).size).toBe(maxConnections);
    // All in use: the next waits, without the server being asked, and pushes no one out.
    const asked = server.paths.length;
    const full = await connect({ url: server.url, ...login });
    expect(full.response.status).toBe(503);
    expect(full.body).toEqual({ ok: false, error: connectionsFull });
    expect(full.setCookie).toBe('');
    expect(server.paths).toHaveLength(asked);
    expect(await playlists(cookies[1])).toEqual(ownList);

    // Ten minutes on, the first is used again, so the third is the one idle longest, and the next pushes it out.
    clock.now += connectionInUse;
    expect(await playlists(cookies[0])).toEqual(ownList);
    const newest = (await connect({ url: server.url, ...login })).cookie;
    expect(await playlists(cookies[2])).toEqual(disconnected);
    expect(await playlists(cookies[0])).toEqual(ownList);
    expect(await playlists(newest)).toEqual(ownList);
    const another = (await connect({ url: server.url, ...login })).cookie;
    expect(await playlists(cookies[3])).toEqual(disconnected);
    expect(await playlists(cookies[4])).toEqual(ownList);

    clock.now += connectionIdle - 1;
    expect(await playlists(another)).toEqual(ownList);
    clock.now += connectionIdle - 1;
    expect(await playlists(newest)).toEqual(disconnected);
    expect(await playlists(another)).toEqual(ownList);
    clock.now += connectionIdle;
    expect(await playlists(another)).toEqual(disconnected);
  });

  it('keeps one connection per page session, even without the connection cookie', async () => {
    const { server, preview, connect, playlists } = await setup({ password: webPassword });
    const mine = (await preview.signIn()).cookie, theirs = (await preview.signIn()).cookie;
    const kept = (await connect({ url: server.url, ...login }, theirs)).cookie;
    const first = (await connect({ url: server.url, ...login }, mine)).cookie;
    // Connecting again from the same session, the connection cookie left out, replaces the first.
    const second = (await connect({ url: server.url, ...login }, mine)).cookie;
    expect(await playlists(`${mine}; ${first}`)).toEqual(disconnected);
    expect(await playlists(`${mine}; ${second}`)).toEqual(ownList);
    expect(await playlists(`${theirs}; ${kept}`)).toEqual(ownList);
    // Signing out forgets the session's connection, whichever cookies come along.
    await preview.fetch('/api/session', { method: 'DELETE', headers: { cookie: mine, origin: preview.url } });
    const again = (await preview.signIn()).cookie;
    expect(await playlists(`${again}; ${second}`)).toEqual(disconnected);
    expect(await playlists(`${theirs}; ${kept}`)).toEqual(ownList);
  });

  it('backs off repeated failures as page sign-in does, and a success in between doesn\'t reset it', async () => {
    const { server, connect, clock } = await setup();
    const wrong = { url: server.url, username: login.username, password: 'guess' };
    for (let i = 0; i < 3; i++) expect((await connect(wrong)).body).toEqual({ ok: false, error: connectFailed });
    expect((await connect({ url: server.url, ...login })).response.status).toBe(200);
    expect((await connect(wrong)).response.status).toBe(502);
    // The fifth failure starts the wait.
    expect((await connect(wrong)).response.status).toBe(502);
    const asked = server.paths.length;
    const waiting = await connect({ url: server.url, ...login });
    expect(waiting.response.status).toBe(429);
    expect(waiting.response.headers.get('retry-after')).toBe('2');
    expect(waiting.body).toEqual({ ok: false, error: 'Too many connection attempts. Try again in 2 seconds.' });
    expect(server.paths).toHaveLength(asked);
    clock.now += 2000;
    expect((await connect(wrong)).response.status).toBe(502);
    expect((await connect(wrong)).response.headers.get('retry-after')).toBe('4');
    clock.now += 4000;
    expect((await connect({ url: server.url, ...login })).response.status).toBe(200);
  });

  it('connecting again replaces this browser\'s connection', async () => {
    const { server, connect, playlists } = await setup();
    const first = (await connect({ url: server.url, ...login })).cookie;
    const second = (await connect({ url: server.url, ...login }, first)).cookie;
    expect(second).not.toBe(first);
    expect(await playlists(first)).toEqual(disconnected);
    expect(await playlists(second)).toEqual(ownList);
  });

  it('refuses a cross-origin, non-JSON, or proxied connect', async () => {
    const { server, preview, connect } = await setup();
    const body = JSON.stringify({ url: server.url, ...login });
    const refused = { ok: false, error: 'Cross-origin or non-JSON request refused.' };
    for (const headers of [{}, { origin: 'http://evil.example' }, { origin: preview.url, 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
      const response = await preview.fetch('/api/connect', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expect(await response.json()).toEqual(refused);
      expect(response.headers.get('set-cookie')).toBeNull();
    }
    expect((await preview.fetch('/api/connect', { method: 'POST', body, headers: { 'content-type': 'text/plain', origin: preview.url } })).status).toBe(403);
    expect((await preview.fetch('/api/connect')).status).toBe(405);
    // Without a password the library is for this computer only, connecting included.
    expect((await connect({ url: server.url, ...login }, undefined, { 'x-forwarded-for': '100.64.0.9' })).response.status).toBe(503);
    expect(server.paths).toEqual([]);
  });

  it('needs the page session when the host has a password, and signing out forgets the connection', async () => {
    const { server, preview, connect, session, playlists } = await setup({ password: webPassword });
    const refused = await connect({ url: server.url, ...login });
    expect(refused.response.status).toBe(401);
    expect(refused.body).toEqual({ ok: false, error: 'Sign in to use this library.' });
    expect(refused.setCookie).toBe('');
    expect((await preview.post('/api/disconnect', {})).status).toBe(401);
    expect(server.paths).toEqual([]);

    const signedIn = (await preview.signIn()).cookie;
    const connected = await connect({ url: server.url, ...login }, signedIn);
    expect(connected.response.status).toBe(200);
    const both = `${signedIn}; ${connected.cookie}`;
    expect(await session(both)).toMatchObject({ signedIn: true, required: true, connected: true, pageConnection: true });
    expect(await playlists(both)).toEqual(ownList);
    // Without the page session, the connection alone opens nothing and says nothing.
    expect(await session(connected.cookie)).toEqual({ signedIn: false, required: true, connected: false, serverName: null, pageConnection: false });
    expect((await playlists(connected.cookie)).status).toBe(401);

    const out = await preview.fetch('/api/session', { method: 'DELETE', headers: { cookie: both, origin: preview.url } });
    expect(out.headers.get('set-cookie')).toContain('squiggly-connection=; Path=/; Max-Age=0');
    const again = (await preview.signIn()).cookie;
    expect(await playlists(`${again}; ${connected.cookie}`)).toEqual(disconnected);
  });

  it('keeps no connection for a session signed out while the server was being checked', async () => {
    const { server, preview, connect, playlists } = await setup({ password: webPassword });
    const signedIn = (await preview.signIn()).cookie;
    let answer!: () => void;
    server.held.ping = new Promise(resolve => { answer = resolve; });
    const pending = connect({ url: server.url, ...login }, signedIn);
    while (!server.paths.includes('/rest/ping.view')) await new Promise(resolve => setTimeout(resolve, 5));
    // Another tab signs out while the ping is out; the browser has no connection cookie yet.
    expect((await preview.fetch('/api/session', { method: 'DELETE', headers: { cookie: signedIn, origin: preview.url } })).status).toBe(200);
    answer();
    const late = await pending;
    expect(late.response.status).toBe(401);
    expect(late.body).toEqual({ ok: false, error: 'Sign in to use this library.' });
    expect(late.setCookie).toBe('');
    // Whoever signs in next finds no connection, whatever the late answer carried.
    const again = (await preview.signIn()).cookie;
    expect(await playlists(late.cookie ? `${again}; ${late.cookie}` : again)).toEqual(disconnected);
  });

  it('works alongside a server from the environment, and the page\'s own connection wins', async () => {
    const { server, connect, session, playlists } = await setup({ client: { playlists: () => Effect.succeed([]), baseUrl: 'https://music.example.com' } as unknown as SubsonicClient });
    expect(await session()).toEqual({ signedIn: true, required: false, connected: true, serverName: 'music.example.com', pageConnection: false });
    expect(await playlists()).toEqual({ status: 200, body: { ok: true, value: [] } });
    const { cookie } = await connect({ url: server.url, ...login });
    expect(await session(cookie)).toMatchObject({ connected: true, serverName: `Navidrome (http://${server.host})`, pageConnection: true });
    expect(await playlists(cookie)).toEqual(ownList);
    expect(await playlists()).toEqual({ status: 200, body: { ok: true, value: [] } });
  });

  it('builds the environment\'s connector from its variables, as before', async () => {
    const other = await subsonic();
    const { session, playlists } = await setup({ env: {
      SQUIGGLY_PREVIEW_NAVIDROME_URL: other.url, SQUIGGLY_PREVIEW_NAVIDROME_USER: login.username, SQUIGGLY_PREVIEW_NAVIDROME_PASSWORD: login.password,
    } });
    expect(await session()).toEqual({ signedIn: true, required: false, connected: true, serverName: `http://${other.host}`, pageConnection: false });
    expect(await playlists()).toEqual(ownList);
  });
});
