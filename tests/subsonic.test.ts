import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect, Either, Fiber, Schema, TestClock, TestContext } from 'effect';
import { createHash } from 'node:crypto';
import { SubsonicClient, libraryCall, localAddress, normalizeServerUrl, plainText, reachOf, resolveServerAddress, ServerError, serverUrlCandidates, Unreachable } from '../packages/adapter-opensubsonic/client';
import { Metrics } from '../packages/core/metrics';
import { LibraryRequestSchemas, PlayTracksSchema } from '../packages/core/validation';
import { stationIdOf } from '../packages/core/stations';

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
// An album's songs as the player gets them: public track metadata plus a private stream URL.
const albumTracks = (subject: SubsonicClient, id: string) => subject.album(id).pipe(Effect.map(({ tracks }) => tracks.map(track => subject.playable(track))));
const newest = (offset: number) => client().albumList('newest', offset, 48);
async function expectRedactedFailure<E>(task: Effect.Effect<unknown, E>, secret = 'secret-marker') {
  const result = await Effect.runPromise(Effect.either(task));
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) expect(String(result.left)).not.toContain(secret);
  return result;
}

describe('server address', () => {
  it('tries HTTPS then HTTP for an address typed without a scheme, and only what was typed otherwise', () => {
    expect(serverUrlCandidates(' navidrome.example.com ')).toEqual(['https://navidrome.example.com', 'http://navidrome.example.com']);
    expect(serverUrlCandidates('localhost:4533/music')).toEqual(['https://localhost:4533/music', 'http://localhost:4533/music']);
    expect(serverUrlCandidates('http://navidrome.example.com')).toEqual(['http://navidrome.example.com']);
    expect(serverUrlCandidates('HTTPS://navidrome.example.com')).toEqual(['HTTPS://navidrome.example.com']);
  });
  it('probes for a server without sending credentials, and takes any Subsonic reply as an answer', async () => {
    const mock = serve(() => Response.json({ 'subsonic-response': { status: 'failed', error: { code: 10, message: 'Required parameter is missing' } } }));
    await expect(Effect.runPromise(client().probe())).resolves.toBe(true);
    const sent = new URL(mock.mock.calls.at(-1)![0]);
    expect(sent.pathname).toBe('/navidrome/rest/ping.view');
    for (const secret of ['u', 't', 's', 'p']) expect(sent.searchParams.has(secret)).toBe(false);
    serve(() => new Response('<html>not navidrome</html>', { headers: { 'content-type': 'text/html' } }));
    expect(Either.isLeft(await Effect.runPromise(Effect.either(client().probe())))).toBe(true);
  });
  // Each probe goes to fetch. `https` is how HTTPS fails (the cause code of a Node fetch error),
  // or 'answers'; plain HTTP answers when `http` is true.
  const resolveWith = (https: string, http: boolean) => {
    const probed: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      const url = new URL(input);
      probed.push(url.origin);
      for (const secret of ['u', 't', 's', 'p']) expect(url.searchParams.has(secret)).toBe(false);
      const answers = url.protocol === 'https:' ? https === 'answers' : http;
      return answers ? Promise.resolve(Response.json({ 'subsonic-response': { status: 'ok' } }))
        : Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('secret-marker'), { code: url.protocol === 'https:' ? https : 'ECONNREFUSED' }) }));
    }));
    const make = (candidate: typeof connection) => new SubsonicClient(candidate, new Metrics());
    return { probed, resolve: (typed: typeof connection) => Effect.runPromise(resolveServerAddress(typed, make)) };
  };
  const typed = { ...connection, url: ' music.example.com ' };
  it('signs in over HTTPS when it answers, and uses a typed scheme as given without asking', async () => {
    const { probed, resolve } = resolveWith('answers', true);
    await expect(resolve(typed)).resolves.toEqual({ type: 'ready', connection: { ...typed, url: 'https://music.example.com' } });
    expect(probed).toEqual(['https://music.example.com']);
    probed.length = 0;
    const plain = { ...connection, url: 'http://music.example.com' };
    await expect(resolve(plain)).resolves.toEqual({ type: 'ready', connection: plain });
    await expect(resolve(connection)).resolves.toEqual({ type: 'ready', connection });
    expect(probed).toEqual([]);
  });
  it.each([['refused', 'ECONNREFUSED'], ['not speaking TLS on its port', 'ERR_SSL_WRONG_VERSION_NUMBER']])(
    'only offers plain HTTP, never signing in there, when HTTPS is %s', async (_, code) => {
      const { probed, resolve } = resolveWith(code, true);
      await expect(resolve(typed)).resolves.toEqual({ type: 'plain-http', url: 'http://music.example.com' });
      expect(probed).toEqual(['https://music.example.com', 'http://music.example.com']);
    });
  it.each(['DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED'])(
    'refuses a server whose certificate fails (%s), without trying plain HTTP', async code => {
      const { probed, resolve } = resolveWith(code, true);
      const failure = await resolve(typed).catch((error: Error) => error.message);
      expect(failure).toMatch(/^This server's HTTPS certificate isn't trusted/);
      expect(failure).not.toContain('secret-marker');
      expect(probed).toEqual(['https://music.example.com']);
    });
  it('says so when neither answers', async () => {
    await expect(resolveWith('ECONNREFUSED', false).resolve(typed)).rejects.toThrow('No Navidrome server answered at music.example.com over HTTPS or HTTP');
  });
  it('tells this computer and its own network from the rest by address', () => {
    for (const url of ['http://localhost:4533', 'http://127.0.0.1', 'http://10.0.0.5', 'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.1.20:4533/music',
      'http://169.254.10.1', 'http://[::1]:4533', 'http://[fd12:3456::1]', 'http://[fe80::1]', 'http://[::ffff:192.168.1.2]', 'http://nas.localhost']) expect(localAddress(url), url).toBe(true);
    for (const url of ['http://music.example.com', 'http://172.32.0.1', 'http://8.8.8.8', 'http://192.169.0.1', 'http://100.64.0.1', 'http://[2001:db8::1]', 'http://[::ffff:8.8.8.8]', 'http://nas.local'])
      expect(localAddress(url), url).toBe(false);
  });
  it('sends every request through a fetch it was given instead of the global one', async () => {
    const global = serve(() => Response.json(envelope({})));
    const own = vi.fn((input: string, _options: RequestInit) => Promise.resolve(new URL(input).pathname.endsWith('/getOpenSubsonicExtensions.view') ? discoveryResponse() : Response.json(envelope({ type: 'navidrome' }))));
    const subject = new SubsonicClient(connection, new Metrics(), {}, { fetch: own as unknown as typeof fetch });
    await expect(Effect.runPromise(subject.ping())).resolves.toEqual({ name: 'Navidrome' });
    expect(own).toHaveBeenCalledTimes(2);
    expect(global).not.toHaveBeenCalled();
  });
  it('gives the native cover proxy an authenticated getCoverArt address without an id or size', () => {
    const base = new URL(client().coverArtBase());
    expect(base.pathname).toBe('/navidrome/rest/getCoverArt.view');
    expect(base.searchParams.get('u')).toBe('listener');
    expect(base.searchParams.get('t')).toBe(createHash('md5').update(connection.password + base.searchParams.get('s')).digest('hex'));
    expect(base.searchParams.has('id')).toBe(false);
    expect(base.searchParams.has('size')).toBe(false);
    expect(base.href).not.toContain(connection.password);
  });
  it('preserves subpaths', () => expect(normalizeServerUrl(connection.url)).toBe('https://music.example.com/navidrome'));
  it.each(['/rest/ping.view', '/rest/getAlbumList2.view/'])('accepts an explicit API address ending in %s', suffix => {
    expect(normalizeServerUrl(` https://music.example.com/navidrome${suffix} `)).toBe('https://music.example.com/navidrome');
  });
  it.each(['/app', '/rest', '/music/app', '/music/rest'])('preserves the configured base path %s', path => {
    expect(normalizeServerUrl(` https://music.example.com${path}/ `)).toBe(`https://music.example.com${path}`);
    expect(normalizeServerUrl(`https://music.example.com${path}/rest/ping.view`)).toBe(`https://music.example.com${path}`);
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
    const [item] = await Effect.runPromise(albumTracks(subject, 'a'));
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
    expect(await Effect.runPromise(newest(48))).toEqual([]);
    const calls = fetchMock.mock.calls;
    const params = calls[1][1].body as URLSearchParams;
    expect(params.get('size')).toBe('48'); expect(params.get('offset')).toBe('48');
  });
  it('pages through every track with an empty search3 query where the server is not Navidrome', async () => {
    const library = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`, title: `Song ${i}`, artist: 'A & B', suffix: 'flac', samplingRate: 96000, bitDepth: 24, coverArt: `mf-s${i}`,
      artists: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    }));
    // Navidrome's answer: the songs at that offset, and no song key past the end.
    const fetchMock = vi.fn((input: string, init: RequestInit) => {
      if (new URL(input).pathname.endsWith('/getOpenSubsonicExtensions.view')) return Promise.resolve(discoveryResponse());
      const params = init.body as URLSearchParams;
      const offset = Number(params.get('songOffset')), count = Number(params.get('songCount'));
      return Promise.resolve(Response.json(envelope({ searchResult3: offset < library.length ? { song: library.slice(offset, offset + count) } : {} })));
    });
    vi.stubGlobal('fetch', fetchMock);
    const subject = client();
    const pages: string[][] = [];
    for (let offset = 0; ; offset += 3) {
      const page = await Effect.runPromise(subject.tracks('alphabeticalByName', offset, 3));
      expect(page.sorted).toBe(false);
      pages.push(page.tracks.map(track => track.id));
      if (page.tracks.length < 3) break;
    }
    expect(pages).toEqual([['s0', 's1', 's2'], ['s3', 's4', 's5'], ['s6']]);
    const sent = () => fetchMock.mock.calls.filter(([url]) => url.endsWith('/search3.view')).map(([url, init]) => [new URL(url).pathname,
      ...['query', 'songCount', 'songOffset', 'artistCount', 'albumCount'].map(key => (init.body as URLSearchParams).get(key))]);
    expect(sent()).toEqual([0, 3, 6].map(offset => ['/navidrome/rest/search3.view', '""', '3', String(offset), '0', '0']));
    const [track] = (await Effect.runPromise(subject.tracks('newest', 6, 3))).tracks;
    expect(track).toEqual({
      id: 's6', title: 'Song 6', artist: 'A & B', album: '', duration: null, source: 'navidrome', sourceFormat: 'flac', sourceSampleRate: 96000, sourceBitDepth: 24,
      albumId: null, artistId: null, coverArt: 'mf-s6', trackNumber: null, discNumber: null, year: null, genre: null, starred: false,
      artists: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    });
    fetchMock.mockClear();
    expect((await Effect.runPromise(subject.tracks('newest', -4, 5000))).tracks).toHaveLength(7);
    expect(sent()[0].slice(2, 4)).toEqual(['500', '0']);
    expect(await Effect.runPromise(subject.tracks('newest', 100, 3))).toEqual({ tracks: [], sorted: false });
  });
  it('rejects a track page longer than asked for', async () => {
    servePayload({ searchResult3: { song: Array.from({ length: 4 }, (_, id) => ({ id: String(id), title: 's' })) } });
    await expectRedactedFailure(client().tracks('newest', 0, 3));
  });
  it('rejects an oversized album page rather than truncating it', async () => {
    servePayload({ albumList2: { album: Array.from({ length: 49 }, (_, id) => ({ id: String(id), name: 'a' })) } });
    await expectRedactedFailure(newest(0));
  });
  it('rejects an oversized song array rather than truncating it', async () => {
    servePayload({ album: { id: 'a', name: 'a', song: Array.from({ length: 501 }, (_, id) => ({ id: String(id), title: 's' })) } });
    await expectRedactedFailure(albumTracks(client(), 'a'));
  });
  it('accepts the maximum album page and queue sizes', async () => {
    servePayload({ albumList2: { album: Array.from({ length: 48 }, (_, id) => ({ id: String(id), name: 'a' })) } });
    expect(await Effect.runPromise(newest(0))).toHaveLength(48);
    servePayload({ album: { id: 'a', name: 'a', song: Array.from({ length: 500 }, (_, id) => ({ id: String(id), title: 's' })) } });
    expect(await Effect.runPromise(albumTracks(client(), 'a'))).toHaveLength(500);
  });
  it.each(['albums', 'album'])('requires the endpoint-specific payload for %s', async endpoint => {
    servePayload({});
    await expectRedactedFailure(endpoint === 'albums' ? newest(0) : albumTracks(client(), 'a'));
  });
  it('requests raw streaming and separates private URLs from public track metadata', async () => {
    servePayload(albumPayload({ id: 's1', title: 'First track', suffix: 'flac', samplingRate: 96000, bitDepth: 24 }));
    const [item] = await Effect.runPromise(albumTracks(client(), 'a'));
    expect(new URL(item.location).searchParams.get('format')).toBe('raw');
    expect(item.track).toMatchObject({ sourceFormat: 'flac', sourceSampleRate: 96000, sourceBitDepth: 24 });
    expect(JSON.stringify(item.track)).not.toContain('t=');
    expect(JSON.stringify(item.track)).not.toContain('music.example.com');
  });
  it('does not manufacture missing source resolution', async () => {
    servePayload(albumPayload());
    const [item] = await Effect.runPromise(albumTracks(client(), 'a'));
    expect(item.track.sourceSampleRate).toBeNull(); expect(item.track.sourceBitDepth).toBeNull();
    expect(item.track.duration).toBeNull();
  });
  it.each([0, null])('maps unknown resolution %s to null', async resolution => {
    servePayload(albumPayload({ id: 's', title: 's', samplingRate: resolution, bitDepth: resolution }));
    const [item] = await Effect.runPromise(albumTracks(client(), 'a'));
    expect(item.track.sourceSampleRate).toBeNull(); expect(item.track.sourceBitDepth).toBeNull();
  });
  it.each([0, 257])('rejects server IDs of length %i', async length => {
    const id = 'x'.repeat(length);
    servePayload({ albumList2: { album: [{ id, name: 'a' }] } });
    await expectRedactedFailure(newest(0));
    servePayload({ album: { id, name: 'a' } });
    await expectRedactedFailure(albumTracks(client(), 'a'));
    servePayload(albumPayload({ id, title: 's' }));
    await expectRedactedFailure(albumTracks(client(), 'a'));
  });
  it('accepts a maximum-length ingested ID in play requests', async () => {
    const id = 'x'.repeat(256);
    servePayload(albumPayload({ id, title: 's' }));
    const [item] = await Effect.runPromise(albumTracks(client(), 'a'));
    expect(Schema.decodeUnknownSync(PlayTracksSchema)([[item.track.id], 0])).toEqual([[id], 0]);
  });
  it.each([
    ['duration', -1], ['duration', Infinity], ['samplingRate', -96000], ['samplingRate', 44100.5],
    ['samplingRate', Infinity], ['bitDepth', -24], ['bitDepth', 16.5], ['bitDepth', Infinity],
  ])('rejects invalid song metadata %s=%s', async (key, value) => {
    const json = JSON.stringify(envelope(albumPayload({ id: 's', title: 's', [key]: value })), (_key, item) => item === Infinity ? '__overflow__' : item).replace('"__overflow__"', '1e400');
    serve(() => new Response(json));
    await expectRedactedFailure(albumTracks(client(), 'a'));
  });
  it.each([-1, 1.5, Infinity])('rejects invalid songCount %s', async songCount => {
    const json = JSON.stringify(envelope({ albumList2: { album: [{ id: 'a', name: 'a', songCount }] } }), (_key, item) => item === Infinity ? '__overflow__' : item).replace('"__overflow__"', '1e400');
    serve(() => new Response(json));
    await expectRedactedFailure(newest(0));
  });
  it('accepts zero counts and nonnegative fractional durations', async () => {
    servePayload({ albumList2: { album: [{ id: 'a', name: 'a', songCount: 0 }] } });
    expect(await Effect.runPromise(newest(0))).toMatchObject([{ songCount: 0 }]);
    for (const duration of [0, 1.25]) {
      servePayload(albumPayload({ id: 's', title: 's', duration }));
      expect((await Effect.runPromise(albumTracks(client(), 'a')))[0].track.duration).toBe(duration);
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
    await expectRedactedFailure(albumTracks(client(), 'a'));
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
  it('rejects a response for a different album', async () => {
    servePayload({ album: { id: 'different', name: 'Other album' } });
    await expect(Effect.runPromise(client().album('a'))).rejects.toThrow('requested album');
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
  it('posts repeated playlist IDs in the form body without collapsing duplicates', async () => {
    const fetchMock = servePayload({ playlist: { id: 'p', name: 'n', owner: 'listener' } });
    expect(await Effect.runPromise(client().createPlaylist('n', ['a', 'b', 'a']))).toMatchObject({ id: 'p', readonly: false });
    await Effect.runPromise(client().addToPlaylist('p', ['c', 'c']));
    const [create, update] = fetchMock.mock.calls.filter(([url]) => !new URL(url).pathname.endsWith('/getOpenSubsonicExtensions.view')).map(([, init]) => init.body as URLSearchParams);
    expect(create.getAll('songId')).toEqual(['a', 'b', 'a']); expect(create.get('name')).toBe('n');
    expect(update.getAll('songIdToAdd')).toEqual(['c', 'c']); expect(update.get('playlistId')).toBe('p');
    for (const params of [create, update]) expect(params.getAll('u')).toEqual([connection.username]);
  });
  it('reports a created playlist that a legacy server did not return', async () => {
    servePayload({});
    await expect(Effect.runPromise(client().createPlaylist('n', []))).rejects.toThrow('did not return it');
  });
  it.each(['text/html', 'image/svg+xml', 'application/json', ''])('rejects cover art with content type %j and cancels its body', async contentType => {
    const cancel = vi.fn();
    serve(() => new Response(new ReadableStream({ cancel }), { headers: contentType ? { 'content-type': contentType } : {} }));
    const result = await expectRedactedFailure(client().coverArt('c', 300));
    if (Either.isLeft(result)) expect(result.left.message).toBe('Cover art is not available.');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('accepts cover art up to 6 MB and rejects larger images', async () => {
    serve(() => new Response(new Uint8Array(6 * 1024 * 1024), { headers: { 'content-type': 'image/PNG; charset=binary' } }));
    expect(await Effect.runPromise(client().coverArt('c', 1))).toMatchObject({ contentType: 'image/png', bytes: { byteLength: 6 * 1024 * 1024 } });
    const cancel = vi.fn();
    serve(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6 * 1024 * 1024 + 1)); }, cancel }), { headers: { 'content-type': 'image/jpeg' } }));
    await expectRedactedFailure(client().coverArt('c', 300));
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([[Number.NaN, '32'], [-5, '32'], [599.6, '600'], [1e9, '1200']])('clamps cover size %s to %s', async (size, sent) => {
    const fetchMock = serve(() => new Response(new Uint8Array(1), { headers: { 'content-type': 'image/webp' } }));
    await Effect.runPromise(client().coverArt('c', size));
    expect((fetchMock.mock.calls[1][1].body as URLSearchParams).get('size')).toBe(sent);
  });
  it('redacts cover art transport and envelope failures', async () => {
    serve(() => Response.json({ 'subsonic-response': { status: 'failed', error: { code: 70, message: 'secret-marker' } } }));
    await expectRedactedFailure(client().coverArt('c', 300));
    serve(() => new Response('secret-marker', { status: 500 }));
    await expectRedactedFailure(client().coverArt('c', 300));
  });
  it.each([
    ['album page beyond the requested size', { albumList2: { album: Array.from({ length: 11 }, (_, id) => ({ id: String(id), name: 'a' })) } }, () => client().albumList('newest', 0, 10)],
    ['album page beyond 500', { albumList2: { album: Array.from({ length: 501 }, (_, id) => ({ id: String(id), name: 'a' })) } }, () => client().albumList('newest', 0, 500)],
    ['random songs beyond the requested size', { randomSongs: { song: [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }] } }, () => client().randomSongs({ size: 1 })],
    ['search songs beyond 40', { searchResult3: { song: Array.from({ length: 41 }, (_, id) => ({ id: String(id), title: 's' })) } }, () => client().search('q')],
    ['search artists beyond 8', { searchResult3: { artist: Array.from({ length: 9 }, (_, id) => ({ id: String(id), name: 'a' })) } }, () => client().search('q')],
    ['more than 10,000 artists', { artists: { index: [0, 1].map(index => ({ artist: Array.from({ length: 5001 }, (_, id) => ({ id: `${index}-${id}`, name: 'a' })) })) } }, () => client().artists()],
    ['playlist entries beyond 5000', { playlist: { id: 'p', name: 'p', entry: Array.from({ length: 5001 }, (_, id) => ({ id: String(id), title: 's' })) } }, () => client().playlist('p')],
    ['a genre without a name', { genres: { genre: [{ songCount: 1 }] } }, () => client().genres()],
    ['a playlist without a name', { playlists: { playlist: [{ id: 'p' }] } }, () => client().playlists()],
    ['a starred artist with an empty ID', { starred2: { artist: [{ id: '', name: 'a' }] } }, () => client().starred()],
    ['a non-string starred timestamp', { album: { id: 'a', name: 'a', song: [{ id: 's', title: 's', starred: true }] } }, () => client().album('a')],
    ['a negative year', { album: { id: 'a', name: 'a', year: -1 } }, () => client().album('a')],
    ['a fractional track number', { playlist: { id: 'p', name: 'p', entry: [{ id: 's', title: 's', track: 1.5 }] } }, () => client().playlist('p')],
    ['an oversized cover ID', { randomSongs: { song: [{ id: 's', title: 's', coverArt: 'x'.repeat(257) }] } }, () => client().randomSongs({ size: 1 })],
    ['a non-boolean readonly flag', { playlists: { playlist: [{ id: 'p', name: 'p', readonly: 'no' }] } }, () => client().playlists()],
    ['a missing artists payload', {}, () => client().artists()],
    ['a different artist', { artist: { id: 'other', name: 'a' } }, () => client().artist('a')],
    ['a different playlist', { playlist: { id: 'other', name: 'p' } }, () => client().playlist('p')],
  ] as const)('rejects %s', async (_name, payload, task) => {
    servePayload(payload);
    await expectRedactedFailure(task());
  });
  it('accepts empty library sections and maps unknown values to null', async () => {
    servePayload({ starred2: {}, searchResult3: {}, genres: {}, playlists: {}, artists: {}, randomSongs: {} });
    expect(await Effect.runPromise(client().starred())).toEqual({ artists: [], albums: [], tracks: [] });
    expect(await Effect.runPromise(client().search('q'))).toEqual({ artists: [], albums: [], tracks: [], capped: { artists: false, albums: false, tracks: false } });
    for (const task of [client().genres(), client().playlists(), client().artists(), client().randomSongs({ size: 10 })] as Effect.Effect<unknown[], Error>[]) expect(await Effect.runPromise(task)).toEqual([]);
    servePayload({ album: { id: 'a', name: 'a', artistId: '', coverArt: '', genre: '', year: 0, song: [{ id: 's', title: 's', albumId: '', discNumber: 0 }] } });
    const detail = await Effect.runPromise(client().album('a'));
    expect(detail.album).toEqual({ id: 'a', name: 'a', artist: 'Unknown artist', songCount: 1, artistId: null, year: null, genre: null, duration: null, coverArt: null, starred: false });
    expect(detail.tracks[0]).toMatchObject({ album: 'a', albumId: null, discNumber: null, coverArt: null, starred: false });
  });
  it('asks search3 for the counts and offsets given, and says which kinds came back full', async () => {
    const song = (id: number) => ({ id: `s${id}`, title: 's' });
    const fetchMock = serve(() => Response.json(envelope({ searchResult3: { artist: [{ id: 'a', name: 'a' }], song: Array.from({ length: 100 }, (_, i) => song(i)) } })));
    const sent = () => [...(fetchMock.mock.calls.at(-1)![1].body as URLSearchParams)].filter(([key]) => /Count|Offset|query/.test(key));
    // The songs tab's second page: the other kinds are skipped, and anything the server sends for them anyway is dropped.
    const page = await Effect.runPromise(client().search('night', { artistCount: 0, albumCount: 0, songCount: 100, songOffset: 100 }));
    expect(sent()).toEqual([['query', 'night'], ['artistCount', '0'], ['albumCount', '0'], ['songCount', '100'], ['songOffset', '100']]);
    expect(page.artists).toEqual([]);
    expect(page.tracks.map(track => track.id)).toEqual(Array.from({ length: 100 }, (_, i) => `s${i}`));
    expect(page.capped).toEqual({ artists: false, albums: false, tracks: true });
    // Left out, the counts are the usual 8, 16, and 40, from the top; out-of-range values are clamped.
    servePayload({ searchResult3: { artist: Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, name: 'a' })), song: [song(1)] } });
    const all = await Effect.runPromise(client().search('q'));
    expect(all.capped).toEqual({ artists: true, albums: false, tracks: false });
    const mock = serve(() => Response.json(envelope({ searchResult3: {} })));
    await Effect.runPromise(client().search('q', { artistCount: 500, artistOffset: -4, albumOffset: 32, songCount: 2.4 }));
    expect([...(mock.mock.calls.at(-1)![1].body as URLSearchParams)].filter(([key]) => /Count|Offset/.test(key)))
      .toEqual([['artistCount', '200'], ['albumCount', '16'], ['songCount', '2'], ['albumOffset', '32']]);
    // A page larger than asked is refused, as other lists are.
    servePayload({ searchResult3: { album: Array.from({ length: 3 }, (_, i) => ({ id: `al${i}`, name: 'a' })) } });
    await expectRedactedFailure(client().search('q', { albumCount: 2 }));
  });
  it('bounds search options: counts 0 to 200, offsets 0 to 1,000,000, and a bare query still works', () => {
    const decode = (value: unknown) => Either.isRight(Schema.decodeUnknownEither(LibraryRequestSchemas.search)(value));
    expect(decode(['night'])).toBe(true);
    expect(decode(['night', {}])).toBe(true);
    expect(decode(['night', { songCount: 200, songOffset: 1_000_000, artistCount: 0, albumCount: 0 }])).toBe(true);
    for (const options of [{ songCount: 201 }, { songCount: -1 }, { albumOffset: 1_000_001 }, { artistOffset: -1 }, { songCount: 1.5 }, { songCount: '10' }, null])
      expect(decode(['night', options])).toBe(false);
    expect(decode(['night', {}, 'extra'])).toBe(false);
  });
  it('validates library IPC arguments and play-tracks selections', () => {
    const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) => Either.isRight(Schema.decodeUnknownEither(schema)(value));
    expect(decode(LibraryRequestSchemas.albums, ['alphabeticalByArtist', 0, 500])).toBe(true);
    expect(decode(LibraryRequestSchemas.randomSongs, [{ size: 5, genre: 'Jazz', fromYear: 1990, toYear: 2000 }])).toBe(true);
    expect(decode(LibraryRequestSchemas.randomSongs, [{ size: 0 }])).toBe(false);
    expect(decode(LibraryRequestSchemas.tracks, ['random', 40_000, 500, '0.25'])).toBe(true);
    for (const value of [['newest', -1, 200, ''], ['newest', 0, 0, ''], ['newest', 0, 501, ''], ['newest', 0.5, 200, ''], ['starred', 0, 200, ''], ['newest', 0, 200], ['random', 0, 200, 'x'.repeat(65)]]) {
      expect(decode(LibraryRequestSchemas.tracks, value)).toBe(false);
    }
    expect(decode(LibraryRequestSchemas.createPlaylist, ['name', Array.from({ length: 1001 }, () => 's')])).toBe(false);
    expect(decode(LibraryRequestSchemas.tracks, ['highest', 0, 200, ''])).toBe(true);
    for (const value of [['track', 's', 0], ['album', 'a', 5], ['artist', 'ar', 3]]) expect(decode(LibraryRequestSchemas.rate, value)).toBe(true);
    for (const value of [['song', 's', 3], ['track', 's', 6], ['track', 's', 1.5], ['track', '', 3], ['track', 's', '3']]) expect(decode(LibraryRequestSchemas.rate, value)).toBe(false);
    expect(Schema.decodeUnknownSync(LibraryRequestSchemas.search)(['  q  '])).toEqual(['q']);
    expect(decode(PlayTracksSchema, [['a', 'a'], 1])).toBe(true);
    for (const value of [[[], 0], [['a'], -1], [['a'], 0.5], [Array.from({ length: 1001 }, () => 'a'), 0], [[''], 0], ['a', 0], [['a']]]) expect(decode(PlayTracksSchema, value)).toBe(false);
    expect(decode(LibraryRequestSchemas.updatePlaylist, ['p', { comment: '' }])).toBe(true);
    expect(decode(LibraryRequestSchemas.removeFromPlaylist, ['p', [0, 4999]])).toBe(true);
    expect(decode(LibraryRequestSchemas.reorderPlaylist, ['p', Array.from({ length: 5000 }, () => 's')])).toBe(true);
    expect(decode(LibraryRequestSchemas.lyrics, [{ id: 's', title: '', artist: '', album: '', duration: null }, true])).toBe(true);
    expect(decode(LibraryRequestSchemas.saveQueue, [Array.from({ length: 1000 }, () => 's'), 999, 604_800])).toBe(true);
    expect(decode(LibraryRequestSchemas.saveQueue, [[], 0, 0])).toBe(true);
  });
});

describe('OpenSubsonic playback extras', () => {
  const extensions = (...names: string[]) => () => Response.json(envelope({ openSubsonicExtensions: ['formPost', ...names].map(name => ({ name, versions: [1] })) }));
  const query = { id: 's', title: 'Song', artist: 'Artist', album: 'Record', duration: 200 };
  it.each([
    ['similar songs beyond 200', { similarSongs: { song: Array.from({ length: 201 }, (_, id) => ({ id: String(id), title: 's' })) } }, () => client().similarSongs('s', 500)],
    ['top songs beyond the requested count', { topSongs: { song: [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }] } }, () => client().topSongs('ar', 1)],
    ['a missing similar songs payload', {}, () => client().similarSongs('s', 5)],
    ['a lyrics line without text', { lyricsList: { structuredLyrics: [{ synced: true, line: [{ start: 1 }] }] } }, () => client().lyrics(query, false)],
    ['a negative lyrics start', { lyricsList: { structuredLyrics: [{ synced: true, line: [{ start: -1, value: 'a' }] }] } }, () => client().lyrics(query, false)],
    ['more than 5000 lyrics lines', { lyricsList: { structuredLyrics: [{ synced: false, line: Array.from({ length: 5001 }, () => ({ value: 'a' })) }] } }, () => client().lyrics(query, false)],
    ['a negative queue position', { playQueueByIndex: { position: -1, entry: [{ id: 's', title: 's' }], currentIndex: 0 } }, () => client().savedQueue()],
    ['a fractional queue index', { playQueueByIndex: { position: 0, entry: [{ id: 's', title: 's' }], currentIndex: 0.5 } }, () => client().savedQueue()],
    ['more than 5000 queued songs', { playQueueByIndex: { entry: Array.from({ length: 5001 }, (_, id) => ({ id: String(id), title: 's' })) } }, () => client().savedQueue()],
  ] as const)('rejects %s', async (_name, payload, task) => {
    serve(() => Response.json(envelope(payload)), extensions('songLyrics', 'indexBasedQueue', 'topSongsByArtistId'));
    await expectRedactedFailure(task());
  });
  it('restarts a saved queue whose current song is unknown and treats a missing queue as none', async () => {
    serve(() => Response.json(envelope({ playQueueByIndex: { currentIndex: 3, position: 5000, changed: '', entry: [{ id: 'a', title: 'a' }] } })), extensions('indexBasedQueue'));
    expect(await Effect.runPromise(client().savedQueue())).toMatchObject({ currentIndex: 0, positionSeconds: 0, changed: null, changedBy: null });
    serve(() => Response.json(envelope({ playQueue: { current: 'gone', position: 5000, entry: [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }] } })));
    expect(await Effect.runPromise(client().savedQueue())).toMatchObject({ currentIndex: 0, positionSeconds: 0 });
    serve(() => Response.json(envelope({ playQueue: { current: 7, position: 2500, entry: [{ id: '6', title: 'a' }, { id: '7', title: 'b' }] } })));
    expect(await Effect.runPromise(client().savedQueue())).toMatchObject({ currentIndex: 1, positionSeconds: 2.5 });
    for (const response of [() => Response.json(envelope({})), () => Response.json({ 'subsonic-response': { status: 'failed', error: { code: 70, message: 'secret-marker' } } })]) {
      serve(response);
      expect(await Effect.runPromise(client().savedQueue())).toBeNull();
    }
  });
  it('picks the fullest synced main lyrics layer and ignores empty ones', async () => {
    serve(() => Response.json(envelope({ lyricsList: { structuredLyrics: [
      { synced: true, line: [{ start: 0, value: ' ' }] },
      { synced: false, line: [{ value: 'a' }, { value: 'b' }, { value: 'c' }] },
      { synced: true, offset: -250, line: [{ start: 1000, value: 'one' }] },
      { synced: true, line: [{ start: 1000, value: 'one' }, { start: 2000, value: 'two' }] },
      { synced: true, kind: 'pronunciation', line: Array.from({ length: 5 }, (_, index) => ({ start: index, value: 'p' })) },
      { synced: true, line: [{ start: 1000, value: 'x' }, { value: 'unstamped' }, { start: 3000, value: 'y' }] },
    ] } })), extensions('songLyrics'));
    // Without cues the words are estimated, each line ending shortly before the next.
    expect(await Effect.runPromise(client().lyrics(query, false))).toEqual({ synced: true, source: 'server', wordTiming: 'estimated', lines: [
      { start: 1, end: 1.9, text: 'one', words: [{ start: 1, end: 1.9, text: 'one' }] },
      { start: 2, end: 3.5, text: 'two', words: [{ start: 2, end: 3.5, text: 'two' }] },
    ] });
  });
  it('does not contact LRCLIB when lookup is off, and keeps server failures as local messages', async () => {
    const fetchMock = serve(() => Response.json(envelope({ lyricsList: {} })), extensions('songLyrics'));
    expect(await Effect.runPromise(client().lyrics(query, false))).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => new URL(url).hostname === 'lrclib.net')).toBe(false);
    serve(() => Response.json({ 'subsonic-response': { status: 'failed', error: { code: 50, message: 'secret-marker' } } }), extensions('songLyrics'));
    const result = await expectRedactedFailure(client().lyrics(query, true));
    if (Either.isLeft(result)) expect(result.left.message).toContain('permission');
  });
  it('degrades name-based top songs to an empty list when the artist cannot be found', async () => {
    const fetchMock = serve(() => Response.json({ 'subsonic-response': { status: 'failed', error: { code: 70, message: 'secret-marker' } } }));
    expect(await Effect.runPromise(client().topSongs('ar', 10))).toEqual([]);
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname.split('/').pop())).toEqual(['getOpenSubsonicExtensions.view', 'getArtist.view']);
  });
});


describe('credited artists', () => {
  it('keeps the artists a server lists separately, and leaves a single artist to artistId', async () => {
    servePayload(albumPayload({ id: 's1', title: 'Aahun Aahun', artist: 'Master Saleem & Neeraj Shridhar', artistId: 'ar-1',
      artists: [{ id: 'ar-1', name: 'Master Saleem' }, { id: 'ar-2', name: 'Neeraj Shridhar' }] }));
    const [duet] = (await Effect.runPromise(client().album('a'))).tracks;
    expect(duet.artist).toBe('Master Saleem & Neeraj Shridhar');
    expect(duet.artists).toEqual([{ id: 'ar-1', name: 'Master Saleem' }, { id: 'ar-2', name: 'Neeraj Shridhar' }]);
    servePayload(albumPayload({ id: 's2', title: 'Solo', artist: 'Master Saleem', artistId: 'ar-1', artists: [{ id: 'ar-1', name: 'Master Saleem' }] }));
    const [solo] = (await Effect.runPromise(client().album('a'))).tracks;
    expect(solo.artists).toBeUndefined();
  });
});

describe('artist information, genres, years and discs', () => {
  const sentParams = (mock: ReturnType<typeof serve>) => mock.mock.calls.slice(1).map(([url, init]) => ({
    endpoint: new URL(url).pathname.split('/').pop(), params: init.body as URLSearchParams,
  }));
  it('turns a Last.fm biography into plain text and keeps only similar artists in the library', async () => {
    const mock = servePayload({ artistInfo2: {
      biography: 'Radiohead are an <b>English</b> rock band &amp; more&#46; &lt;script&gt; &#x1F3B8; <a href="https://www.last.fm/music/Radiohead">Read more on Last.fm</a>',
      musicBrainzId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', lastFmUrl: 'https://www.last.fm/music/Radiohead',
      smallImageUrl: 'https://img.example/s.jpg', mediumImageUrl: 'javascript:alert(1)', largeImageUrl: '',
      similarArtist: [{ id: 'ar2', name: ' Portishead ' }, { id: '', name: 'Not in the library' }, { name: 'No id either' }, { id: 'ar2', name: 'Portishead' }, { id: 'ar1', name: 'Radiohead' }],
    } });
    expect(await Effect.runPromise(client().artistInfo('ar1'))).toEqual({
      biography: 'Radiohead are an English rock band & more. 🎸', musicBrainzId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
      lastFmUrl: 'https://www.last.fm/music/Radiohead', images: { small: 'https://img.example/s.jpg', medium: null, large: null },
      similar: [{ id: 'ar2', name: 'Portishead' }],
    });
    const [request] = sentParams(mock);
    expect([request.endpoint, request.params.get('id'), request.params.get('count')]).toEqual(['getArtistInfo2.view', 'ar1', '20']);
  });
  it('reads a biography once however many "<" it holds, and leaves no tag in it', () => {
    // A tag stripper that looks ahead to the next ">" from every "<" takes seconds on these.
    for (const html of ['<'.repeat(100_000), '<a '.repeat(33_000), '<a'.repeat(50_000), '&lt;a'.repeat(20_000)]) {
      const started = performance.now();
      plainText(html);
      expect(performance.now() - started).toBeLessThan(100);
    }
    const tag = /<[a-z!?/]/i;
    for (const [html, text] of [
      ['<b<i>nested</i></b> and <<b>>doubled', 'nested and < >doubled'],
      ['Formed <script>alert(1)</script> in 1985 <a href="https://x" and never closed', 'Formed alert(1) in 1985'],
      ['&lt;b&gt;escaped&lt;/b&gt; &#60;script&#62;twice&#x3c;/script&#x3e; &amp;lt;i&amp;gt;', 'escaped twice &lt;i&gt;'],
      ['a &lt; b, and <3', 'a < b, and <3'],
    ]) {
      expect(plainText(html)).toBe(text);
      expect(plainText(html)).not.toMatch(tag);
    }
  });
  it('leaves everything unknown when the server knows nothing about an artist', async () => {
    servePayload({ artistInfo2: {} });
    expect(await Effect.runPromise(client().artistInfo('ar1'))).toEqual({
      biography: null, musicBrainzId: null, lastFmUrl: null, images: { small: null, medium: null, large: null }, similar: [],
    });
    servePayload({ artistInfo2: { biography: ' <a href="https://www.last.fm/music/x">Read more on Last.fm</a> ', musicBrainzId: '' } });
    expect(await Effect.runPromise(client().artistInfo('ar1'))).toMatchObject({ biography: null, musicBrainzId: null });
  });
  it('pages through a genre and rejects a page longer than asked for', async () => {
    const mock = servePayload({ songsByGenre: { song: [{ id: 's1', title: 'One', genre: 'Jazz' }, { id: 's2', title: 'Two', genre: 'Jazz' }] } });
    expect((await Effect.runPromise(client().songsByGenre('Jazz', 200, 900))).map(track => track.id)).toEqual(['s1', 's2']);
    const [request] = sentParams(mock);
    expect([request.endpoint, request.params.get('genre'), request.params.get('offset'), request.params.get('count')]).toEqual(['getSongsByGenre.view', 'Jazz', '200', '500']);
    servePayload({ songsByGenre: {} });
    expect(await Effect.runPromise(client().songsByGenre('Jazz', 0, 200))).toEqual([]);
    servePayload({ songsByGenre: { song: [{ id: 's1', title: 'One' }, { id: 's2', title: 'Two' }] } });
    expect(Either.isLeft(await Effect.runPromise(Effect.either(client().songsByGenre('Jazz', 0, 1))))).toBe(true);
  });
  it('asks for records by year with the years, and for other lists without them', async () => {
    const mock = servePayload({ albumList2: { album: [{ id: 'a', name: 'a', year: 1994 }] } });
    expect((await Effect.runPromise(client().albumList('byYear', 0, 60, { fromYear: 1990, toYear: 1999 })))[0]).toMatchObject({ id: 'a', year: 1994 });
    await Effect.runPromise(client().albumList('newest', 0, 60, { fromYear: 1990, toYear: 1999 }));
    const [byYear, newestList] = sentParams(mock).filter(request => request.endpoint === 'getAlbumList2.view').map(request => request.params);
    expect([byYear.get('type'), byYear.get('fromYear'), byYear.get('toYear')]).toEqual(['byYear', '1990', '1999']);
    expect([newestList.has('fromYear'), newestList.has('toYear')]).toEqual([false, false]);
  });
  it('keeps the disc titles an album names, and leaves them out when it names none', async () => {
    servePayload({ album: { id: 'a', name: 'a', song: [{ id: 's1', title: 'One', discNumber: 1, track: 1 }, { id: 's2', title: 'Two', discNumber: 2, track: 1 }],
      discTitles: [{ disc: 1, title: '' }, { disc: 2, title: ' Live ' }, { disc: 3 }] } });
    const detail = await Effect.runPromise(client().album('a'));
    expect(detail.discTitles).toEqual([{ disc: 2, title: 'Live' }]);
    expect(detail.tracks.map(track => [track.discNumber, track.trackNumber])).toEqual([[1, 1], [2, 1]]);
    servePayload(albumPayload());
    expect('discTitles' in await Effect.runPromise(client().album('a'))).toBe(false);
  });
  it('validates the new library arguments', () => {
    const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) => Either.isRight(Schema.decodeUnknownEither(schema)(value));
    expect(decode(LibraryRequestSchemas.albums, ['byYear', 0, 60, { fromYear: 1990, toYear: 1999 }])).toBe(true);
    expect(decode(LibraryRequestSchemas.albums, ['newest', 0, 60])).toBe(true);
    for (const value of [['byYear', 0, 60], ['newest', 0, 60, { fromYear: 1990, toYear: 1999 }], ['byYear', 0, 60, { fromYear: 1990 }], ['byYear', 0, 60, { fromYear: -1, toYear: 1999 }], ['byYear', 0, 60, null]]) {
      expect(decode(LibraryRequestSchemas.albums, value)).toBe(false);
    }
    expect(decode(LibraryRequestSchemas.artistInfo, ['ar1'])).toBe(true);
    expect(decode(LibraryRequestSchemas.artistInfo, [''])).toBe(false);
    expect(decode(LibraryRequestSchemas.songsByGenre, ['Rock', 0, 200])).toBe(true);
    for (const value of [['', 0, 200], ['Rock', -1, 200], ['Rock', 0, 0], ['Rock', 0, 501], ['x'.repeat(257), 0, 200]]) expect(decode(LibraryRequestSchemas.songsByGenre, value)).toBe(false);
  });
});

describe('playing elsewhere', () => {
  it('lists other accounts\' songs and leaves this account\'s own players out', async () => {
    const mock = servePayload({ nowPlaying: { entry: [
      { id: 's1', title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue', albumId: 'al1', coverArt: 'al1', username: 'sam', minutesAgo: 0, playerId: 1, playerName: 'Feishin' },
      // This account, in any case, on any player.
      { id: 's2', title: 'So What', artist: 'Miles Davis', username: 'Listener', minutesAgo: 2, playerId: 2 },
      { id: 's2', title: 'So What', artist: 'Miles Davis', username: 'listener', minutesAgo: 1, playerId: 3 },
      // The same song on two of someone's players is one entry.
      { id: 's3', title: 'Naima', username: 'robin', playerId: 4 },
      { id: 's3', title: 'Naima', username: 'robin', playerId: 5 },
      // Nobody's: left out rather than shown under an empty name.
      { id: 's4', title: 'Nobody', username: ' ' },
      { id: 's5', title: 'Unnamed' },
    ] } });
    const entries = await Effect.runPromise(client().nowPlaying());
    expect(entries.map(entry => [entry.username, entry.track.id, entry.track.title, entry.track.artist])).toEqual([
      ['sam', 's1', 'Blue in Green', 'Miles Davis'], ['robin', 's3', 'Naima', 'Unknown artist'],
    ]);
    expect(entries[0].track).toMatchObject({ album: 'Kind of Blue', albumId: 'al1', coverArt: 'al1', source: 'navidrome' });
    expect(mock.mock.calls.map(([url]) => new URL(url).pathname.split('/').pop())).toContain('getNowPlaying.view');
  });
  it('is empty when nobody is listening, and fails on a malformed answer', async () => {
    servePayload({ nowPlaying: {} });
    expect(await Effect.runPromise(client().nowPlaying())).toEqual([]);
    servePayload({});
    expect(await Effect.runPromise(client().nowPlaying())).toEqual([]);
    servePayload({ nowPlaying: { entry: [{ title: 'No id', username: 'sam' }] } });
    expect(Either.isLeft(await Effect.runPromise(Effect.either(client().nowPlaying())))).toBe(true);
  });
  it('takes no arguments', () => {
    const decode = (value: unknown) => Either.isRight(Schema.decodeUnknownEither(LibraryRequestSchemas.nowPlaying)(value));
    expect(decode([])).toBe(true);
    expect(decode(['sam'])).toBe(false);
  });
});

describe('internet radio stations', () => {
  const stations = { internetRadioStations: { internetRadioStation: [
    { id: 'st1', name: ' Jazz FM ', streamUrl: 'https://stream.example/jazz?token=private', homePageUrl: 'https://jazz.example/' },
    { id: 'st2', name: '', streamUrl: ' http://stream.example/talk ', homepageUrl: 'javascript:alert(1)' },
    { id: 'st3', name: 'A file', streamUrl: 'file:///etc/passwd', homePageUrl: 'https://file.example/' },
    { id: 'st4', name: 'No stream' },
    { id: 'st1', name: 'The same id again', streamUrl: 'https://stream.example/other' },
  ] } };
  it('reads stations with http(s) streams only, and keeps home pages that are web addresses', async () => {
    const mock = servePayload(stations);
    expect(await Effect.runPromise(client().radioStations())).toEqual([
      { id: 'st1', name: 'Jazz FM', streamUrl: 'https://stream.example/jazz?token=private', homePageUrl: 'https://jazz.example/' },
      { id: 'st2', name: 'Untitled station', streamUrl: 'http://stream.example/talk', homePageUrl: null },
    ]);
    expect(new URL(mock.mock.calls[1][0]).pathname).toBe('/navidrome/rest/getInternetRadioStations.view');
    servePayload({ internetRadioStations: {} });
    expect(await Effect.runPromise(client().radioStations())).toEqual([]);
    servePayload({ internetRadioStations: { internetRadioStation: [{ name: 'No id', streamUrl: 'https://stream.example/x' }] } });
    expect(Either.isLeft(await Effect.runPromise(Effect.either(client().radioStations())))).toBe(true);
  });
  it('gives the library stations without their stream addresses, and the tracks that queue them', async () => {
    servePayload(stations);
    const { value, tracks } = await Effect.runPromise(libraryCall(client(), 'radioStations', []));
    expect(value).toEqual([{ id: 'st1', name: 'Jazz FM', homePageUrl: 'https://jazz.example/' }, { id: 'st2', name: 'Untitled station', homePageUrl: null }]);
    expect(JSON.stringify(value)).not.toContain('stream.example');
    expect(tracks).toEqual([
      { id: 'station:st1', title: 'Jazz FM', artist: '', album: '', duration: null, source: 'station', sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null, albumId: null, artistId: null, coverArt: null },
      expect.objectContaining({ id: 'station:st2', title: 'Untitled station', source: 'station' }),
    ]);
    expect(Either.isLeft(await Effect.runPromise(Effect.either(libraryCall(client(), 'radioStations', ['extra']))))).toBe(true);
  });
  it('gives a station a track id no song can have, even where the server numbers both from 1', async () => {
    // Airsonic numbers songs and stations apart; the desktop knows every track by its id alone.
    servePayload(albumPayload({ id: '1', title: 'Song one' }));
    const song = (await Effect.runPromise(libraryCall(client(), 'album', ['a']))).tracks[0];
    servePayload({ internetRadioStations: { internetRadioStation: [
      { id: '1', name: 'Station one', streamUrl: 'https://stream.example/one' },
      { id: 'x'.repeat(249), name: 'Too long to queue', streamUrl: 'https://stream.example/long' },
      { id: 'x'.repeat(248), name: 'Just fits', streamUrl: 'https://stream.example/fits' },
    ] } });
    const { value, tracks } = await Effect.runPromise(libraryCall(client(), 'radioStations', []));
    expect(song.id).toBe('1');
    expect((value as { name: string }[]).map(station => station.name)).toEqual(['Station one', 'Just fits']);
    expect(tracks.map(track => track.id)).not.toContain(song.id);
    // The server's own id comes back for the stream, and the track ids pass the play request's checks.
    expect(tracks.map(stationIdOf)).toEqual(['1', 'x'.repeat(248)]);
    expect(Either.isRight(Schema.decodeUnknownEither(PlayTracksSchema)([tracks.map(track => track.id), 0]))).toBe(true);
  });
  it('finds a station stream in the last list, asks again for one it hasn\'t seen, and fails plainly for a missing one', async () => {
    const mock = servePayload(stations);
    const subject = client();
    expect(subject.knownStationLocation('st2')).toBeNull();
    // Nothing listed yet: the list is read.
    expect(await Effect.runPromise(subject.stationLocation('st2'))).toBe('http://stream.example/talk');
    const asked = mock.mock.calls.length;
    expect(await Effect.runPromise(subject.stationLocation('st1'))).toBe('https://stream.example/jazz?token=private');
    expect(mock.mock.calls.length).toBe(asked);
    expect(subject.knownStationLocation('st1')).toBe('https://stream.example/jazz?token=private');
    const missing = await Effect.runPromise(Effect.either(subject.stationLocation('st3')));
    expect(Either.isLeft(missing) && missing.left.message).toBe('This station is no longer on the server. Refresh the stations and try again.');
    expect(mock.mock.calls.length).toBe(asked + 1);
  });
});

describe('no answer, or an answer that refused', () => {
  const failure = async (task: Effect.Effect<unknown, Error>) => {
    const result = await Effect.runPromise(Effect.either(task));
    if (Either.isRight(result)) throw new Error('Expected a failure.');
    return result.left;
  };
  it('calls a refused connection unreachable, with the same words as before', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }))));
    const error = await failure(client().ping());
    expect(error).toBeInstanceOf(Unreachable);
    expect(reachOf(error)).toBe('unreachable');
    expect(error.message).toBe('Server request failed. Check the address, connection, and Navidrome/OpenSubsonic compatibility.');
  });
  it('treats a gateway saying the server is down as no answer, and other statuses as answers', async () => {
    for (const status of [502, 503, 504]) {
      serve(() => new Response('down', { status }));
      const error = await failure(client().ping());
      expect(reachOf(error)).toBe('unreachable');
      expect(error.message).toBe(`Server returned HTTP ${status}. Check the server address and reverse proxy settings.`);
    }
    for (const status of [401, 404, 500]) {
      serve(() => new Response('no', { status }));
      expect(reachOf(await failure(client().ping()))).toBe('refused');
    }
    serve(() => Response.json({ 'subsonic-response': { status: 'failed', error: { code: 40 } } }));
    expect(reachOf(await failure(client().ping()))).toBe('refused');
    serve(() => new Response('not json'));
    expect(reachOf(await failure(client().ping()))).toBe('refused');
  });
  it('calls a redirect refused, since something answered', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }))));
    const error = await failure(client().ping());
    expect(reachOf(error)).toBe('refused');
    expect(error).toBeInstanceOf(ServerError);
  });
  it('calls a body that stops arriving unreachable', async () => {
    serve(() => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('socket hang up')); } })));
    expect(reachOf(await failure(client().ping()))).toBe('unreachable');
  });
  it('calls the 15 second timeout unreachable, with the same words as before', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit) => new URL(url).pathname.endsWith('/getOpenSubsonicExtensions.view') ? Promise.resolve(discoveryResponse())
      : new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted'))))));
    const error = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.fork(Effect.flip(client().ping()));
      yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 20)));
      yield* TestClock.adjust('15 seconds');
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestContext.TestContext)));
    expect(reachOf(error)).toBe('unreachable');
    expect(error.message).toBe('The server did not respond within 15 seconds. Check your connection and try again.');
  });
  it('reads a song\'s size only when the server sends one', async () => {
    servePayload(albumPayload({ id: 's', title: 's', size: 31_457_280 }));
    expect((await Effect.runPromise(client().album('a'))).tracks[0].size).toBe(31_457_280);
    servePayload(albumPayload({ id: 's', title: 's' }));
    expect('size' in (await Effect.runPromise(client().album('a'))).tracks[0]).toBe(false);
    servePayload(albumPayload({ id: 's', title: 's', size: 0 }));
    expect('size' in (await Effect.runPromise(client().album('a'))).tracks[0]).toBe(false);
  });
  it('reports a finished play at the time it finished', async () => {
    const mock = servePayload({});
    await Effect.runPromise(client().reportPlay('s1', 'finished', 1_700_000_000_000));
    const body = mock.mock.calls.at(-1)![1].body as URLSearchParams;
    expect(body.get('time')).toBe('1700000000000');
    expect(body.get('submission')).toBe('true');
    await Effect.runPromise(client().reportPlay('s1', 'started'));
    expect((mock.mock.calls.at(-1)![1].body as URLSearchParams).has('time')).toBe(false);
  });
  it('fetches the original for keeping, and refuses an error sent as a 200 without naming the address', async () => {
    serve(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/flac' } }));
    const response = await client().original('s1', new AbortController().signal);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const mock = serve(() => Response.json({ 'subsonic-response': { status: 'failed', error: { code: 70, message: 'secret-marker' } } }));
    const refused = await client().original('s1', new AbortController().signal).catch((error: Error) => error);
    expect(refused).toBeInstanceOf(ServerError);
    expect(reachOf(refused)).toBe('refused');
    const sent = new URL(mock.mock.calls.at(-1)![0]);
    expect(sent.searchParams.get('format')).toBe('raw');
    for (const secret of ['secret-marker', sent.searchParams.get('t')!, 'music.example.com', connection.username]) expect(String((refused as Error).message)).not.toContain(secret);
    serve(() => new Response('<html/>', { headers: { 'content-type': 'text/html' } }));
    await expect(client().original('s1', new AbortController().signal)).rejects.toThrow('The server sent an error instead of the song.');
    serve(() => new Response('down', { status: 503 }));
    expect(reachOf(await client().original('s1', new AbortController().signal).catch(error => error))).toBe('unreachable');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))));
    expect(reachOf(await client().original('s1', new AbortController().signal).catch(error => error))).toBe('unreachable');
  });
});
