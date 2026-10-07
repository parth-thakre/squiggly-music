import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Track } from '../../../packages/core/contracts';
import { account, allTracks, seededPlays, type FakeNavidrome } from './library';

// The fake account over HTTP, for the one thing the connector itself is exercised doing in the
// player suite: listing tracks. Navidrome's own API (POST /auth/login for a session token, then
// GET /api/song with it, sorted and paged, each answer handing back a fresh token), and the
// Subsonic ping and search3 that tracks() falls back to without it. Everything else is answered
// in-process by FakeNavidrome.client.

const md5 = (text: string) => createHash('md5').update(text).digest('hex');
const plays = new Map(seededPlays.map(([id, count, date]) => [id, { count, date }]));
// When each track joined the library: later records later, and within one, later tracks later.
const added = (track: Track) => {
  const [, record, n] = /^tr-(\d+)-(\d+)$/.exec(track.id)!;
  return Date.UTC(2025, 0, Number(record), 0, 0, Number(n));
};
const lower = (text: string) => text.toLowerCase();
const compare = (a: string | number, b: string | number) => a < b ? -1 : a > b ? 1 : 0;
// Ascending, as Navidrome's sort mappings are written; _order=desc reverses every column.
const sorts: Record<string, (seed: string, fake: FakeNavidrome) => (a: Track, b: Track) => number> = {
  recently_added: () => (a, b) => compare(added(a), added(b)) || compare(a.id, b.id),
  title: () => (a, b) => compare(lower(a.title), lower(b.title)),
  artist: () => (a, b) => compare(lower(a.artist), lower(b.artist)) || compare(lower(a.album), lower(b.album)) || compare(a.year ?? 0, b.year ?? 0)
    || compare(a.discNumber ?? 0, b.discNumber ?? 0) || compare(a.trackNumber ?? 0, b.trackNumber ?? 0),
  play_count: () => (a, b) => compare(plays.get(a.id)?.count ?? 0, plays.get(b.id)?.count ?? 0),
  // Never played is null, which sorts first ascending and last descending.
  play_date: () => (a, b) => compare(plays.get(a.id)?.date ?? '', plays.get(b.id)?.date ?? ''),
  random: seed => (a, b) => compare(md5(seed + a.id), md5(seed + b.id)),
  // Unrated counts as 0, so it comes last descending.
  rating: (_, fake) => (a, b) => compare(fake.ratings.get(a.id) ?? 0, fake.ratings.get(b.id) ?? 0),
};

// model.MediaFile as JSON, and the same song as Subsonic describes it.
const nativeSong = (fake: FakeNavidrome, track: Track) => ({
  id: track.id, title: track.title, artist: track.artist, album: track.album, albumArtist: track.artist,
  albumId: track.albumId, artistId: track.artistId, duration: track.duration, suffix: track.sourceFormat,
  sampleRate: track.sourceSampleRate, bitDepth: track.sourceBitDepth, hasCoverArt: false,
  trackNumber: track.trackNumber, discNumber: track.discNumber, year: track.year ?? 0, genre: track.genre ?? '',
  ...(fake.starred.has(track.id) ? { starred: true, starredAt: '2026-09-01T00:00:00Z' } : {}),
  ...(plays.has(track.id) ? { playCount: plays.get(track.id)!.count, playDate: plays.get(track.id)!.date } : {}),
  participants: { artist: track.artists ?? [{ id: track.artistId, name: track.artist }] },
  missing: false, createdAt: new Date(added(track)).toISOString(),
  ...(fake.ratings.has(track.id) ? { rating: fake.ratings.get(track.id) } : {}),
});
const subsonicSong = (fake: FakeNavidrome, track: Track) => ({
  id: track.id, title: track.title, artist: track.artist, album: track.album, albumId: track.albumId, artistId: track.artistId,
  duration: track.duration, suffix: track.sourceFormat, samplingRate: track.sourceSampleRate, bitDepth: track.sourceBitDepth,
  coverArt: track.coverArt, track: track.trackNumber, discNumber: track.discNumber, year: track.year ?? undefined, genre: track.genre ?? undefined,
  ...(fake.starred.has(track.id) ? { starred: '2026-09-01T00:00:00Z' } : {}), ...(track.artists ? { artists: track.artists } : {}),
  ...(fake.ratings.has(track.id) ? { userRating: fake.ratings.get(track.id) } : {}),
  // What the connector sorts by when it sorts here: Navidrome's created, playCount, and played.
  created: new Date(added(track)).toISOString(),
  ...(plays.has(track.id) ? { playCount: plays.get(track.id)!.count, played: plays.get(track.id)!.date } : {}),
});

/** Answers the request if it is one of these routes; false leaves it to the stream server. */
export function serveNavidrome(fake: FakeNavidrome, request: IncomingMessage, response: ServerResponse): boolean {
  const url = new URL(request.url ?? '/', 'http://navidrome');
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  };
  const subsonic = (payload: object) => reply(200, { 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', openSubsonic: true, ...payload } });
  const params = url.searchParams;
  switch (url.pathname) {
    case '/rest/getOpenSubsonicExtensions.view':
      subsonic({ openSubsonicExtensions: [] });
      return true;
    case '/rest/ping.view': case '/rest/search3.view':
      if (params.get('u') !== account.username || params.get('t') !== md5(account.password + params.get('s'))) subsonic({ status: 'failed', error: { code: 40 } });
      else if (url.pathname === '/rest/ping.view') subsonic({});
      else {
        const offset = Number(params.get('songOffset') ?? 0), count = Number(params.get('songCount') ?? 20);
        subsonic({ searchResult3: { song: allTracks.slice(offset, offset + count).map(track => subsonicSong(fake, track)) } });
      }
      return true;
    case '/auth/login': {
      if (!fake.nativeApi) { reply(404, { error: 'Not found' }); return true; }
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        const { username, password } = JSON.parse(body || '{}') as { username?: string; password?: string };
        if (username !== account.username || password !== account.password) return reply(401, { error: 'Invalid username or password' });
        fake.logins++;
        reply(200, { id: 'u1', name: 'Tester', username, isAdmin: false, token: fake.issueToken() });
      });
      return true;
    }
    case '/api/song': {
      if (!fake.nativeApi) { reply(404, { error: 'Not found' }); return true; }
      const token = /^Bearer (.+)$/i.exec(String(request.headers['x-nd-authorization'] ?? ''))?.[1];
      if (!token || !fake.sessions.has(token)) { reply(401, { error: 'Not authenticated' }); return true; }
      fake.nativeQueries.push(params);
      const sort = sorts[params.get('_sort') ?? '']?.(params.get('seed') ?? '', fake);
      const direction = params.get('_order')?.toLowerCase() === 'desc' ? -1 : 1;
      const list = sort ? [...allTracks].sort((a, b) => direction * sort(a, b)) : allTracks;
      const start = Number(params.get('_start') ?? 0), end = Number(params.get('_end') ?? list.length);
      reply(200, list.slice(start, end).map(track => nativeSong(fake, track)), { 'x-total-count': String(list.length), 'x-nd-authorization': fake.issueToken() });
      return true;
    }
  }
  return false;
}
