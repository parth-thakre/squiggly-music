import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Either } from 'effect';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SubsonicClient, libraryCall } from '../packages/adapter-opensubsonic/client';
import { Metrics } from '../packages/core/metrics';
import type { TrackSort } from '../packages/core/contracts';

// Listing tracks: Navidrome's own API where it's there (POST /auth/login for a session token,
// GET /api/song with it, a fresh token in every answer), search3 in the server's order where not.

const password = 'fixture-password';
// One song as Navidrome's demo describes it through each API (trimmed), and two more that lean
// on the cover art rules: disc art, and album art, whose hash only Subsonic gives.
const natives = [
  {
    playCount: 1120, playDate: '2026-09-28T00:37:33.512658942Z', starred: true, starredAt: '2026-09-29T04:19:14.672579401Z', imageHash: '51f5041620034dc3',
    id: '3KB8ZWlZgex99I9sWcgXb1', title: '"polar expedition"', album: 'Live at The Casbah - 2005-04-29', artistId: '7i6ciuZJca8cG0V2xXwDcC', artist: 'The New Deal',
    albumId: '1wg9e3B8bWmiVRZWZBJux3', hasCoverArt: true, trackNumber: 4, discNumber: 1, year: 2005, suffix: 'flac', duration: 178.77, bitRate: 880,
    sampleRate: 44100, bitDepth: 16, channels: 2, genre: '', missing: false, rating: 5,
    participants: { albumartist: [{ id: '7i6ciuZJca8cG0V2xXwDcC', name: 'The New Deal', missing: false }], artist: [{ id: '7i6ciuZJca8cG0V2xXwDcC', name: 'The New Deal', missing: false }] },
  },
  {
    playCount: 3, playDate: '2026-09-27T00:00:00Z', imageHash: 'aa11', id: 'duet', title: 'Duet', album: 'Pairs', artistId: 'ar-a', artist: 'A & B', albumId: 'al-pairs',
    hasCoverArt: false, trackNumber: 2, discNumber: 2, year: 0, suffix: 'wav', duration: 61.9, sampleRate: 96000, bitDepth: 24, genre: 'Jazz', rating: 3,
    participants: { artist: [{ id: 'ar-a', name: 'A' }, { id: 'ar-b', name: 'B', subRole: '' }] },
  },
  {
    id: 'loose', title: 'Loose', album: 'Singles', artistId: 'ar-c', artist: 'C', albumId: 'al-singles', hasCoverArt: false, trackNumber: 0, discNumber: 0,
    year: 1999, suffix: 'mp3', duration: 12, sampleRate: 0, genre: '', participants: { artist: [{ id: 'ar-c', name: 'C' }] }, rating: 0,
  },
];
const subsonics = [
  {
    id: '3KB8ZWlZgex99I9sWcgXb1', parent: '1wg9e3B8bWmiVRZWZBJux3', isDir: false, title: '"polar expedition"', album: 'Live at The Casbah - 2005-04-29', artist: 'The New Deal',
    track: 4, year: 2005, coverArt: 'mf-3KB8ZWlZgex99I9sWcgXb1_51f5041620034dc3', suffix: 'flac', starred: '2026-09-29T04:19:14.672579401Z', duration: 178, bitRate: 880,
    playCount: 1120, discNumber: 1, albumId: '1wg9e3B8bWmiVRZWZBJux3', artistId: '7i6ciuZJca8cG0V2xXwDcC', samplingRate: 44100, bitDepth: 16, genres: [],
    artists: [{ id: '7i6ciuZJca8cG0V2xXwDcC', name: 'The New Deal' }], displayArtist: 'The New Deal', userRating: 5,
  },
  {
    id: 'duet', title: 'Duet', album: 'Pairs', artist: 'A & B', track: 2, coverArt: 'dc-al-pairs:2_aa11', suffix: 'wav', duration: 61, discNumber: 2,
    albumId: 'al-pairs', artistId: 'ar-a', samplingRate: 96000, bitDepth: 24, genre: 'Jazz', artists: [{ id: 'ar-a', name: 'A' }, { id: 'ar-b', name: 'B' }], userRating: 3,
  },
  {
    id: 'loose', title: 'Loose', album: 'Singles', artist: 'C', year: 1999, coverArt: 'al-al-singles_0f0f', suffix: 'mp3', duration: 12, albumId: 'al-singles', artistId: 'ar-c',
    samplingRate: 0, artists: [{ id: 'ar-c', name: 'C' }],
  },
];

interface Options { type?: string; nativeApi?: boolean; login?: 'ok' | 'drop' | 'html'; refuse?: boolean }
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); });

// A small Navidrome. `expire()` forgets every session token, as a restart with a new key does.
async function navidrome(options: Options = {}) {
  const state = { ...options, logins: [] as { body: string; type: string | undefined }[], queries: [] as { params: URLSearchParams; token: string }[], subsonic: [] as string[] };
  const valid = new Set<string>();
  let issued = 0;
  const issue = () => { const token = `jwt-${++issued}`; valid.add(token); return token; };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(body)); };
    if (url.pathname.startsWith('/music/rest/')) {
      const endpoint = url.pathname.replace(/^\/music\/rest\/(\w+)\.view$/, '$1');
      state.subsonic.push(endpoint);
      const params = url.searchParams;
      const envelope = (payload: object) => json(200, { 'subsonic-response': { status: 'ok', version: '1.16.1', type: state.type ?? 'navidrome', openSubsonic: true, ...payload } });
      if (endpoint === 'getOpenSubsonicExtensions') return envelope({ openSubsonicExtensions: [] });
      if (params.get('t') !== createHash('md5').update(password + params.get('s')).digest('hex')) return envelope({ status: 'failed', error: { code: 40 } });
      if (endpoint === 'ping') return envelope({});
      if (endpoint === 'search3') return envelope({ searchResult3: { song: subsonics.slice(Number(params.get('songOffset')), Number(params.get('songOffset')) + Number(params.get('songCount'))) } });
      return json(404, {});
    }
    if (state.nativeApi === false) return json(404, { error: 'Not found' });
    if (url.pathname === '/music/auth/login' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        state.logins.push({ body, type: request.headers['content-type'] });
        if (state.login === 'drop') { state.login = 'ok'; request.socket.destroy(); return; }
        if (state.login === 'html') { response.writeHead(200, { 'content-type': 'text/html' }); return void response.end('<html>sign in</html>'); }
        const sent = JSON.parse(body) as { username: string; password: string };
        if (sent.username !== 'listener' || sent.password !== password) return json(401, { error: 'Invalid username or password' });
        json(200, { id: 'u1', username: 'listener', isAdmin: false, token: issue() });
      });
      return;
    }
    if (url.pathname === '/music/api/song') {
      const token = /^Bearer (.+)$/.exec(String(request.headers['x-nd-authorization'] ?? ''))?.[1] ?? '';
      state.queries.push({ params: url.searchParams, token });
      if (state.refuse || !valid.has(token)) return json(401, { error: 'Not authenticated' });
      const start = Number(url.searchParams.get('_start')), end = Number(url.searchParams.get('_end'));
      return json(200, natives.slice(start, end), { 'x-total-count': String(natives.length), 'x-nd-authorization': issue() });
    }
    json(404, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  closers.push(() => { server.closeAllConnections(); return new Promise<void>(done => server.close(() => done())); });
  const metrics = new Metrics();
  const client = new SubsonicClient({ url: `http://127.0.0.1:${address.port}/music`, username: 'listener', password }, metrics);
  return { state, client, metrics, expire: () => valid.clear() };
}
const run = <A>(task: Effect.Effect<A, Error>) => Effect.runPromise(task);
const failure = async (task: Effect.Effect<unknown, Error>) => {
  const result = await Effect.runPromise(Effect.either(task));
  if (Either.isRight(result)) throw new Error('Expected a failure');
  return result.left.message;
};

describe("Navidrome's own API", () => {
  it('asks for each sort, paged, signed in once, with the token each answer brings', async () => {
    const { state, client, metrics } = await navidrome();
    const expected: Record<TrackSort, [string, string]> = {
      newest: ['recently_added', 'desc'], alphabeticalByName: ['title', 'asc'], alphabeticalByArtist: ['artist', 'asc'],
      frequent: ['play_count', 'desc'], recent: ['play_date', 'desc'], random: ['random', 'asc'],
      highest: ['rating', 'desc'],
    };
    for (const sort of Object.keys(expected) as TrackSort[]) expect((await run(client.tracks(sort, 0, 200, 'seed-1'))).sorted).toBe(true);
    expect(state.logins).toHaveLength(1);
    expect(state.logins[0].type).toBe('application/json');
    expect(JSON.parse(state.logins[0].body)).toEqual({ username: 'listener', password });
    expect(state.queries.map(({ params }) => Object.fromEntries(params))).toEqual(Object.values(expected).map(([sort, order], i) => ({
      _sort: sort, _order: order, _start: '0', _end: '200', missing: 'false', ...(i === 5 ? { seed: 'seed-1' } : {}),
    })));
    // The sign-in's token, then each answer's fresh one.
    expect(state.queries.map(query => query.token)).toEqual(['jwt-1', 'jwt-2', 'jwt-3', 'jwt-4', 'jwt-5', 'jwt-6', 'jwt-7']);
    // Offsets and sizes are bounded as search3's are.
    await run(client.tracks('newest', -5, 5000, ''));
    expect(Object.fromEntries(state.queries.at(-1)!.params)).toMatchObject({ _start: '0', _end: '500' });
    await run(client.tracks('newest', 400, 200, 'ignored'));
    expect(Object.fromEntries(state.queries.at(-1)!.params)).toEqual({ _sort: 'recently_added', _order: 'desc', _start: '400', _end: '600', missing: 'false' });
    // Only the ping went through the Subsonic API; the password went only in the sign-in's body.
    expect(state.subsonic).toEqual(['getOpenSubsonicExtensions', 'ping']);
    expect(JSON.stringify(metrics.snapshot())).not.toMatch(/jwt-|fixture-password/);
    expect(metrics.snapshot().map(metric => metric.name).sort()).toEqual(['native.login', 'native.song', 'server.getOpenSubsonicExtensions', 'server.ping']);
  });

  it('signs in again once when the session is refused, and says so plainly when it still is', async () => {
    const { state, client, expire } = await navidrome();
    await run(client.tracks('newest', 0, 200, ''));
    expire();
    expect((await run(client.tracks('newest', 200, 200, ''))).sorted).toBe(true);
    expect(state.logins).toHaveLength(2);
    expect(state.queries.map(query => query.token)).toEqual(['jwt-1', 'jwt-2', 'jwt-3']);

    // Every token refused, even a fresh sign-in's: one retry, then a message without the token.
    const refusing = await navidrome({ refuse: true });
    const message = await failure(refusing.client.tracks('newest', 0, 200, ''));
    expect(message).toBe('Navidrome did not accept the sign-in. Try again, or sign in again.');
    expect(refusing.state.logins).toHaveLength(2);
    expect(refusing.state.queries.map(query => query.token)).toEqual(['jwt-1', 'jwt-2']);
  });

  it('keeps played tracks only for most and recently played', async () => {
    const { client } = await navidrome();
    // In play count order: the first two were played, the third never was.
    const frequent = await run(client.tracks('frequent', 0, 3, ''));
    expect(frequent.tracks.map(track => track.id)).toEqual(['3KB8ZWlZgex99I9sWcgXb1', 'duet']);
    expect((await run(client.tracks('recent', 0, 3, ''))).tracks).toHaveLength(2);
    expect((await run(client.tracks('alphabeticalByName', 0, 3, ''))).tracks).toHaveLength(3);
  });

  it('keeps rated tracks only for top rated, with their ratings', async () => {
    const { client } = await navidrome();
    // In rating order: the first two are rated, the third's 0 is unrated.
    const highest = await run(client.tracks('highest', 0, 3, ''));
    expect(highest.tracks.map(track => [track.id, track.userRating])).toEqual([['3KB8ZWlZgex99I9sWcgXb1', 5], ['duet', 3]]);
    expect((await run(client.tracks('newest', 0, 3, ''))).tracks[2]).not.toHaveProperty('userRating');
  });

  it('maps a song to the same Track as Subsonic does', async () => {
    const native = (await run((await navidrome()).client.tracks('newest', 0, 3, ''))).tracks;
    const subsonic = (await run((await navidrome({ type: 'gonic' })).client.tracks('newest', 0, 3, ''))).tracks;
    expect(native.slice(0, 2)).toEqual(subsonic.slice(0, 2));
    expect(native[0]).toMatchObject({ coverArt: 'mf-3KB8ZWlZgex99I9sWcgXb1_51f5041620034dc3', duration: 178, starred: true, sourceFormat: 'flac', sourceSampleRate: 44100 });
    expect(native[1]).toMatchObject({ coverArt: 'dc-al-pairs:2_aa11', year: null, artists: [{ id: 'ar-a', name: 'A' }, { id: 'ar-b', name: 'B' }] });
    // Album art: the same image, without the cache hash this API leaves out.
    expect({ ...native[2], coverArt: subsonic[2].coverArt }).toEqual(subsonic[2]);
    expect(native[2].coverArt).toBe('al-al-singles');
  });

  it('is asked through the shared dispatcher, which lists the tracks for queueing by id', async () => {
    const { client } = await navidrome();
    const called = await run(libraryCall(client, 'tracks', ['alphabeticalByArtist', 0, 200, '']));
    expect(called.tracks.map(track => track.id)).toEqual(['3KB8ZWlZgex99I9sWcgXb1', 'duet', 'loose']);
    await expect(run(libraryCall(client, 'tracks', ['starred', 0, 200, '']))).rejects.toThrow('Invalid library request.');
  });
});

describe('without it', () => {
  it('lists tracks with search3 in the server order on other servers, without signing in', async () => {
    const { state, client } = await navidrome({ type: 'gonic' });
    expect(await run(client.tracks('alphabeticalByName', 0, 2, ''))).toMatchObject({ sorted: false, tracks: [{ id: '3KB8ZWlZgex99I9sWcgXb1' }, { id: 'duet' }] });
    await run(client.tracks('random', 2, 2, 'seed'));
    expect(state.logins).toEqual([]);
    expect(state.subsonic).toEqual(['getOpenSubsonicExtensions', 'ping', 'search3', 'search3']);
  });

  it.each([
    ['missing, as behind a proxy that passes only /rest', { nativeApi: false }],
    ['answering its sign-in with a web page', { login: 'html' as const }],
  ])('falls back on Navidrome with its own API %s, and stops asking', async (_, options) => {
    const { state, client } = await navidrome(options);
    expect((await run(client.tracks('newest', 0, 200, ''))).sorted).toBe(false);
    expect((await run(client.tracks('newest', 0, 200, ''))).sorted).toBe(false);
    expect(state.subsonic.filter(endpoint => endpoint === 'search3')).toHaveLength(2);
    expect(state.logins.length).toBeLessThanOrEqual(1);
  });

  it('fails a sign-in cut off on its way without giving up on the API', async () => {
    const { state, client } = await navidrome({ login: 'drop' });
    expect(await failure(client.tracks('newest', 0, 200, ''))).toBe('Server request failed. Check the address, connection, and Navidrome/OpenSubsonic compatibility.');
    expect((await run(client.tracks('newest', 0, 200, ''))).sorted).toBe(true);
    expect(state.logins).toHaveLength(2);
  });
});
