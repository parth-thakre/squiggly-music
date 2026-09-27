import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect, Either, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { SubsonicClient, normalizeServerUrl } from '../packages/adapter-opensubsonic/client';
import { Metrics } from '../packages/core/metrics';
import { LibraryRequestSchemas, PlayTracksSchema } from '../packages/core/validation';

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
    expect(await Effect.runPromise(client().search('q'))).toEqual({ artists: [], albums: [], tracks: [] });
    for (const task of [client().genres(), client().playlists(), client().artists(), client().randomSongs({ size: 10 })] as Effect.Effect<unknown[], Error>[]) expect(await Effect.runPromise(task)).toEqual([]);
    servePayload({ album: { id: 'a', name: 'a', artistId: '', coverArt: '', genre: '', year: 0, song: [{ id: 's', title: 's', albumId: '', discNumber: 0 }] } });
    const detail = await Effect.runPromise(client().album('a'));
    expect(detail.album).toEqual({ id: 'a', name: 'a', artist: 'Unknown artist', songCount: 1, artistId: null, year: null, genre: null, duration: null, coverArt: null, starred: false });
    expect(detail.tracks[0]).toMatchObject({ album: 'a', albumId: null, discNumber: null, coverArt: null, starred: false });
  });
  it('validates library IPC arguments and play-tracks selections', () => {
    const decode = <A, I>(schema: Schema.Schema<A, I>, value: unknown) => Either.isRight(Schema.decodeUnknownEither(schema)(value));
    expect(decode(LibraryRequestSchemas.albums, ['alphabeticalByArtist', 0, 500])).toBe(true);
    expect(decode(LibraryRequestSchemas.randomSongs, [{ size: 5, genre: 'Jazz', fromYear: 1990, toYear: 2000 }])).toBe(true);
    expect(decode(LibraryRequestSchemas.randomSongs, [{ size: 0 }])).toBe(false);
    expect(decode(LibraryRequestSchemas.createPlaylist, ['name', Array.from({ length: 1001 }, () => 's')])).toBe(false);
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
    expect(await Effect.runPromise(client().lyrics(query, false))).toEqual({ synced: true, source: 'server', lines: [{ start: 1, text: 'one' }, { start: 2, text: 'two' }] });
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

