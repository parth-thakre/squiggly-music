import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect, Either } from 'effect';
import { createHash } from 'node:crypto';
import { SubsonicClient, normalizeServerUrl } from '../packages/adapter-opensubsonic/client';
import { Metrics } from '../packages/core/metrics';

afterEach(() => vi.unstubAllGlobals());
const connection = { url: 'https://music.example.com/navidrome/', username: 'listener', password: 'do-not-export' };

describe('server address', () => {
  it('preserves subpaths', () => expect(normalizeServerUrl(connection.url)).toBe('https://music.example.com/navidrome'));
  it.each(['file:///etc/passwd', 'ftp://server', 'https://user:pass@server', 'https://server?token=secret', 'https://server/#fragment'])('rejects %s', url => {
    expect(() => normalizeServerUrl(url)).toThrow();
  });
});

describe('OpenSubsonic', () => {
  it('posts salted token authentication without plaintext password or URL credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ 'subsonic-response': { status: 'ok' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new SubsonicClient(connection, new Metrics());
    await Effect.runPromise(client.ping());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://music.example.com/navidrome/rest/ping.view');
    expect(init.method).toBe('POST'); expect(init.redirect).toBe('error');
    const params = init.body as URLSearchParams;
    expect(params.get('t')).toBe(createHash('md5').update(connection.password + params.get('s')).digest('hex'));
    expect(params.toString()).not.toContain(connection.password);
    expect(params.has('p')).toBe(false);
  });
  it('bounds album pages and handles empty libraries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ 'subsonic-response': { status: 'ok', albumList2: {} } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new SubsonicClient(connection, new Metrics());
    expect(await Effect.runPromise(client.albums(48))).toEqual([]);
    expect(fetchMock.mock.calls[0][1].body.get('size')).toBe('48');
    expect(fetchMock.mock.calls[0][1].body.get('offset')).toBe('48');
  });
  it('requests raw streaming and separates private URLs from public track metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ 'subsonic-response': {
      status: 'ok', album: { id: 'album', name: 'Record', song: [{ id: 's1', title: 'First track', suffix: 'flac', samplingRate: 96000, bitDepth: 24 }] },
    } })));
    const client = new SubsonicClient(connection, new Metrics());
    const [item] = await Effect.runPromise(client.albumQueue('album'));
    expect(new URL(item.location).searchParams.get('format')).toBe('raw');
    expect(item.track).toMatchObject({ sourceFormat: 'flac', sourceSampleRate: 96000, sourceBitDepth: 24 });
    expect(JSON.stringify(item.track)).not.toContain('t=');
    expect(JSON.stringify(item.track)).not.toContain('music.example.com');
  });
  it('does not manufacture missing source resolution', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ 'subsonic-response': {
      status: 'ok', album: { id: 'a', name: 'a', song: [{ id: 's', title: 's' }] },
    } })));
    const [item] = await Effect.runPromise(new SubsonicClient(connection, new Metrics()).albumQueue('a'));
    expect(item.track.sourceSampleRate).toBeNull(); expect(item.track.sourceBitDepth).toBeNull();
  });
  it('redacts fetch and server error details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('https://server/stream?t=secret')));
    const result = await Effect.runPromise(Effect.either(new SubsonicClient(connection, new Metrics()).ping()));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(String(result.left)).not.toContain('secret');
  });
  it('validates malformed JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ 'subsonic-response': { status: 'ok', album: { id: 1 } } })));
    const result = await Effect.runPromise(Effect.either(new SubsonicClient(connection, new Metrics()).albumQueue('a')));
    expect(Either.isLeft(result)).toBe(true);
  });
  it('interrupting Effect cancels the underlying request', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted'))));
    }));
    await Effect.runPromise(new SubsonicClient(connection, new Metrics()).ping().pipe(Effect.timeout('20 millis'), Effect.either));
    expect(signal?.aborted).toBe(true);
  });
});
