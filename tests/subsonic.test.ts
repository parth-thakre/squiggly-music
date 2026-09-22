import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect, Either, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { SubsonicClient, normalizeServerUrl } from '../packages/adapter-opensubsonic/client';
import { Metrics } from '../packages/core/metrics';
import { CommandSchema } from '../packages/core/validation';

afterEach(() => vi.unstubAllGlobals());
const connection = { url: 'https://music.example.com/navidrome/', username: 'listener', password: 'do-not-export' };
const envelope = (payload: object) => ({ 'subsonic-response': { status: 'ok', ...payload } });
const albumPayload = (song: object = { id: 's', title: 's' }) => ({ album: { id: 'a', name: 'a', song: [song] } });
const discoveryResponse = () => Response.json(envelope({ openSubsonicExtensions: [{ name: 'formPost', versions: [1] }] }));
function serve(response: () => Response, discovery = discoveryResponse) {
  const mock = vi.fn((input: string, _options: RequestInit) => Promise.resolve(new URL(input).pathname.endsWith('/getOpenSubsonicExtensions.view') ? discovery() : response()));
  vi.stubGlobal('fetch', mock);
  return mock;
}
const servePayload = (payload: object) => serve(() => Response.json(envelope(payload)));
const client = () => new SubsonicClient(connection, new Metrics());
async function expectRedactedFailure<E>(task: Effect.Effect<unknown, E>, secret = 'secret-marker') {
  const result = await Effect.runPromise(Effect.either(task));
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) expect(String(result.left)).not.toContain(secret);
  return result;
}

describe('server address', () => {
  it('preserves subpaths', () => expect(normalizeServerUrl(connection.url)).toBe('https://music.example.com/navidrome'));
  it.each(['/app/', '/rest', '/rest/ping.view'])('accepts a copied Navidrome address ending in %s', suffix => {
    expect(normalizeServerUrl(` https://music.example.com/navidrome${suffix} `)).toBe('https://music.example.com/navidrome');
  });
  it('preserves ports', () => expect(normalizeServerUrl('http://localhost:4533/')).toBe('http://localhost:4533'));
  it.each(['file:///etc/passwd', 'ftp://server', 'https://user:pass@server', 'https://server?token=secret', 'https://server/#fragment'])('rejects %s', url => {
    expect(() => normalizeServerUrl(url)).toThrow();
  });
  it.each(['?', '#', '?#'])('clears empty trailing delimiters %s before constructing endpoints', async suffix => {
    const mock = servePayload(albumPayload());
    const subject = new SubsonicClient({ ...connection, url: connection.url + suffix }, new Metrics());
    expect(subject.baseUrl).toBe('https://music.example.com/navidrome');
    await Effect.runPromise(subject.ping());
    const [item] = await Effect.runPromise(subject.albumQueue('a'));
    expect(mock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/navidrome/rest/getOpenSubsonicExtensions.view', '/navidrome/rest/ping.view', '/navidrome/rest/getAlbum.view',
    ]);
    expect(new URL(item.location).pathname).toBe('/navidrome/rest/stream.view');
    expect(new URL(item.location).hash).toBe('');
  });
});

describe('OpenSubsonic', () => {
  it.each([['navidrome', 'Navidrome'], [undefined, 'OpenSubsonic']])('identifies server type %s', async (type, name) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json({ 'subsonic-response': { status: 'ok', type } }))));
    expect(await Effect.runPromise(new SubsonicClient(connection, new Metrics()).ping())).toEqual({ name });
  });
  it('discovers formPost once without credentials, then posts salted authentication', async () => {
    const fetchMock = servePayload({});
    const subject = client();
    await Effect.runPromise(subject.ping());
    await Effect.runPromise(subject.ping());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const calls = fetchMock.mock.calls;
    const [discoveryUrl, discoveryInit] = calls[0];
    expect(new URL(discoveryUrl).pathname).toBe('/navidrome/rest/getOpenSubsonicExtensions.view');
    expect(discoveryInit.method).toBe('GET');
    for (const key of ['u', 't', 's', 'p']) expect(new URL(discoveryUrl).searchParams.has(key)).toBe(false);
    const [url, init] = calls[1];

    expect(url).toBe('https://music.example.com/navidrome/rest/ping.view');
    expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
    const params = init.body as URLSearchParams;
    expect(params.get('t')).toBe(createHash('md5').update(connection.password + params.get('s')).digest('hex'));
    expect(params.toString()).not.toContain(connection.password);
    expect(params.has('p')).toBe(false);
  });
  it.each(['absent', 'unsupported-version', 'legacy-http', 'legacy-envelope'])('caches GET fallback when formPost is %s', async mode => {
    const fetchMock = serve(() => Response.json(envelope({})), () => {
      if (mode === 'legacy-http') return new Response('Not found', { status: 404 });
      if (mode === 'legacy-envelope') return Response.json({ 'subsonic-response': { status: 'failed', error: { code: 70 } } });
      return Response.json(envelope({ openSubsonicExtensions: mode === 'absent' ? [] : [{ name: 'formPost', versions: [2] }] }));
    });
    const subject = client();
    await Effect.runPromise(subject.ping());
    await Effect.runPromise(subject.ping());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const calls = fetchMock.mock.calls;
    for (const [url, init] of calls.slice(1)) {
      expect(init.method).toBe('GET'); expect(init.body).toBeUndefined(); expect(init.redirect).toBe('error');
      const params = new URL(url).searchParams;
      expect(params.get('u')).toBe(connection.username);
      expect(params.get('t')).toBe(createHash('md5').update(connection.password + params.get('s')).digest('hex'));
      expect(url).not.toContain(connection.password);
    }
  });
  it('bounds album requests and accepts a genuinely empty library', async () => {
    const fetchMock = servePayload({ albumList2: {} });
    expect(await Effect.runPromise(client().albums(48))).toEqual([]);
    const calls = fetchMock.mock.calls;
    const params = calls[1][1].body as URLSearchParams;
    expect(params.get('size')).toBe('48'); expect(params.get('offset')).toBe('48');
  });
  it('rejects an oversized album page rather than truncating it', async () => {
    servePayload({ albumList2: { album: Array.from({ length: 49 }, (_, id) => ({ id: String(id), name: 'a' })) } });
    await expectRedactedFailure(client().albums(0));
  });
  it('rejects an oversized song array rather than truncating it', async () => {
    servePayload({ album: { id: 'a', name: 'a', song: Array.from({ length: 501 }, (_, id) => ({ id: String(id), title: 's' })) } });
    await expectRedactedFailure(client().albumQueue('a'));
  });
  it('accepts the maximum album page and queue sizes', async () => {
    servePayload({ albumList2: { album: Array.from({ length: 48 }, (_, id) => ({ id: String(id), name: 'a' })) } });
    expect(await Effect.runPromise(client().albums(0))).toHaveLength(48);
    servePayload({ album: { id: 'a', name: 'a', song: Array.from({ length: 500 }, (_, id) => ({ id: String(id), title: 's' })) } });
    expect(await Effect.runPromise(client().albumQueue('a'))).toHaveLength(500);
  });
  it.each(['albums', 'queue'])('requires the endpoint-specific payload for %s', async endpoint => {
    servePayload({});
    await expectRedactedFailure(endpoint === 'albums' ? client().albums(0) : client().albumQueue('a'));
  });
  it('requests raw streaming and separates private URLs from public track metadata', async () => {
    servePayload(albumPayload({ id: 's1', title: 'First track', suffix: 'flac', samplingRate: 96000, bitDepth: 24 }));
    const [item] = await Effect.runPromise(client().albumQueue('a'));
    expect(new URL(item.location).searchParams.get('format')).toBe('raw');
    expect(item.track).toMatchObject({ sourceFormat: 'flac', sourceSampleRate: 96000, sourceBitDepth: 24 });
    expect(JSON.stringify(item.track)).not.toContain('t=');
    expect(JSON.stringify(item.track)).not.toContain('music.example.com');
  });
  it('does not manufacture missing source resolution', async () => {
    servePayload(albumPayload());
    const [item] = await Effect.runPromise(client().albumQueue('a'));
    expect(item.track.sourceSampleRate).toBeNull(); expect(item.track.sourceBitDepth).toBeNull();
    expect(item.track.duration).toBeNull();
  });
  it.each([0, null])('maps unknown resolution %s to null', async resolution => {
    servePayload(albumPayload({ id: 's', title: 's', samplingRate: resolution, bitDepth: resolution }));
    const [item] = await Effect.runPromise(client().albumQueue('a'));
    expect(item.track.sourceSampleRate).toBeNull(); expect(item.track.sourceBitDepth).toBeNull();
  });
  it.each([0, 257])('rejects server IDs of length %i', async length => {
    const id = 'x'.repeat(length);
    servePayload({ albumList2: { album: [{ id, name: 'a' }] } });
    await expectRedactedFailure(client().albums(0));
    servePayload({ album: { id, name: 'a' } });
    await expectRedactedFailure(client().albumQueue('a'));
    servePayload(albumPayload({ id, title: 's' }));
    await expectRedactedFailure(client().albumQueue('a'));
  });
  it('accepts a maximum-length ingested ID in select commands', async () => {
    const id = 'x'.repeat(256);
    servePayload(albumPayload({ id, title: 's' }));
    const [item] = await Effect.runPromise(client().albumQueue('a'));
    expect(Schema.decodeUnknownSync(CommandSchema)({ type: 'select', id: item.track.id })).toEqual({ type: 'select', id });
  });
  it.each([
    ['duration', -1], ['duration', Infinity], ['samplingRate', -96000], ['samplingRate', 44100.5],
    ['samplingRate', Infinity], ['bitDepth', -24], ['bitDepth', 16.5], ['bitDepth', Infinity],
  ])('rejects invalid song metadata %s=%s', async (key, value) => {
    const json = JSON.stringify(envelope(albumPayload({ id: 's', title: 's', [key]: value })), (_key, item) => item === Infinity ? '__overflow__' : item).replace('"__overflow__"', '1e400');
    serve(() => new Response(json));
    await expectRedactedFailure(client().albumQueue('a'));
  });
  it.each([-1, 1.5, Infinity])('rejects invalid songCount %s', async songCount => {
    const json = JSON.stringify(envelope({ albumList2: { album: [{ id: 'a', name: 'a', songCount }] } }), (_key, item) => item === Infinity ? '__overflow__' : item).replace('"__overflow__"', '1e400');
    serve(() => new Response(json));
    await expectRedactedFailure(client().albums(0));
  });
  it('accepts zero counts and nonnegative fractional durations', async () => {
    servePayload({ albumList2: { album: [{ id: 'a', name: 'a', songCount: 0 }] } });
    expect(await Effect.runPromise(client().albums(0))).toMatchObject([{ songCount: 0 }]);
    for (const duration of [0, 1.25]) {
      servePayload(albumPayload({ id: 's', title: 's', duration }));
      expect((await Effect.runPromise(client().albumQueue('a')))[0].track.duration).toBe(duration);
    }
  });
  it('redacts authenticated GET URLs from transport errors and metrics', async () => {
    const metrics = new Metrics();
    const fetchMock = vi.fn((url: string) => {
      if (new URL(url).pathname.endsWith('/getOpenSubsonicExtensions.view')) return Promise.resolve(Response.json(envelope({ openSubsonicExtensions: [] })));
      return Promise.reject(new Error(`${url}&secret-marker`));
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await expectRedactedFailure(new SubsonicClient(connection, metrics).ping());
    const token = new URL(fetchMock.mock.calls[1][0]).searchParams.get('t')!;
    if (Either.isLeft(result)) {
      expect(String(result.left)).not.toContain(token);
      expect(String(result.left)).not.toContain(connection.username);
      expect(String(result.left)).not.toContain('music.example.com');
    }
    expect(JSON.stringify(metrics.snapshot())).not.toContain(token);
  });
  it('cancels HTTP non-2xx bodies and redacts their details', async () => {
    const cancel = vi.fn();
    serve(() => new Response(new ReadableStream({ cancel }), { status: 503, statusText: 'secret-marker' }));
    await expectRedactedFailure(client().ping());
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('redacts secret messages in failed Subsonic envelopes', async () => {
    serve(() => Response.json({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'secret-marker' } } }));
    await expectRedactedFailure(client().ping());
  });
  it('rejects invalid JSON text without returning its contents', async () => {
    serve(() => new Response('secret-marker is not JSON'));
    await expectRedactedFailure(client().ping());
  });
  it('rejects album payloads that do not match the response schema', async () => {
    servePayload({ album: { id: 1 } });
    await expectRedactedFailure(client().albumQueue('a'));
  });
  it('cancels responses above the byte limit', async () => {
    const cancel = vi.fn();
    serve(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel,
    })));
    await expectRedactedFailure(client().ping());
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([[40, 'Incorrect username or password'], [50, 'permission'], [70, 'no longer available']])('maps protocol error %s without forwarding server text', async (code, message) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json({ 'subsonic-response': {
      status: 'failed', error: { code, message: 'private-password https://server?t=secret' },
    } }))));
    const result = await Effect.runPromise(Effect.either(new SubsonicClient(connection, new Metrics()).ping()));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain(message);
      expect(result.left.message).not.toMatch(/private-password|secret/);
    }
  });
  it.each([
    [{ id: 'different', name: 'Other album' }, 'requested album'],
    [{ id: 'a', name: 'Empty album' }, 'no playable tracks'],
  ])('rejects an unplayable album response %#', async (album, message) => {
    servePayload({ album });
    await expect(Effect.runPromise(client().albumQueue('a'))).rejects.toThrow(message);
  });
  it('interrupting Effect cancels the underlying request', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted'))));
    }));
    await Effect.runPromise(client().ping().pipe(Effect.timeout('20 millis'), Effect.either));
    expect(signal?.aborted).toBe(true);
  });
});
