import { createServer } from 'node:http';
import { once } from 'node:events';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { type SubsonicClient, libraryMethods } from '../packages/adapter-opensubsonic/client';
import { isLoopbackHost, refusal } from '../scripts/navidrome-preview';
import { previewServer, webPassword } from './previewHarness';

const day = 24 * 60 * 60 * 1000;
const audio = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 256));
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });

// A stand-in connector (password null: no SQUIGGLY_WEB_PASSWORD): playlists and deletePlaylist answer in memory, cover art is a fixed
// PNG, and stream locations point at a local audio fixture that honours Range.
async function setup({ password = webPassword as string | null, host = '127.0.0.1' as string | boolean | undefined } = {}) {
  const deleted: string[] = [];
  const audioServer = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d+)?$/.exec(request.headers.range ?? '');
    response.setHeader('content-type', 'audio/flac');
    response.setHeader('accept-ranges', 'bytes');
    if (!range) return void response.end(audio);
    const start = Number(range[1]); const end = range[2] ? Number(range[2]) : audio.length - 1;
    response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${audio.length}`, 'content-length': String(end - start + 1) });
    response.end(audio.subarray(start, end + 1));
  });
  audioServer.listen(0, '127.0.0.1');
  await once(audioServer, 'listening');
  const { port } = audioServer.address() as { port: number };
  const client = {
    playlists: () => Effect.succeed([]),
    deletePlaylist: (id: string) => Effect.sync(() => { deleted.push(id); }),
    coverArt: () => Effect.succeed({ contentType: 'image/png', bytes: png }),
    streamLocation: (id: string) => `http://127.0.0.1:${port}/rest/stream.view?id=${encodeURIComponent(id)}&t=secret`,
  } as unknown as SubsonicClient;
  const clock = { now: 1_800_000_000_000 };
  const preview = await previewServer({ env: password === null ? {} : { SQUIGGLY_WEB_PASSWORD: password }, client, now: () => clock.now }, host);
  cleanup.push(preview.close, () => { audioServer.closeAllConnections(); return new Promise<void>(resolve => audioServer.close(() => resolve())); });
  return { preview, deleted, clock };
}
const signedOut = { ok: false, error: 'Sign in to use this library.' };

describe('browser preview authentication', () => {
  it('answers 401 on every library, cover and stream route without a session', async () => {
    const { preview, deleted } = await setup();
    for (const method of [...libraryMethods, 'notAMethod']) {
      const response = await preview.post(`/api/${method}`, []);
      expect(response.status, method).toBe(401);
      expect(await response.json()).toEqual(signedOut);
    }
    for (const [path, method] of [['/api/cover?id=c1&size=300', 'GET'], ['/api/stream?id=s1', 'GET'], ['/api/stream?id=s1', 'HEAD'], ['/api/deletePlaylist', 'GET']] as const) {
      const response = await preview.fetch(path, { method });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    // Cookies that were never issued, or are malformed, do not count.
    for (const cookie of ['squiggly_session=' + 'A'.repeat(43), 'squiggly_session=', 'squiggly_session=../../x', 'other=1']) {
      expect((await preview.post('/api/deletePlaylist', ['p1'], cookie)).status).toBe(401);
    }
    expect(deleted).toEqual([]);
    expect(await (await preview.fetch('/api/session')).json()).toEqual({ ok: true, value: { signedIn: false, required: true } });
  });

  it('signs in with the right password and issues a strict HttpOnly cookie', async () => {
    const { preview, deleted } = await setup();
    const wrong = await preview.signIn('not the password at all');
    expect(wrong.response.status).toBe(401);
    expect(wrong.body).toEqual({ ok: false, error: 'That password is incorrect.' });
    expect(wrong.setCookie).toBe('');
    for (const body of [{}, { password: 5 }, { password: 'x'.repeat(1025) }]) {
      const response = await preview.post('/api/session', body);
      expect(response.status).toBe(400);
    }
    expect((await preview.fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: preview.url }, body: '{' })).status).toBe(400);

    const right = await preview.signIn();
    expect(right.response.status).toBe(200);
    expect(right.body).toEqual({ ok: true });
    expect(right.cookie).toMatch(/^squiggly_session=[\w-]{43}$/);
    const flags = right.setCookie.split(';').slice(1).map(flag => flag.trim());
    expect(flags).toEqual(['Path=/', `Max-Age=${30 * 24 * 60 * 60}`, 'HttpOnly', 'SameSite=Strict']);
    expect(await (await preview.fetch('/api/session', { headers: { cookie: right.cookie } })).json()).toEqual({ ok: true, value: { signedIn: true, required: true } });
    expect(await (await preview.post('/api/deletePlaylist', ['p1'], right.cookie)).json()).toEqual({ ok: true });
    expect(deleted).toEqual(['p1']);
    // Each sign-in gets its own session.
    expect((await preview.signIn()).cookie).not.toBe(right.cookie);
  });

  it('marks the cookie Secure only for HTTPS reported by a loopback proxy', async () => {
    const { preview } = await setup();
    expect((await preview.signIn(webPassword, { 'x-forwarded-proto': 'https' })).setCookie).toMatch(/; Secure$/);
    expect((await preview.signIn(webPassword, { 'x-forwarded-proto': 'http' })).setCookie).not.toMatch(/Secure/);
    // A tailnet client cannot claim HTTPS for itself.
    expect((await preview.signIn(webPassword, { 'x-forwarded-proto': 'https', 'x-test-peer': '100.64.0.7' })).setCookie).not.toMatch(/Secure/);
  });

  it('backs off repeated wrong passwords per client address', async () => {
    const { preview, clock } = await setup();
    for (let attempt = 1; attempt <= 5; attempt++) expect((await preview.signIn('wrong password ' + attempt)).response.status).toBe(401);
    const blocked = await preview.signIn();
    expect(blocked.response.status).toBe(429);
    expect(blocked.response.headers.get('retry-after')).toBe('2');
    expect(blocked.body).toEqual({ ok: false, error: 'Too many sign-in attempts. Try again in 2 seconds.' });
    expect(blocked.setCookie).toBe('');
    // Other addresses, and tailnet clients relayed by a loopback proxy, have their own count.
    expect((await preview.signIn(webPassword, { 'x-test-peer': '100.64.0.8' })).response.status).toBe(200);
    expect((await preview.signIn(webPassword, { 'x-forwarded-for': '100.64.0.9' })).response.status).toBe(200);
    // The wait doubles with each further failure.
    clock.now += 2000;
    expect((await preview.signIn('wrong again')).response.status).toBe(401);
    expect((await preview.signIn()).response.headers.get('retry-after')).toBe('4');
    clock.now += 4000;
    expect((await preview.signIn()).response.status).toBe(200);
    // Success clears the record.
    expect((await preview.signIn('wrong once more')).response.status).toBe(401);
    expect((await preview.signIn()).response.status).toBe(200);
    // The wait is capped at 15 minutes.
    for (let attempt = 0; attempt < 20; attempt++) {
      await preview.signIn('wrong');
      clock.now += 15 * 60 * 1000;
    }
    await preview.signIn('wrong');
    expect(Number((await preview.signIn()).response.headers.get('retry-after'))).toBe(15 * 60);
  });

  it('signs out and forgets the session', async () => {
    const { preview } = await setup();
    const { cookie } = await preview.signIn();
    // Signing out needs the same proof of origin as any write.
    expect((await preview.fetch('/api/session', { method: 'DELETE', headers: { cookie } })).status).toBe(403);
    const response = await preview.fetch('/api/session', { method: 'DELETE', headers: { cookie, origin: preview.url } });
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('set-cookie')).toBe('squiggly_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
    expect(await (await preview.post('/api/playlists', [], cookie)).json()).toEqual(signedOut);
    expect(await (await preview.fetch('/api/session', { headers: { cookie } })).json()).toEqual({ ok: true, value: { signedIn: false, required: true } });
  });

  it('expires sessions 30 days after their last use', async () => {
    const { preview, clock } = await setup();
    const first = (await preview.signIn()).cookie;
    const second = (await preview.signIn()).cookie;
    clock.now += 20 * day;
    const status = await preview.fetch('/api/session', { headers: { cookie: first } });
    expect(status.headers.get('set-cookie')).toMatch(new RegExp(`^${first}; Path=/; Max-Age=${30 * 24 * 60 * 60};`));
    clock.now += 10 * day;
    expect((await preview.post('/api/playlists', [], second)).status).toBe(401);
    expect((await preview.post('/api/playlists', [], first)).status).toBe(200);
    clock.now += 30 * day + 1;
    expect((await preview.post('/api/playlists', [], first)).status).toBe(401);
  });

  it('refuses writes without a matching Origin or Sec-Fetch-Site: same-origin', async () => {
    const { preview, deleted } = await setup();
    const { cookie } = await preview.signIn();
    const refused = { ok: false, error: 'Cross-origin or non-JSON request refused.' };
    const write = (headers: Record<string, string>) => preview.fetch('/api/deletePlaylist', { method: 'POST', body: '["p1"]', headers: { 'content-type': 'application/json', cookie, ...headers } });
    for (const headers of [{}, { origin: 'http://evil.example' }, { origin: 'null' }, { origin: preview.url, 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'x-forwarded-host': 'evil.example', origin: 'http://evil.example', 'x-test-peer': '100.64.0.7' }] as Record<string, string>[]) {
      const response = await write(headers);
      expect(response.status, JSON.stringify(headers)).toBe(403);
      expect(await response.json()).toEqual(refused);
    }
    expect((await preview.fetch('/api/deletePlaylist', { method: 'POST', body: '["p1"]', headers: { 'content-type': 'text/plain', cookie, origin: preview.url } })).status).toBe(403);
    expect((await preview.fetch('/api/session', { method: 'POST', body: JSON.stringify({ password: webPassword }), headers: { 'content-type': 'application/json' } })).status).toBe(403);
    expect(deleted).toEqual([]);
    expect((await write({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await write({ origin: preview.url, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    // Behind `tailscale serve` the browser's host arrives as X-Forwarded-Host.
    expect((await write({ origin: 'https://music.tail1234.ts.net', 'x-forwarded-host': 'music.tail1234.ts.net' })).status).toBe(200);
    expect(deleted).toEqual(['p1', 'p1', 'p1']);
  });

  it('streams and serves cover art to a signed-in browser with only the cookie', async () => {
    const { preview } = await setup();
    const { cookie } = await preview.signIn();
    const cover = await preview.fetch('/api/cover?id=c1&size=300', { headers: { cookie } });
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await cover.arrayBuffer())).toEqual(png);
    const whole = await preview.fetch('/api/stream?id=s1', { headers: { cookie } });
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(audio);
    const part = await preview.fetch('/api/stream?id=s1', { headers: { cookie, range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(Buffer.from(await part.arrayBuffer())).toEqual(audio.subarray(10, 20));
    expect((await preview.fetch('/api/stream?id=s1', { method: 'HEAD', headers: { cookie } })).status).toBe(200);
  });
});

describe('browser preview binding', () => {
  it.each([[true], ['0.0.0.0'], ['::'], ['100.64.0.1'], ['music.local']])('refuses /api on host %s without a password', async host => {
    const { preview, deleted } = await setup({ password: null, host });
    const error = 'Set SQUIGGLY_WEB_PASSWORD (12 or more characters) to serve this library beyond 127.0.0.1.';
    expect(preview.errors.join('')).toContain(error);
    for (const response of [await preview.fetch('/api/session'), await preview.post('/api/deletePlaylist', ['p1']), await preview.fetch('/api/stream?id=s1'), (await preview.signIn()).response]) {
      expect(response.status).toBe(503);
    }
    expect(await (await preview.post('/api/playlists', [])).json()).toEqual({ ok: false, error });
    expect(deleted).toEqual([]);
  });

  it('refuses a password shorter than 12 characters on any host', async () => {
    const { preview } = await setup({ password: 'short-pass1' });
    expect(preview.errors.join('')).toContain('SQUIGGLY_WEB_PASSWORD must be at least 12 characters.');
    expect((await preview.signIn('short-pass1')).response.status).toBe(503);
  });

  it('serves this computer without a password on a loopback bind, but not through a proxy', async () => {
    const { preview, deleted } = await setup({ password: null });
    expect(preview.errors).toEqual([]);
    expect(await (await preview.fetch('/api/session')).json()).toEqual({ ok: true, value: { signedIn: true, required: false } });
    expect(await (await preview.post('/api/deletePlaylist', ['p1'])).json()).toEqual({ ok: true });
    expect(deleted).toEqual(['p1']);
    // Writes still need a same-origin browser.
    expect((await preview.fetch('/api/deletePlaylist', { method: 'POST', body: '["p1"]', headers: { 'content-type': 'application/json' } })).status).toBe(403);
    for (const headers of [{ 'x-forwarded-for': '100.64.0.9' }, { 'x-forwarded-proto': 'https' }, { forwarded: 'for=100.64.0.9' }] as Record<string, string>[]) {
      expect((await preview.fetch('/api/stream?id=s1', { headers })).status).toBe(503);
    }
    expect(deleted).toEqual(['p1']);
  });

  it('works with a password on a tailnet bind', async () => {
    const { preview } = await setup({ host: '100.64.0.1' });
    expect(preview.errors).toEqual([]);
    const { cookie } = await preview.signIn();
    expect((await preview.post('/api/playlists', [], cookie)).status).toBe(200);
  });

  it('classifies bind hosts', () => {
    for (const host of [undefined, false, 'localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1']) expect(isLoopbackHost(host), String(host)).toBe(true);
    for (const host of [true, '', '0.0.0.0', '::', '100.64.0.1', '192.168.1.2', 'music.local', '127.0.0.1.example.com']) expect(isLoopbackHost(host), String(host)).toBe(false);
    expect(refusal('127.0.0.1', undefined)).toBeNull();
    expect(refusal(true, 'twelve chars')).toBeNull();
  });
});
