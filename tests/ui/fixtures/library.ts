import { Effect } from 'effect';
import type { Album, AlbumListType, Artist, Lyrics, LyricsQuery, Playlist, RandomSongOptions, SavedQueue, StarTarget, Track } from '../../../packages/core/contracts';
import type { SubsonicClient } from '../../../packages/adapter-opensubsonic/client';
import { timeWords } from '../../../packages/lyrics/words';
import { coverPng } from './media';

// A deterministic stand-in for a Navidrome account, passed to the real preview plugin as its
// SubsonicClient. Tests read and steer its state directly (it lives in the Playwright worker):
// playlists as the server holds them, every call made, play reports, and per-method delays.

const artistNames = ['Ada Brass', 'Bell Tower', 'Cinder Lane', 'Dune Pilot', 'Echo Farm', 'Fern Gully'];
const albumNames = [
  'Test Pressing', 'Quiet Harbor', 'Amber Field', 'Northern Wires', 'Glass Orchard', 'Morning Freight',
  'Velvet Static', 'Low Tide Radio', 'Paper Lanterns', 'Iron Meadow', 'Kite Season', 'Salt and Signal',
  'Hollow Pines', 'Winter Exchange', 'Copper Sky', 'Distant Rooms', 'Ember Road', 'Yellow Canal',
  'Open Window', 'Tin Roof Choir', 'Useful Weather', 'Brick Lullaby', 'Zero Hour Garden', 'Late Ferry',
  'Rust Belt Hymns', 'Jade Frequency', 'Cedar Lines', 'Slow Carousel', 'Xylophone Dusk', 'Quartz Evening',
  // Long enough that Songs loads a second page. No year or genre, so no automatic playlist draws from it.
  'Long Player',
];
const trackWords = ['Opening', 'Second Wind', 'Middle Distance', 'Late Call', 'Coda', 'Encore'];
const genres = ['Ambient', 'Folk', 'Rock'];

// The first record holds the songs the specs lean on.
export const special = {
  album: 'al-1',
  longRun: 'tr-1-1', // 45 s
  lyricLine: 'tr-1-2', // 30 s, synced lyrics every 3 s
  shortStop: 'tr-1-3', // 8 s: never reported finished
  thirtyTwo: 'tr-1-4', // 32 s: finished after 16 s of listening
  tailLight: 'tr-1-5', // 20 s
  wordByWord: 'tr-4-3', // 24 s on Northern Wires, lyrics with exact word times
} as const;
const specialTracks: [string, number][] = [['Long Run', 45], ['Lyric Line', 30], ['Short Stop', 8], ['Thirty Two', 32], ['Tail Light', 20]];
export const lyricLines = Array.from({ length: 10 }, (_, i) => ({ start: i * 3, text: `Line ${i + 1} of the lyric` }));
// Word by Word: a line every 4 s from 1 s, each word with its own start and end, the last word
// done well before the next line. The times are uneven on purpose, unlike an estimate.
const wordTimes: [number, [string, number][]][] = [
  [1, [['Every ', .9], ['word ', .3], ['arrives ', .5], ['on ', .2], ['time', 1]]],
  [5, [['Each ', .3], ['one ', .3], ['lights ', 1.2], ['before ', .4], ['the ', .2], ['next', .6]]],
  [9, [['Slow', .8], ['ly ', .4], ['through ', .4], ['the ', .2], ['longest ', 1.2], ['vowel', .4]]],
  [13, [['Then ', .4], ['the ', .2], ['chorus ', .9], ['comes ', .5], ['around', 1]]],
  [17, [['And ', .3], ['the ', .2], ['last ', .5], ['word ', .5], ['lingers', 1.5]]],
];
export const wordLines = wordTimes.map(([start, words]) => {
  let at = start;
  return { start, text: words.map(([text]) => text).join(''), words: words.map(([text, length]) => {
    const word = { start: Math.round(at * 1000) / 1000, end: Math.round((at + length) * 1000) / 1000, text };
    at += length;
    return word;
  }) };
});

export const playlistIds = { road: 'pl-road', readonly: 'pl-server' } as const;

interface ServerPlaylist { id: string; name: string; comment: string | null; readonly: boolean; trackIds: string[]; changed: string }
export interface Call { method: string; args: unknown[]; at: number }

function buildLibrary() {
  const artists: Artist[] = artistNames.map((name, i) => ({ id: `ar-${i + 1}`, name, albumCount: 0, coverArt: null, starred: false }));
  const albums: Album[] = [];
  const tracks: Track[] = [];
  albumNames.forEach((name, i) => {
    const k = i + 1;
    const artist = artists[i % artists.length];
    artist.albumCount++;
    const long = name === 'Long Player';
    const year = long ? null : 2024 - i;
    const genre = long ? null : genres[k % genres.length];
    const songs: [string, number][] = k === 1 ? specialTracks
      : long ? Array.from({ length: 100 }, (_, n) => [`Take ${n + 1}`, 10 + n % 7])
      : Array.from({ length: 3 + (k % 3) }, (_, n) => k === 4 && n === 2 ? ['Word by Word', 24] : [`${trackWords[n]} ${k}`, 12 + ((k + n) % 5) * 3]);
    // Second Wind 2 is a duet: the server splits its credit into two artists (Track.artists).
    const albumTracks = songs.map(([title, duration], n): Track => ({
      id: `tr-${k}-${n + 1}`, title, artist: k === 2 && n === 1 ? `${artist.name} & ${artists[2].name}` : artist.name, album: name, duration,
      source: 'navidrome', sourceFormat: 'wav', sourceSampleRate: 8000, sourceBitDepth: 16,
      albumId: `al-${k}`, artistId: artist.id, coverArt: `al-${k}`, trackNumber: n + 1, discNumber: 1, year, genre, starred: false,
      ...(k === 2 && n === 1 ? { artists: [{ id: artist.id, name: artist.name }, { id: artists[2].id, name: artists[2].name }] } : {}),
    }));
    tracks.push(...albumTracks);
    albums.push({ id: `al-${k}`, name, artist: artist.name, songCount: albumTracks.length, artistId: artist.id, year, genre,
      duration: albumTracks.reduce((sum, t) => sum + (t.duration ?? 0), 0), coverArt: `al-${k}`, starred: false });
  });
  return { artists, albums, tracks };
}
const catalog = buildLibrary();
const trackById = new Map(catalog.tracks.map(track => [track.id, track]));
export const trackOf = (id: string) => trackById.get(id)!;
export const albumOf = (id: string) => catalog.albums.find(album => album.id === id)!;
export const allAlbums = catalog.albums;
export const allTracks = catalog.tracks;

const initialPlaylists = (): ServerPlaylist[] => [
  { id: playlistIds.road, name: 'Road Mix', comment: null, readonly: false, trackIds: ['tr-2-1', 'tr-2-2', 'tr-3-1', 'tr-2-1', 'tr-3-2'], changed: '2026-09-01T00:00:00Z' },
  { id: playlistIds.readonly, name: 'Server Picks', comment: null, readonly: true, trackIds: ['tr-4-1', 'tr-4-2', 'tr-5-1'], changed: '2026-09-01T00:00:00Z' },
];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const fail = (message: string) => Effect.fail(new Error(message));

export class FakeNavidrome {
  playlists: ServerPlaylist[] = initialPlaylists();
  calls: Call[] = [];
  reports: { id: string; event: 'started' | 'finished' }[] = [];
  starred = new Set<string>();
  saved: SavedQueue | null = null;
  /** Delays (ms) taken, one per call, by the named method before it touches any state. */
  private delays = new Map<string, number[]>();
  private created = 0;
  /** The preview plugin's clock; advancing it past 30 days ends every session. */
  clock = { now: Date.UTC(2026, 8, 25) };

  constructor(private readonly audioBase: () => string) {}

  reset() {
    this.playlists = initialPlaylists(); this.calls = []; this.reports = []; this.starred.clear();
    this.saved = null; this.delays.clear(); this.created = 0; this.clock.now = Date.UTC(2026, 8, 25);
  }
  delay(method: string, ...ms: number[]) { this.delays.set(method, ms); }
  playlist(id: string) { return this.playlists.find(p => p.id === id); }
  callsTo(method: string) { return this.calls.filter(call => call.method === method); }

  private track = (id: string): Track => ({ ...trackById.get(id)!, starred: this.starred.has(id) });
  private album = (album: Album): Album => ({ ...album, starred: this.starred.has(album.id) });
  private summary(p: ServerPlaylist): Playlist {
    const songs = p.trackIds.map(this.track);
    return { id: p.id, name: p.name, comment: p.comment, owner: 'tester', songCount: songs.length,
      duration: songs.reduce((sum, t) => sum + (t.duration ?? 0), 0), coverArt: songs[0]?.coverArt ?? null, readonly: p.readonly, changed: p.changed };
  }
  // Every method logs its call, waits out any configured delay, then answers from state as it is then.
  private op<T>(method: string, args: unknown[], run: () => Effect.Effect<T, Error>): Effect.Effect<T, Error> {
    return Effect.suspend(() => {
      this.calls.push({ method, args, at: Date.now() });
      const wait = this.delays.get(method)?.shift() ?? 0;
      return wait ? Effect.promise(() => sleep(wait)).pipe(Effect.flatMap(run)) : run();
    });
  }
  private editable(id: string): Effect.Effect<ServerPlaylist, Error> {
    const p = this.playlist(id);
    if (!p) return fail('That playlist no longer exists on the server.');
    if (p.readonly) return fail('This playlist is managed by the server and cannot be changed.');
    return Effect.succeed(p);
  }
  private touch(p: ServerPlaylist) { p.changed = new Date(this.clock.now).toISOString(); }

  readonly client = {
    albumList: (type: AlbumListType, offset: number, size: number) => this.op('albums', [type, offset, size], () => {
      let list = catalog.albums.map(this.album);
      if (type === 'alphabeticalByName') list.sort((a, b) => a.name.localeCompare(b.name));
      else if (type === 'alphabeticalByArtist') list.sort((a, b) => a.artist.localeCompare(b.artist) || a.name.localeCompare(b.name));
      else if (type === 'random') list = [...list].reverse();
      else if (type === 'starred') list = list.filter(a => a.starred);
      else if (type === 'frequent' || type === 'recent') list = [];
      return Effect.succeed(list.slice(offset, offset + size));
    }),
    album: (id: string) => this.op('album', [id], () => {
      const album = catalog.albums.find(a => a.id === id);
      if (!album) return fail('That record is not on the server.');
      return Effect.succeed({ album: this.album(album), tracks: catalog.tracks.filter(t => t.albumId === id).map(t => this.track(t.id)) });
    }),
    artists: () => this.op('artists', [], () => Effect.succeed(catalog.artists.map(a => ({ ...a, starred: this.starred.has(a.id) })))),
    artist: (id: string) => this.op('artist', [id], () => {
      const artist = catalog.artists.find(a => a.id === id);
      if (!artist) return fail('That artist is not on the server.');
      return Effect.succeed({ artist: { ...artist, starred: this.starred.has(id) }, albums: catalog.albums.filter(a => a.artistId === id).map(this.album) });
    }),
    playlists: () => this.op('playlists', [], () => Effect.succeed(this.playlists.map(p => this.summary(p)))),
    playlist: (id: string) => this.op('playlist', [id], () => {
      const p = this.playlist(id);
      if (!p) return fail('That playlist no longer exists on the server.');
      return Effect.succeed({ playlist: this.summary(p), tracks: p.trackIds.map(this.track) });
    }),
    genres: () => this.op('genres', [], () => Effect.succeed(genres.map(name => {
      const albums = catalog.albums.filter(a => a.genre === name);
      return { name, albumCount: albums.length, songCount: albums.reduce((sum, a) => sum + a.songCount, 0) };
    }))),
    starred: () => this.op('starred', [], () => Effect.succeed({
      artists: catalog.artists.filter(a => this.starred.has(a.id)).map(a => ({ ...a, starred: true })),
      albums: catalog.albums.filter(a => this.starred.has(a.id)).map(this.album),
      tracks: catalog.tracks.filter(t => this.starred.has(t.id)).map(t => this.track(t.id)),
    })),
    randomSongs: (options: RandomSongOptions) => this.op('randomSongs', [options], () => Effect.succeed(catalog.tracks
      .filter(t => (!options.genre || t.genre === options.genre) && (options.fromYear === undefined || (t.year ?? 0) >= options.fromYear)
        && (options.toYear === undefined || (t.year ?? 0) <= options.toYear))
      .slice(0, options.size).map(t => this.track(t.id)))),
    // search3 with an empty query: every song, in the order the server keeps them.
    songs: (offset: number, size: number) => this.op('songs', [offset, size], () =>
      Effect.succeed(catalog.tracks.slice(offset, offset + size).map(t => this.track(t.id)))),
    search: (query: string) => this.op('search', [query], () => {
      const q = query.toLowerCase();
      return Effect.succeed({
        artists: catalog.artists.filter(a => a.name.toLowerCase().includes(q)),
        albums: catalog.albums.filter(a => a.name.toLowerCase().includes(q)).map(this.album),
        tracks: catalog.tracks.filter(t => t.title.toLowerCase().includes(q)).map(t => this.track(t.id)),
      });
    }),
    star: (_target: StarTarget, id: string, starred: boolean) => this.op('star', [_target, id, starred], () => {
      if (starred) this.starred.add(id); else this.starred.delete(id);
      return Effect.void;
    }),
    createPlaylist: (name: string, trackIds: readonly string[]) => this.op('createPlaylist', [name, trackIds], () => {
      const p: ServerPlaylist = { id: `pl-new-${++this.created}`, name, comment: null, readonly: false, trackIds: [...trackIds], changed: '' };
      this.touch(p);
      this.playlists.push(p);
      return Effect.succeed(this.summary(p));
    }),
    addToPlaylist: (id: string, trackIds: readonly string[]) => this.op('addToPlaylist', [id, trackIds], () =>
      this.editable(id).pipe(Effect.map(p => { p.trackIds.push(...trackIds); this.touch(p); }))),
    updatePlaylist: (id: string, changes: { name?: string; comment?: string }) => this.op('updatePlaylist', [id, changes], () =>
      this.editable(id).pipe(Effect.map(p => { if (changes.name) p.name = changes.name; if (changes.comment !== undefined) p.comment = changes.comment; this.touch(p); }))),
    removeFromPlaylist: (id: string, indexes: readonly number[]) => this.op('removeFromPlaylist', [id, indexes], () =>
      this.editable(id).pipe(Effect.flatMap(p => {
        if (indexes.some(i => i < 0 || i >= p.trackIds.length)) return fail('That song is no longer in the playlist.');
        const drop = new Set(indexes);
        p.trackIds = p.trackIds.filter((_, i) => !drop.has(i)); this.touch(p);
        return Effect.void;
      }))),
    reorderPlaylist: (id: string, trackIds: readonly string[]) => this.op('reorderPlaylist', [id, trackIds], () =>
      this.editable(id).pipe(Effect.map(p => { p.trackIds = [...trackIds]; this.touch(p); }))),
    deletePlaylist: (id: string) => this.op('deletePlaylist', [id], () =>
      this.editable(id).pipe(Effect.map(p => { this.playlists = this.playlists.filter(other => other !== p); }))),
    similarSongs: (id: string, count: number) => this.op('similarSongs', [id, count], () =>
      Effect.succeed(catalog.tracks.filter(t => t.id !== id && t.albumId !== special.album).slice(0, count).map(t => this.track(t.id)))),
    topSongs: (artistId: string, count: number) => this.op('topSongs', [artistId, count], () =>
      Effect.succeed(catalog.tracks.filter(t => t.artistId === artistId).slice(0, count).map(t => this.track(t.id)))),
    lyrics: (query: LyricsQuery, lookup: boolean) => this.op('lyrics', [query, lookup], () =>
      Effect.succeed<Lyrics | null>(query.id === special.lyricLine ? { ...timeWords({ synced: true, lines: lyricLines }), source: 'server' }
        : query.id === special.wordByWord ? { ...timeWords({ synced: true, lines: wordLines }), source: 'server' } : null)),
    reportPlay: (id: string, event: 'started' | 'finished') => this.op('reportPlay', [id, event], () => {
      this.reports.push({ id, event });
      return Effect.void;
    }),
    savedQueue: () => this.op('savedQueue', [], () => Effect.succeed(this.saved)),
    saveQueue: (trackIds: readonly string[], currentIndex: number, positionSeconds: number) => this.op('saveQueue', [trackIds, currentIndex, positionSeconds], () => {
      this.saved = trackIds.length ? { tracks: trackIds.map(this.track), currentIndex, positionSeconds, changed: null, changedBy: null } : null;
      return Effect.void;
    }),
    coverArt: (id: string, _size: number) => {
      const k = Number(/^al-(\d+)$/.exec(id)?.[1]);
      if (!k) return fail('Cover art is not available.');
      return Effect.succeed({ contentType: 'image/png', bytes: new Uint8Array(coverPng((k * 47) % 360)) });
    },
    streamLocation: (id: string, format: 'raw' | 'mp3' = 'raw') => `${this.audioBase()}/rest/stream.view?id=${encodeURIComponent(id)}&format=${format}`,
  };

  get subsonic() { return this.client as unknown as SubsonicClient; }
}
