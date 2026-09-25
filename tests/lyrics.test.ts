import { Effect, Either } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { lrclibLyrics, lrclibUserAgent, parseLrc } from '../packages/lyrics/lrclib';

describe('LRC parser', () => {
  it('reads centisecond and millisecond stamps, skips metadata and strips word stamps', () => {
    expect(parseLrc([
      '[ar:Artist]', '[ti:Song]', '[al:Record]', '[by:someone]', '[length: 03:20]', '[#:comment]', '',
      '[00:01.5]First', '[00:12.34] Second  line ', '[01:02.345]<01:02.345>Word <01:03.00>stamps', '[1:05]No fraction', '[00:07:50]Colon fraction',
    ].join('\n'))).toEqual({ synced: true, lines: [
      { start: 1.5, text: 'First' }, { start: 7.5, text: 'Colon fraction' }, { start: 12.34, text: 'Second line' },
      { start: 62.345, text: 'Word stamps' }, { start: 65, text: 'No fraction' },
    ] });
  });
  it('expands several stamps on one line, keeps timed blank lines and ignores untimed text', () => {
    expect(parseLrc('[00:30.00][00:10.00]Chorus\r\n[00:20.00]\r\nstray untimed text\r\n[00:10.00]Echo\n')).toEqual({ synced: true, lines: [
      { start: 10, text: 'Chorus' }, { start: 10, text: 'Echo' }, { start: 20, text: '' }, { start: 30, text: 'Chorus' },
    ] });
  });
  it.each([['+500', [0, 1.5]], ['-250', [0.75, 2.25]], ['', [0.5, 2]], ['abc', [0.5, 2]]])('applies offset %j (positive shows lyrics sooner)', (offset, starts) => {
    expect(parseLrc(`[offset:${offset}]\n[00:00.50]a\n[00:02.00]b`)?.lines.map(line => line.start)).toEqual(starts);
  });
  it('treats text without stamps as unsynced, keeping single stanza breaks', () => {
    expect(parseLrc('\n\n[ar:Artist]\nVerse one\nline two\n\n\n\nVerse two\n\n')).toEqual({ synced: false, lines: [
      { start: null, text: 'Verse one' }, { start: null, text: 'line two' }, { start: null, text: '' }, { start: null, text: 'Verse two' },
    ] });
  });
  it.each(['', '\n \n', '[ar:Only]\n[ti:Metadata]', '[00:01.00]\n[00:02.00]  '])('returns null for %j', text => expect(parseLrc(text)).toBeNull());
});

const query = { id: 's1', title: 'Song', artist: 'Artist', album: 'Record', duration: 200 };
const record = (extra: object = {}) => ({ id: 1, trackName: 'Song', artistName: 'Artist', albumName: 'Record', duration: 200, instrumental: false, plainLyrics: 'Plain one\nPlain two', syncedLyrics: '[00:01.00]Synced one\n[00:02.00]Synced two', ...extra });
function service(routes: Record<string, () => Response>) {
  const mock = vi.fn((input: string | URL | Request, _init?: RequestInit) => Promise.resolve((routes[new URL(String(input)).pathname] ?? (() => Response.json({ code: 404 }, { status: 404 })))()));
  return { mock, options: { baseUrl: 'http://lrclib.test/', fetch: mock as unknown as typeof fetch } };
}
const run = (task: Effect.Effect<unknown, Error>) => Effect.runPromise(Effect.either(task));

describe('LRCLIB', () => {
  it('asks the exact-match endpoint with all four fields and a descriptive User-Agent', async () => {
    const { mock, options } = service({ '/api/get': () => Response.json(record()) });
    expect(await Effect.runPromise(lrclibLyrics({ ...query, duration: 199.6 }, options))).toEqual({
      synced: true, source: 'lrclib', lines: [{ start: 1, text: 'Synced one' }, { start: 2, text: 'Synced two' }],
    });
    const [url, init] = mock.mock.calls[0];
    expect(Object.fromEntries(new URL(String(url)).searchParams)).toEqual({ track_name: 'Song', artist_name: 'Artist', album_name: 'Record', duration: '200' });
    expect(new URL(String(url)).origin).toBe('http://lrclib.test');
    expect((init?.headers as Record<string, string>)['user-agent']).toBe(lrclibUserAgent);
    expect(mock).toHaveBeenCalledOnce();
  });
  it('falls back to plain lyrics when a record has no synced text', async () => {
    const { options } = service({ '/api/get': () => Response.json(record({ syncedLyrics: null })) });
    expect(await Effect.runPromise(lrclibLyrics(query, options))).toEqual({ synced: false, source: 'lrclib', lines: [{ start: null, text: 'Plain one' }, { start: null, text: 'Plain two' }] });
  });
  it('searches when the exact match is missing and picks a synced result within 3 seconds', async () => {
    const { mock, options } = service({ '/api/search': () => Response.json([
      record({ duration: 250, syncedLyrics: '[00:01.00]Wrong length' }), record({ syncedLyrics: null, duration: 201 }), record({ duration: 197.5, syncedLyrics: '[00:03.00]Right' }),
    ]) });
    expect(await Effect.runPromise(lrclibLyrics(query, options))).toEqual({ synced: true, source: 'lrclib', lines: [{ start: 3, text: 'Right' }] });
    expect(mock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/get', '/api/search']);
    expect(Object.fromEntries(new URL(String(mock.mock.calls[1][0])).searchParams)).toEqual({ track_name: 'Song', artist_name: 'Artist', album_name: 'Record' });
  });
  it('searches directly without a duration or album and then matches by title', async () => {
    const { mock, options } = service({ '/api/search': () => Response.json([record({ trackName: 'Other song' }), record({ trackName: ' SONG ', syncedLyrics: null })]) });
    expect(await Effect.runPromise(lrclibLyrics({ ...query, album: '', duration: null }, options))).toMatchObject({ synced: false, lines: [{ text: 'Plain one' }, { text: 'Plain two' }] });
    expect(mock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/api/search']);
    expect(new URL(String(mock.mock.calls[0][0])).searchParams.has('album_name')).toBe(false);
  });
  it.each([
    ['nothing anywhere', {}],
    ['an instrumental exact match', { '/api/get': () => Response.json(record({ instrumental: true, plainLyrics: null, syncedLyrics: null })) }],
    ['empty search results', { '/api/search': () => Response.json([]) }],
  ])('returns null for %s', async (_name, routes) => {
    expect(await Effect.runPromise(lrclibLyrics(query, service(routes).options))).toBeNull();
  });
  it('does not call the service without a title or artist', async () => {
    const { mock, options } = service({});
    expect(await Effect.runPromise(lrclibLyrics({ ...query, artist: '  ' }, options))).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });
  it.each([
    ['a server error', () => new Response('secret-marker', { status: 500 })],
    ['invalid JSON', () => new Response('secret-marker')],
    ['a record that does not match the schema', () => Response.json({ syncedLyrics: 42, note: 'secret-marker' })],
    ['oversized lyrics', () => Response.json(record({ syncedLyrics: 'x'.repeat(200_001) }))],
    ['a response over 2 MB', () => new Response(new Uint8Array(2 * 1024 * 1024 + 1))],
  ])('fails with a local message on %s', async (_name, response) => {
    const result = await run(lrclibLyrics(query, service({ '/api/get': response }).options));
    expect(Either.isLeft(result) && result.left.message).toMatch(/^(Lyrics lookup failed|The lyrics service sent)/);
    expect(String(Either.isLeft(result) && result.left)).not.toContain('secret-marker');
  });
  it('fails with a local message on transport errors and times out after 8 seconds', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('http://lrclib.test/?secret-marker')));
    const result = await run(lrclibLyrics(query, { fetch: failing as unknown as typeof fetch }));
    expect(Either.isLeft(result) && result.left.message).toBe('Lyrics lookup failed. Try again later.');
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const hanging = vi.fn((_url: string, init: RequestInit) => { signal = init.signal ?? undefined; return new Promise<Response>(() => {}); });
      const pending = run(lrclibLyrics(query, { fetch: hanging as unknown as typeof fetch }));
      await vi.advanceTimersByTimeAsync(8000);
      const timedOut = await pending;
      expect(Either.isLeft(timedOut) && timedOut.left.message).toContain('8 seconds');
      expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
