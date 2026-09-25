import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { SubsonicClient, libraryCall } from '../packages/adapter-opensubsonic/client';
import { Metrics } from '../packages/core/metrics';
import { previewServer, webPassword } from './previewHarness';

it.each(['/music', '/app', '/rest', '/music/app', '/music/rest'])('connects, browses and streams with server base path %s', async basePath => {
  const password = 'fixture-password';
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const params = request.method === 'POST' ? new URLSearchParams(Buffer.concat(chunks).toString()) : url.searchParams;
    const reply = (payload: object) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ 'subsonic-response': {
        status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.63.2', openSubsonic: true, ...payload,
      } }));
    };
    const token = createHash('md5').update(password + params.get('s')).digest('hex');
    if (params.get('u') !== 'listener' || params.get('t') !== token || params.has('p')) {
      reply({ status: 'failed', error: { code: 40, message: 'Wrong username or password' } });
      return;
    }
    requests.push(url.pathname);
    if (url.pathname === `${basePath}/rest/ping.view`) reply({});
    else if (url.pathname === `${basePath}/rest/getAlbumList2.view`) {
      if (params.get('size') !== '48' || params.get('type') !== 'newest') { response.writeHead(400).end(); return; }
      reply({ albumList2: { album: params.get('offset') === '0' ? [{ id: 'a1', name: 'Record', artist: 'Artist', songCount: 1 }] : [] } });
    } else if (url.pathname === `${basePath}/rest/getAlbum.view` && params.get('id') === 'a1') {
      reply({ album: { id: 'a1', name: 'Record', artist: 'Artist', song: [
        { id: 'song & 1', title: 'First track', suffix: 'flac', samplingRate: 96000, bitDepth: 24, duration: 180 },
      ] } });
    } else if (url.pathname === `${basePath}/rest/stream.view` && params.get('id') === 'song & 1' && params.get('format') === 'raw') {
      response.setHeader('Content-Type', 'audio/flac');
      response.end('fLaC-fixture');
    } else response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const connection = { url: `http://127.0.0.1:${address.port}${basePath}`, username: 'listener', password };
    const client = new SubsonicClient(connection, new Metrics());
    expect(await Effect.runPromise(client.ping())).toEqual({ name: 'Navidrome' });
    expect(await Effect.runPromise(client.albumList('newest', 0, 48))).toEqual([{
      id: 'a1', name: 'Record', artist: 'Artist', songCount: 1,
      artistId: null, year: null, genre: null, duration: null, coverArt: null, starred: false,
    }]);
    expect(await Effect.runPromise(client.albumList('newest', 48, 48))).toEqual([]);
    const { tracks: [track] } = await Effect.runPromise(client.album('a1'));
    const item = client.playable(track);
    expect(item.track).toMatchObject({ source: 'navidrome', album: 'Record', artist: 'Artist', sourceSampleRate: 96000, sourceBitDepth: 24 });
    const stream = await fetch(item.location);
    expect(stream.status).toBe(200);
    expect(await stream.text()).toBe('fLaC-fixture');
    expect(JSON.stringify(item.track)).not.toMatch(/fixture-password|127\.0\.0\.1|t=/);
    expect(requests).toEqual(['ping', 'getAlbumList2', 'getAlbumList2', 'getAlbum', 'stream'].map(endpoint => `${basePath}/rest/${endpoint}.view`));
    await expect(Effect.runPromise(new SubsonicClient({ ...connection, password: 'wrong' }, new Metrics()).ping())).rejects.toThrow('Incorrect username or password');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

const song = (id: string, extra: object = {}) => ({
  id, title: `Song ${id}`, artist: 'Artist', album: 'Record', albumId: 'a1', artistId: 'ar1', coverArt: `mf-${id}`,
  track: 2, discNumber: 1, year: 1999, genre: 'Jazz', duration: 200, suffix: 'flac', samplingRate: 44100, bitDepth: 16, ...extra,
});
const albumEntry = { id: 'a1', name: 'Record', artist: 'Artist', artistId: 'ar1', songCount: 2, duration: 400, year: 1999, genre: 'Jazz', coverArt: 'al-a1', starred: '2026-01-01T00:00:00Z' };
const artistEntry = { id: 'ar1', name: 'Artist', albumCount: 1, coverArt: 'ar-ar1', artistImageUrl: 'https://server/share/img/secret' };
const playlistEntry = { id: 'p1', name: 'Mix', comment: 'Notes', owner: 'listener', songCount: 2, duration: 400, coverArt: 'pl-p1', readonly: false, changed: '2026-02-01T00:00:00Z' };
const cover = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

it('maps every library endpoint, writes repeated IDs, and serves cover art through the connector', async () => {
  const password = 'fixture-password';
  const requests: { endpoint: string; params: URLSearchParams }[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const params = url.searchParams;
    const reply = (payload: object) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', openSubsonic: true, ...payload } }));
    };
    const token = createHash('md5').update(password + params.get('s')).digest('hex');
    if (params.get('u') !== 'listener' || params.get('t') !== token) { reply({ status: 'failed', error: { code: 40, message: 'secret' } }); return; }
    const endpoint = url.pathname.replace(/^\/music\/rest\/(\w+)\.view$/, '$1');
    requests.push({ endpoint, params });
    switch (endpoint) {
      case 'getAlbumList2': return reply({ albumList2: { album: params.get('type') === 'starred' && params.get('size') === '500' && params.get('offset') === '5' ? [albumEntry] : [] } });
      case 'getAlbum': return reply({ album: { ...albumEntry, song: [song('s1'), song('s2', { starred: '2026-01-01T00:00:00Z', year: 0, track: 0, genre: '' })] } });
      case 'getArtists': return reply({ artists: { ignoredArticles: 'The', index: [{ name: 'A', artist: [artistEntry] }, { name: 'B', artist: [{ id: 'ar2', name: 'Band', starred: '2026-01-01T00:00:00Z' }] }, { name: 'C' }] } });
      case 'getArtist': return reply({ artist: { ...artistEntry, album: [albumEntry] } });
      case 'getPlaylists': return reply({ playlists: { playlist: [playlistEntry, { id: 'p2', name: 'Shared', owner: 'someone-else', readonly: false }, { id: 'p3', name: 'Smart', owner: 'Listener', readonly: true }] } });
      case 'getPlaylist': return reply({ playlist: { ...playlistEntry, entry: [song('s2'), song('s1'), song('s2')] } });
      case 'getGenres': return reply({ genres: { genre: [{ value: 'Jazz', songCount: 10, albumCount: 2 }, { value: 'Rock' }] } });
      case 'getStarred2': return reply({ starred2: { artist: [artistEntry], album: [albumEntry], song: [song('s1', { starred: '2026' })] } });
      case 'getRandomSongs': return reply({ randomSongs: { song: [song('s9')] } });
      case 'search3': return reply({ searchResult3: { album: [albumEntry], song: [song('s1')] } });
      case 'star': case 'unstar': case 'updatePlaylist': return reply({});
      case 'createPlaylist': return reply({ playlist: { ...playlistEntry, id: 'p9', name: params.get('name'), songCount: params.getAll('songId').length, entry: [] } });
      case 'getCoverArt':
        if (params.get('id') === 'al-a1') { response.setHeader('Content-Type', 'image/jpeg'); response.end(cover); return; }
        return reply({ status: 'failed', error: { code: 70, message: 'secret cover' } });
      case 'stream': response.setHeader('Content-Type', 'audio/flac'); response.end(`stream-${params.get('id')}`); return;
      default: response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const client = new SubsonicClient({ url: `http://127.0.0.1:${address.port}/music`, username: 'listener', password }, new Metrics());
    const run = <A>(task: Effect.Effect<A, Error>) => Effect.runPromise(task);
    const album = { id: 'a1', name: 'Record', artist: 'Artist', songCount: 2, artistId: 'ar1', year: 1999, genre: 'Jazz', duration: 400, coverArt: 'al-a1', starred: true };
    const artist = { id: 'ar1', name: 'Artist', albumCount: 1, coverArt: 'ar-ar1', starred: false };
    const track = {
      id: 's1', title: 'Song s1', artist: 'Artist', album: 'Record', duration: 200, source: 'navidrome', sourceFormat: 'flac', sourceSampleRate: 44100, sourceBitDepth: 16,
      albumId: 'a1', artistId: 'ar1', coverArt: 'mf-s1', trackNumber: 2, discNumber: 1, year: 1999, genre: 'Jazz', starred: false,
    };
    const playlist = { id: 'p1', name: 'Mix', comment: 'Notes', owner: 'listener', songCount: 2, duration: 400, coverArt: 'pl-p1', readonly: false, changed: '2026-02-01T00:00:00Z' };

    expect(await run(client.albumList('starred', 5, 9999))).toEqual([album]);
    const detail = await run(client.album('a1'));
    expect(detail.album).toEqual(album);
    expect(detail.tracks).toEqual([track, { ...track, id: 's2', title: 'Song s2', coverArt: 'mf-s2', year: null, trackNumber: null, genre: null, starred: true }]);
    expect(await run(client.artists())).toEqual([artist, { id: 'ar2', name: 'Band', albumCount: 0, coverArt: null, starred: true }]);
    expect(await run(client.artist('ar1'))).toEqual({ artist, albums: [album] });
    expect(await run(client.playlists())).toEqual([
      playlist,
      { id: 'p2', name: 'Shared', comment: null, owner: 'someone-else', songCount: 0, duration: 0, coverArt: null, readonly: true, changed: null },
      { id: 'p3', name: 'Smart', comment: null, owner: 'Listener', songCount: 0, duration: 0, coverArt: null, readonly: true, changed: null },
    ]);
    const mix = await run(client.playlist('p1'));
    expect(mix.playlist).toEqual(playlist);
    expect(mix.tracks.map(item => item.id)).toEqual(['s2', 's1', 's2']);
    expect(await run(client.genres())).toEqual([{ name: 'Jazz', songCount: 10, albumCount: 2 }, { name: 'Rock', songCount: 0, albumCount: 0 }]);
    expect(await run(client.starred())).toEqual({ artists: [artist], albums: [album], tracks: [{ ...track, starred: true }] });
    expect((await run(client.randomSongs({ size: 0, genre: 'Jazz', fromYear: 1990, toYear: 2000 }))).map(item => item.id)).toEqual(['s9']);
    expect(await run(client.search('rec'))).toEqual({ artists: [], albums: [album], tracks: [track] });
    await run(client.star('track', 's1', true));
    await run(client.star('album', 'a1', false));
    await run(client.star('artist', 'ar1', true));
    expect(await run(client.createPlaylist('New & mix', ['s1', 's2', 's1']))).toMatchObject({ id: 'p9', name: 'New & mix', songCount: 3, readonly: false });
    await run(client.addToPlaylist('p1', ['s2', 's2']));
    expect(await run(client.coverArt('al-a1', 5000))).toEqual({ contentType: 'image/jpeg', bytes: new Uint8Array(cover) });
    await expect(run(client.coverArt('missing', 300))).rejects.toThrow('Cover art is not available.');

    const sent = (endpoint: string) => requests.filter(request => request.endpoint === endpoint).map(request => request.params);
    expect(sent('getAlbumList2')[0].get('size')).toBe('500');
    expect(Object.fromEntries(['size', 'genre', 'fromYear', 'toYear'].map(key => [key, sent('getRandomSongs')[0].get(key)]))).toEqual({ size: '1', genre: 'Jazz', fromYear: '1990', toYear: '2000' });
    expect(['query', 'artistCount', 'albumCount', 'songCount'].map(key => sent('search3')[0].get(key))).toEqual(['rec', '8', '16', '40']);
    expect(sent('star').map(params => [params.get('id'), params.get('artistId'), params.has('albumId')])).toEqual([['s1', null, false], [null, 'ar1', false]]);
    expect(sent('unstar')[0].get('albumId')).toBe('a1');
    expect(sent('createPlaylist')[0].getAll('songId')).toEqual(['s1', 's2', 's1']);
    expect(sent('updatePlaylist')[0].get('playlistId')).toBe('p1');
    expect(sent('updatePlaylist')[0].getAll('songIdToAdd')).toEqual(['s2', 's2']);
    expect(sent('getCoverArt').map(params => params.get('size'))).toEqual(['1200', '300']);

    // Tracks from any library response can be streamed with the same raw-format policy as albums.
    const item = client.playable(mix.tracks[0]);
    expect(new URL(item.location).searchParams.get('format')).toBe('raw');
    expect(await (await fetch(item.location)).text()).toBe('stream-s2');
    expect(JSON.stringify([detail, mix])).not.toMatch(/fixture-password|127\.0\.0\.1|secret|t=/);

    // The shared dispatcher validates positional arguments and lists tracks for queueing by ID.
    const called = await run(libraryCall(client, 'playlist', ['p1']));
    expect(called.tracks.map(item => item.id)).toEqual(['s2', 's1', 's2']);
    expect((await run(libraryCall(client, 'albums', ['newest', 0, 48]))).tracks).toEqual([]);
    const before = requests.length;
    for (const [method, args] of [['albums', ['sideways', 0, 48]], ['albums', ['newest', -1, 48]], ['albums', ['newest', 0, 501]], ['album', ['']], ['artists', ['extra']],
      ['search', ['   ']], ['star', ['song', 's1', true]], ['createPlaylist', ['', []]], ['addToPlaylist', ['p1', []]], ['randomSongs', [{ size: 1.5 }]], ['album', 'a1']] as const) {
      await expect(run(libraryCall(client, method, args))).rejects.toThrow('Invalid library request.');
    }
    expect(requests.length).toBe(before);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

// A fixture for editing, radio, lyrics, play reports and the saved queue. `opensubsonic` advertises
// formPost, songLyrics, indexBasedQueue and topSongsByArtistId; `legacy` advertises nothing.
async function listen(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return { url: `http://127.0.0.1:${address.port}`, close: () => { server.closeAllConnections(); return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
async function subsonicFixture(mode: 'opensubsonic' | 'legacy') {
  const password = 'fixture-password';
  const state = { queueEmpty: false };
  const requests: { endpoint: string; method: string; params: URLSearchParams }[] = [];
  const server = await listen(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const params = request.method === 'POST' ? new URLSearchParams(Buffer.concat(chunks).toString()) : url.searchParams;
    const reply = (payload: object) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', openSubsonic: mode === 'opensubsonic', ...payload } }));
    };
    const fail = (code: number) => reply({ status: 'failed', error: { code, message: 'secret server text https://server/rest?t=secret' } });
    const endpoint = url.pathname.replace(/^\/rest\/(\w+)\.view$/, '$1');
    if (endpoint === 'getOpenSubsonicExtensions') {
      if (mode === 'legacy') return void response.writeHead(404).end();
      return reply({ openSubsonicExtensions: ['formPost', 'songLyrics', 'indexBasedQueue', 'topSongsByArtistId'].map(name => ({ name, versions: [1] })) });
    }
    if (params.get('u') !== 'listener' || params.get('t') !== createHash('md5').update(password + params.get('s')).digest('hex')) return fail(40);
    requests.push({ endpoint, method: request.method!, params });
    const id = params.get('id') ?? params.get('playlistId');
    const queue = { username: 'listener', changed: '2026-03-01T10:00:00Z', changedBy: 'web', position: 61_500, entry: state.queueEmpty ? undefined : [song('s1'), song('s2'), song('s1')] };
    switch (endpoint) {
      case 'updatePlaylist': case 'deletePlaylist': case 'createPlaylist':
        return id === 'smart' ? fail(50) : id === 'gone' ? fail(70) : reply(endpoint === 'createPlaylist' ? { playlist: { ...playlistEntry, entry: [] } } : {});
      case 'getSimilarSongs': return reply({ similarSongs: { song: [song('s3'), song('s4')] } });
      case 'getArtist': return reply({ artist: { ...artistEntry, album: [albumEntry] } });
      case 'getTopSongs':
        if (mode === 'opensubsonic' ? params.get('id') !== 'ar1' || params.has('artist') : params.get('artist') !== 'Artist' || params.has('id')) return reply({ topSongs: {} });
        return reply({ topSongs: { song: [song('s5'), song('s6', { artistId: 'someone-else' })] } });
      case 'getLyricsBySongId':
        if (id === 's1') return reply({ lyricsList: { structuredLyrics: [
          { lang: 'eng', synced: false, line: [{ value: 'Plain' }] },
          { lang: 'xxx', synced: true, offset: 100, line: [{ start: 2000, value: ' Second ' }, { start: 500, value: 'First' }, { start: 3000, value: '' }] },
          { lang: 'deu', synced: true, kind: 'translation', line: Array.from({ length: 9 }, (_, index) => ({ start: index * 1000, value: 'Übersetzung' })) },
        ] } });
        return id === 's2' ? reply({ lyricsList: {} }) : fail(70);
      case 'getLyrics': return reply(params.get('title') === 'Song s1' && params.get('artist') === 'Artist' ? { lyrics: { artist: 'Artist', title: 'Song s1', value: 'Line one\nLine two' } } : { lyrics: {} });
      case 'scrobble': case 'savePlayQueue': case 'savePlayQueueByIndex': return reply({});
      case 'getPlayQueueByIndex': return reply({ playQueueByIndex: { ...queue, currentIndex: state.queueEmpty ? undefined : 2 } });
      case 'getPlayQueue': return reply({ playQueue: { ...queue, current: state.queueEmpty ? undefined : 's2' } });
      default: response.writeHead(404).end();
    }
  });
  const lrclibRequests: URLSearchParams[] = [];
  const lrclib = await listen((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    lrclibRequests.push(url.searchParams);
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname !== '/api/get' || url.searchParams.get('track_name') !== 'Song s2' || request.headers['user-agent'] !== 'Squiggly Music (https://github.com/parth-thakre)') return void response.writeHead(404).end('{}');
    response.end(JSON.stringify({ id: 7, trackName: 'Song s2', duration: 200, instrumental: false, plainLyrics: 'Plain', syncedLyrics: '[ar:Artist]\n[00:04.25]From LRCLIB\n[00:01.00][00:08.50]Hook' }));
  });
  const client = new SubsonicClient({ url: server.url, username: 'listener', password }, new Metrics(), { baseUrl: lrclib.url });
  const sent = (endpoint: string) => requests.filter(item => item.endpoint === endpoint);
  return { client, requests, sent, state, lrclibRequests, url: server.url, password, close: () => Promise.all([server.close(), lrclib.close()]) };
}
const queryFor = (id: string) => ({ id, title: `Song ${id}`, artist: 'Artist', album: 'Record', duration: 200 });

it.each(['opensubsonic', 'legacy'] as const)('edits playlists, reads radio, lyrics and the saved queue, and saves plays with %s servers', async mode => {
  const fixture = await subsonicFixture(mode);
  const { client, sent } = fixture;
  const run = <A>(task: Effect.Effect<A, Error>) => Effect.runPromise(task);
  const failure = async (task: Effect.Effect<unknown, Error>) => {
    const result = await Effect.runPromise(Effect.either(task));
    if (result._tag === 'Right') throw new Error('Expected a failure');
    expect(result.left.message).not.toMatch(/secret|fixture-password|127\.0\.0\.1/);
    return result.left.message;
  };
  try {
    // Playlist editing, including repeated parameters and local messages for read-only and missing playlists.
    await run(client.updatePlaylist('p1', { name: 'Renamed & mixed', comment: '' }));
    await run(client.updatePlaylist('p1', { comment: 'Only a note' }));
    await run(client.removeFromPlaylist('p1', [3, 0, 3]));
    await run(client.reorderPlaylist('p1', ['s2', 's1', 's2']));
    await run(client.deletePlaylist('p1'));
    expect(await failure(client.updatePlaylist('smart', { name: 'x' }))).toBe('This playlist cannot be changed. Only its owner can edit it, and smart or imported playlists are read-only.');
    expect(await failure(client.reorderPlaylist('smart', ['s1']))).toContain('cannot be changed');
    expect(await failure(client.addToPlaylist('smart', ['s1']))).toContain('cannot be changed');
    expect(await failure(client.deletePlaylist('gone'))).toBe('This playlist no longer exists. Refresh your playlists.');
    const before = fixture.requests.length;
    expect(await failure(client.reorderPlaylist('p1', Array.from({ length: 5001 }, () => 's1')))).toContain('5,000');
    expect(await failure(client.saveQueue(Array.from({ length: 1001 }, () => 's1'), 0, 0))).toContain('1,000');
    expect(fixture.requests.length).toBe(before);
    const updates = sent('updatePlaylist').map(({ params }) => params);
    expect([updates[0].get('playlistId'), updates[0].get('name'), updates[0].get('comment')]).toEqual(['p1', 'Renamed & mixed', '']);
    expect([updates[1].has('name'), updates[1].get('comment')]).toEqual([false, 'Only a note']);
    expect(updates[2].getAll('songIndexToRemove')).toEqual(['3', '0']);
    const reorder = sent('createPlaylist')[0].params;
    expect([reorder.get('playlistId'), reorder.has('name'), reorder.getAll('songId')]).toEqual(['p1', false, ['s2', 's1', 's2']]);
    expect(sent('deletePlaylist')[0].params.get('id')).toBe('p1');

    // Radio: counts are clamped; name-based top songs keep only the requested artist's songs.
    expect((await run(client.similarSongs('ar1', 500))).map(track => track.id)).toEqual(['s3', 's4']);
    expect(sent('getSimilarSongs')[0].params.get('count')).toBe('200');
    expect(await failure(client.similarSongs('ar1', 1))).toBe('The server returned more tracks than requested.');
    expect((await run(client.topSongs('ar1', 10))).map(track => track.id)).toEqual(mode === 'opensubsonic' ? ['s5', 's6'] : ['s5']);
    expect(sent('getTopSongs')[0].params.get('count')).toBe('10');
    expect(sent('getArtist').length).toBe(mode === 'opensubsonic' ? 0 : 1);

    // Lyrics: the server's synced main layer, in seconds with its offset applied. LRCLIB only when allowed and needed.
    const serverLyrics = mode === 'opensubsonic'
      ? { synced: true, source: 'server', lines: [{ start: 0.4, text: 'First' }, { start: 1.9, text: 'Second' }, { start: 2.9, text: '' }] }
      : { synced: false, source: 'server', lines: [{ start: null, text: 'Line one' }, { start: null, text: 'Line two' }] };
    expect(await run(client.lyrics(queryFor('s1'), true))).toEqual(serverLyrics);
    expect(await run(client.lyrics(queryFor('s2'), false))).toBeNull();
    expect(fixture.lrclibRequests).toEqual([]);
    expect(await run(client.lyrics(queryFor('s2'), true))).toEqual({ synced: true, source: 'lrclib', lines: [
      { start: 1, text: 'Hook' }, { start: 4.25, text: 'From LRCLIB' }, { start: 8.5, text: 'Hook' },
    ] });
    expect(fixture.lrclibRequests.map(params => Object.fromEntries(params))).toEqual([{ track_name: 'Song s2', artist_name: 'Artist', album_name: 'Record', duration: '200' }]);
    if (mode === 'opensubsonic') {
      expect(await run(client.lyrics(queryFor('missing'), false))).toBeNull();
      expect(sent('getLyricsBySongId').map(({ params }) => params.get('id'))).toEqual(['s1', 's2', 's2', 'missing']);
    } else expect(sent('getLyrics').map(({ params }) => params.get('title'))).toEqual(['Song s1', 'Song s2', 'Song s2']);
    expect(JSON.stringify(fixture.lrclibRequests.map(String))).not.toMatch(/listener|fixture-password|t=/);

    // Play reports.
    const started = Date.now();
    await run(client.reportPlay('s1', 'started'));
    await run(client.reportPlay('s1', 'finished'));
    const [nowPlaying, finished] = sent('scrobble').map(({ params }) => params);
    expect([nowPlaying.get('id'), nowPlaying.get('submission'), nowPlaying.has('time')]).toEqual(['s1', 'false', false]);
    expect([finished.get('id'), finished.get('submission')]).toEqual(['s1', 'true']);
    expect(Number(finished.get('time'))).toBeGreaterThanOrEqual(started);

    // The saved queue: an index (or legacy current ID) and a millisecond position.
    expect(await run(client.savedQueue())).toEqual({
      tracks: [queue('s1'), queue('s2'), queue('s1')], currentIndex: mode === 'opensubsonic' ? 2 : 1, positionSeconds: 61.5, changed: '2026-03-01T10:00:00Z', changedBy: 'web',
    });
    fixture.state.queueEmpty = true;
    expect(await run(client.savedQueue())).toBeNull();
    await run(client.saveQueue(['s1', 's2', 's1'], 2, 12.3456));
    await run(client.saveQueue(['s1'], 9, Number.NaN));
    await run(client.saveQueue([], 0, 0));
    const saves = sent(mode === 'opensubsonic' ? 'savePlayQueueByIndex' : 'savePlayQueue').map(({ params }) => params);
    const fields = (params: URLSearchParams) => ({ id: params.getAll('id'), currentIndex: params.get('currentIndex'), current: params.get('current'), position: params.get('position') });
    expect(saves.map(fields)).toEqual(mode === 'opensubsonic' ? [
      { id: ['s1', 's2', 's1'], currentIndex: '2', current: null, position: '12346' },
      { id: ['s1'], currentIndex: '0', current: null, position: '0' },
      { id: [], currentIndex: null, current: null, position: null },
    ] : [
      { id: ['s1', 's2', 's1'], currentIndex: null, current: 's1', position: '12346' },
      { id: ['s1'], currentIndex: null, current: 's1', position: '0' },
      { id: [], currentIndex: null, current: null, position: null },
    ]);
    // formPost servers get every request as a POST body, so long queues fit.
    expect(new Set(fixture.requests.map(item => item.method))).toEqual(new Set([mode === 'opensubsonic' ? 'POST' : 'GET']));

    // The shared dispatcher decodes the new methods and lists their tracks for queueing by ID.
    fixture.state.queueEmpty = false;
    expect((await run(libraryCall(client, 'savedQueue', []))).tracks.map(track => track.id)).toEqual(['s1', 's2', 's1']);
    expect((await run(libraryCall(client, 'similarSongs', ['s1', 50]))).tracks.map(track => track.id)).toEqual(['s3', 's4']);
    expect((await run(libraryCall(client, 'lyrics', [queryFor('s1'), false]))).value).toEqual(serverLyrics);
    expect((await run(libraryCall(client, 'updatePlaylist', ['p1', { name: '  Trimmed  ' }])))).toEqual({ value: undefined, tracks: [] });
    expect(sent('updatePlaylist').at(-1)?.params.get('name')).toBe('Trimmed');
    const count = fixture.requests.length;
    const ids = (length: number) => Array.from({ length }, () => 's1');
    for (const [method, args] of [
      ['updatePlaylist', ['p1', {}]], ['updatePlaylist', ['p1', { name: '   ' }]], ['updatePlaylist', ['', { name: 'x' }]], ['updatePlaylist', ['p1', { comment: 'x'.repeat(4097) }]],
      ['removeFromPlaylist', ['p1', []]], ['removeFromPlaylist', ['p1', [-1]]], ['removeFromPlaylist', ['p1', [0.5]]], ['removeFromPlaylist', ['p1', [5000]]],
      ['reorderPlaylist', ['p1', ids(5001)]], ['reorderPlaylist', ['p1', ['']]], ['deletePlaylist', []],
      ['similarSongs', ['s1', 0]], ['similarSongs', ['s1', 201]], ['topSongs', ['ar1', 1.5]], ['topSongs', ['', 10]],
      ['lyrics', [queryFor('s1')]], ['lyrics', [queryFor('s1'), 'yes']], ['lyrics', [{ ...queryFor('s1'), duration: -1 }, false]], ['lyrics', [{ ...queryFor('s1'), title: 'x'.repeat(1025) }, false]], ['lyrics', [{ ...queryFor('s1'), duration: undefined }, false]],
      ['reportPlay', ['s1', 'paused']], ['reportPlay', ['', 'started']], ['savedQueue', [1]],
      ['saveQueue', [['s1'], 1, 0]], ['saveQueue', [[], 1, 0]], ['saveQueue', [ids(1001), 0, 0]], ['saveQueue', [['s1'], 0, -1]], ['saveQueue', [['s1'], 0, Number.MAX_VALUE]], ['saveQueue', [['s1'], -1, 0]],
    ] as const) await expect(run(libraryCall(client, method, args)), `${method} ${JSON.stringify(args).slice(0, 80)}`).rejects.toThrow('Invalid library request.');
    expect(fixture.requests.length).toBe(count);
  } finally { await fixture.close(); }
});
const queue = (id: string) => ({
  id, title: `Song ${id}`, artist: 'Artist', album: 'Record', duration: 200, source: 'navidrome', sourceFormat: 'flac', sourceSampleRate: 44100, sourceBitDepth: 16,
  albumId: 'a1', artistId: 'ar1', coverArt: `mf-${id}`, trackNumber: 2, discNumber: 1, year: 1999, genre: 'Jazz', starred: false,
});

it('serves the new library methods to the browser preview over POST /api/<method>', async () => {
  const fixture = await subsonicFixture('opensubsonic');
  const preview = await previewServer({ env: {
    SQUIGGLY_PREVIEW_NAVIDROME_URL: fixture.url, SQUIGGLY_PREVIEW_NAVIDROME_USER: 'listener', SQUIGGLY_PREVIEW_NAVIDROME_PASSWORD: fixture.password,
    SQUIGGLY_WEB_PASSWORD: webPassword,
  } });
  const { routes } = preview;
  const { cookie } = await preview.signIn();
  const post = async (method: string, args: unknown) => (await preview.post(`/api/${method}`, args, cookie)).json();
  try {
    expect(await (await preview.post('/api/savedQueue', [])).json()).toEqual({ ok: false, error: 'Sign in to use this library.' });
    expect(await post('savedQueue', [])).toMatchObject({ ok: true, value: { currentIndex: 2, positionSeconds: 61.5 } });
    expect(await post('lyrics', [queryFor('s2'), false])).toEqual({ ok: true, value: null });
    expect(fixture.lrclibRequests).toEqual([]);
    expect(await post('topSongs', ['ar1', 10])).toMatchObject({ ok: true, value: [{ id: 's5' }, { id: 's6' }] });
    expect(await post('reportPlay', ['s1', 'started'])).toEqual({ ok: true });
    expect(await post('saveQueue', [['s1', 's2'], 1, 3])).toEqual({ ok: true });
    expect(await post('deletePlaylist', ['smart'])).toEqual({ ok: false, error: 'This playlist cannot be changed. Only its owner can edit it, and smart or imported playlists are read-only.' });
    expect(await post('saveQueue', [['s1'], 4, 0])).toEqual({ ok: false, error: 'Invalid library request.' });
    // A 5,000-song reorder fits the request body limit.
    expect(await post('reorderPlaylist', ['p1', Array.from({ length: 5000 }, (_, index) => `song-${index}-${'x'.repeat(24)}`)])).toEqual({ ok: true });
    expect(fixture.sent('createPlaylist')[0].params.getAll('songId')).toHaveLength(5000);
    expect((await fetch(`${preview.url}/navidrome/albums`)).status).toBe(404);
    expect(routes.has('/navidrome')).toBe(false);
  } finally {
    await Promise.all([preview.close(), fixture.close()]);
  }
});
