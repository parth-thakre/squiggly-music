import { Effect, Either, Schema } from 'effect';
import type {
  Album, AlbumDetail, AlbumListType, Artist, ArtistDetail, Connection, Genre, LibraryApi, LibraryItems, Lyrics, LyricsQuery,
  Playlist, PlaylistDetail, RandomSongOptions, Result, SavedQueue, StarTarget, Track, TrackPage, TrackSort,
} from '../core/contracts';
import type { PlayableTrack } from '../player-mpv/protocol';
import { Metrics } from '../core/metrics';
import { IdSchema, LibraryRequestSchemas } from '../core/validation';
import { type LrclibOptions, lrclibLyrics, parseLrc } from '../lyrics/lrclib';
import { timeWords } from '../lyrics/words';
import { md5Hex, randomSalt } from './auth';
import { LyricsListSchema, structuredLyrics } from './lyrics';

const DurationSchema = Schema.Number.pipe(Schema.finite(), Schema.nonNegative());
const CountSchema = DurationSchema.pipe(Schema.int());
// OpenSubsonic fields may carry a default zero when the source value is unknown.
const KnownCountSchema = Schema.transform(Schema.NullOr(CountSchema), Schema.NullOr(CountSchema.pipe(Schema.positive())), {
  strict: true, decode: value => value === 0 ? null : value, encode: value => value,
});
// Cover art and cross-reference IDs are opaque. Servers send '' when there is none.
const ReferenceSchema = Schema.String.pipe(Schema.maxLength(256));
// OpenSubsonic lists each credited artist with an id when the server splits a credit such as
// "A & B" (Navidrome does, by its tag settings). Older servers leave it out.
const ArtistRefsSchema = Schema.optional(Schema.Array(Schema.Struct({ id: ReferenceSchema, name: Schema.String })).pipe(Schema.maxItems(50)));
// The account's rating, 1 to 5; 0 or absent is unrated. Anything else is ignored rather than
// failing the whole response (see rated()).
const RatingSchema = Schema.optional(Schema.Number);
const SongSchema = Schema.Struct({
  id: IdSchema, title: Schema.String,
  artist: Schema.optional(Schema.String), album: Schema.optional(Schema.String),
  duration: Schema.optional(DurationSchema), suffix: Schema.optional(Schema.String),
  samplingRate: Schema.optional(KnownCountSchema), bitDepth: Schema.optional(KnownCountSchema),
  albumId: Schema.optional(ReferenceSchema), artistId: Schema.optional(ReferenceSchema), coverArt: Schema.optional(ReferenceSchema),
  track: Schema.optional(KnownCountSchema), discNumber: Schema.optional(KnownCountSchema), year: Schema.optional(KnownCountSchema),
  genre: Schema.optional(Schema.String), starred: Schema.optional(Schema.String), artists: ArtistRefsSchema,
  userRating: RatingSchema,
});
const AlbumFields = {
  id: IdSchema, name: Schema.String, artist: Schema.optional(Schema.String), songCount: Schema.optional(CountSchema),
  artistId: Schema.optional(ReferenceSchema), year: Schema.optional(KnownCountSchema), genre: Schema.optional(Schema.String),
  duration: Schema.optional(DurationSchema), coverArt: Schema.optional(ReferenceSchema), starred: Schema.optional(Schema.String),
  artists: ArtistRefsSchema,
  userRating: RatingSchema,
};
const AlbumSchema = Schema.Struct({ ...AlbumFields, song: Schema.optional(Schema.Array(SongSchema).pipe(Schema.maxItems(500))) });
const ArtistFields = {
  id: IdSchema, name: Schema.String, albumCount: Schema.optional(CountSchema),
  coverArt: Schema.optional(ReferenceSchema), starred: Schema.optional(Schema.String),
  userRating: RatingSchema,
};
const ArtistSchema = Schema.Struct(ArtistFields);
const PlaylistFields = {
  id: IdSchema, name: Schema.String, comment: Schema.optional(Schema.String), owner: Schema.optional(Schema.String),
  songCount: Schema.optional(CountSchema), duration: Schema.optional(DurationSchema), coverArt: Schema.optional(ReferenceSchema),
  readonly: Schema.optional(Schema.Boolean), changed: Schema.optional(Schema.String),
};
const PlaylistSchema = Schema.Struct({ ...PlaylistFields, entry: Schema.optional(Schema.Array(SongSchema).pipe(Schema.maxItems(5000))) });
const EnvelopeSchema = Schema.Struct({ 'subsonic-response': Schema.Unknown });
const StatusSchema = Schema.Struct({
  status: Schema.Literal('ok', 'failed'),
  type: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Struct({ code: Schema.Number })),
});
const AlbumsSchema = Schema.Struct({
  albumList2: Schema.Struct({ album: Schema.optional(Schema.Array(Schema.Struct(AlbumFields)).pipe(Schema.maxItems(500))) }),
});
const AlbumResponseSchema = Schema.Struct({ album: AlbumSchema });
const ArtistsSchema = Schema.Struct({ artists: Schema.Struct({
  index: Schema.optional(Schema.Array(Schema.Struct({ artist: Schema.optional(Schema.Array(ArtistSchema).pipe(Schema.maxItems(10_000))) })).pipe(Schema.maxItems(1000))),
}) });
const ArtistResponseSchema = Schema.Struct({ artist: Schema.Struct({ ...ArtistFields, album: Schema.optional(Schema.Array(Schema.Struct(AlbumFields)).pipe(Schema.maxItems(2000))) }) });
const PlaylistsSchema = Schema.Struct({ playlists: Schema.Struct({ playlist: Schema.optional(Schema.Array(Schema.Struct(PlaylistFields)).pipe(Schema.maxItems(5000))) }) });
const PlaylistResponseSchema = Schema.Struct({ playlist: PlaylistSchema });
// OpenSubsonic returns the new playlist; legacy Subsonic servers return an empty body.
const CreatedPlaylistSchema = Schema.Struct({ playlist: Schema.optional(PlaylistSchema) });
const GenresSchema = Schema.Struct({ genres: Schema.Struct({ genre: Schema.optional(Schema.Array(Schema.Struct({
  value: Schema.String, songCount: Schema.optional(CountSchema), albumCount: Schema.optional(CountSchema),
})).pipe(Schema.maxItems(10_000))) }) });
const itemsSchema = (artists: number, albums: number, songs: number) => Schema.Struct({
  artist: Schema.optional(Schema.Array(ArtistSchema).pipe(Schema.maxItems(artists))),
  album: Schema.optional(Schema.Array(Schema.Struct(AlbumFields)).pipe(Schema.maxItems(albums))),
  song: Schema.optional(Schema.Array(SongSchema).pipe(Schema.maxItems(songs))),
});
const StarredSchema = Schema.Struct({ starred2: itemsSchema(5000, 5000, 5000) });
const SearchSchema = Schema.Struct({ searchResult3: itemsSchema(8, 16, 40) });
const SongPageSchema = Schema.Struct({ searchResult3: Schema.Struct({ song: Schema.optional(Schema.Array(SongSchema).pipe(Schema.maxItems(500))) }) });
// Navidrome's own API (/api/song), which can sort. Its song is model.MediaFile as JSON.
const NativeSongSchema = Schema.Struct({
  id: IdSchema, title: Schema.String, artist: Schema.optional(Schema.String), album: Schema.optional(Schema.String),
  duration: Schema.optional(DurationSchema), suffix: Schema.optional(Schema.String),
  sampleRate: Schema.optional(KnownCountSchema), bitDepth: Schema.optional(KnownCountSchema),
  albumId: Schema.optional(ReferenceSchema), artistId: Schema.optional(ReferenceSchema),
  hasCoverArt: Schema.optional(Schema.Boolean), imageHash: Schema.optional(ReferenceSchema),
  trackNumber: Schema.optional(KnownCountSchema), discNumber: Schema.optional(KnownCountSchema), year: Schema.optional(KnownCountSchema),
  genre: Schema.optional(Schema.String), starred: Schema.optional(Schema.Boolean), starredAt: Schema.optional(Schema.String),
  playCount: Schema.optional(CountSchema), playDate: Schema.optional(Schema.NullOr(Schema.String)),
  participants: Schema.optional(Schema.Struct({ artist: ArtistRefsSchema })),
  rating: Schema.optional(Schema.NullOr(Schema.Number)),
});
const NativeSongsSchema = Schema.Array(NativeSongSchema).pipe(Schema.maxItems(500));
const NativeLoginSchema = Schema.Struct({ token: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(8192)) });
type NativeSong = Schema.Schema.Type<typeof NativeSongSchema>;
// Navidrome's sort names (persistence/mediafile_repository.go). recently_added is created_at with
// the id to break ties, so pages don't overlap.
const nativeSorts: Record<TrackSort, [sort: string, order: 'asc' | 'desc']> = {
  newest: ['recently_added', 'desc'], alphabeticalByName: ['title', 'asc'], alphabeticalByArtist: ['artist', 'asc'],
  frequent: ['play_count', 'desc'], recent: ['play_date', 'desc'], random: ['random', 'asc'],
  highest: ['rating', 'desc'],
};
// The same song as Subsonic describes it, so it maps to the same Track. Subsonic truncates the
// duration, and names cover art as model.MediaFile.CoverArtID does: the song's own art, else its
// disc's, else its album's. This API leaves out the album art's hash, a cache key that
// getCoverArt doesn't need.
const nativeHash = (id: string, hash: string | undefined) => hash ? `${id}_${hash}` : id;
const fromNative = (song: NativeSong): Song => ({
  id: song.id, title: song.title, artist: song.artist, album: song.album,
  duration: song.duration === undefined ? undefined : Math.trunc(song.duration), suffix: song.suffix,
  samplingRate: song.sampleRate, bitDepth: song.bitDepth, albumId: song.albumId, artistId: song.artistId,
  coverArt: song.hasCoverArt ? nativeHash(`mf-${song.id}`, song.imageHash)
    : !song.albumId ? undefined : song.discNumber ? nativeHash(`dc-${song.albumId}:${song.discNumber}`, song.imageHash) : `al-${song.albumId}`,
  track: song.trackNumber, discNumber: song.discNumber, year: song.year, genre: song.genre,
  starred: song.starred ? song.starredAt ?? 'starred' : undefined, artists: song.participants?.artist,
  userRating: song.rating ?? undefined,
});
const RandomSongsSchema = Schema.Struct({ randomSongs: Schema.Struct({ song: Schema.optional(Schema.Array(SongSchema).pipe(Schema.maxItems(500))) }) });
const ExtensionsSchema = Schema.Struct({ openSubsonicExtensions: Schema.Array(Schema.Struct({
  name: Schema.String.pipe(Schema.maxLength(256)), versions: Schema.Array(CountSchema).pipe(Schema.maxItems(100)),
})).pipe(Schema.maxItems(500)) });
const SongListSchema = Schema.Struct({ song: Schema.optional(Schema.Array(SongSchema).pipe(Schema.maxItems(200))) });
const SimilarSongsSchema = Schema.Struct({ similarSongs: SongListSchema });
const TopSongsSchema = Schema.Struct({ topSongs: SongListSchema });
const LegacyLyricsSchema = Schema.Struct({ lyrics: Schema.optional(Schema.Struct({ value: Schema.optional(Schema.String.pipe(Schema.maxLength(200_000))) })) });
// Saved queues. Positions are milliseconds. Legacy servers name the current song; indexBasedQueue gives its index.
const QueueFields = {
  position: Schema.optional(DurationSchema), changed: Schema.optional(Schema.String.pipe(Schema.maxLength(256))),
  changedBy: Schema.optional(Schema.String.pipe(Schema.maxLength(256))), entry: Schema.optional(Schema.Array(SongSchema).pipe(Schema.maxItems(5000))),
};
const QueueByIndexSchema = Schema.Struct({ playQueueByIndex: Schema.Struct({ ...QueueFields, currentIndex: Schema.optional(CountSchema) }) });
const QueueSchema = Schema.Struct({ playQueue: Schema.optional(Schema.Struct({ ...QueueFields, current: Schema.optional(Schema.Union(IdSchema, CountSchema)) })) });
type QueueValue = Schema.Schema.Type<Schema.Struct<typeof QueueFields>>;
type Song = Schema.Schema.Type<typeof SongSchema>;
type Params = Record<string, string | readonly string[]>;
// Raster formats only: the desktop serves these bytes to the renderer under its own scheme.
const coverTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);
const clamp = (value: number, min: number, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
// Response bodies as one byte array, and as text. The BOM is kept, as Node's Buffer did.
function concatBytes(chunks: readonly Uint8Array[], total: number) {
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
const utf8 = (body: Uint8Array<ArrayBuffer>) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(body);

// Only locally authored messages can cross the desktop boundary. Server error
// text and fetch errors may contain credentials or authenticated URLs.
class ServerError extends Error { constructor(message: string, readonly code?: number) { super(message); } }
// Navidrome's own API isn't there (another server, or a proxy that passes only /rest), or won't
// take this sign-in (the server signs people in some other way).
class NativeMissing extends ServerError {}
class NativeSignedOut extends ServerError {}
function protocolError(code: number | undefined): ServerError {
  const messages: Record<number, string> = {
    20: 'This server requires a newer Subsonic API version.',
    30: 'This server uses an older Subsonic API version. Update the server.',
    40: 'Incorrect username or password. Check your Navidrome login and try again.',
    41: 'This server does not support token authentication.',
    50: 'Your account does not have permission to perform this action.',
    70: 'This album or track is no longer available. Refresh the library.',
  };
  return new ServerError(messages[code ?? -1] ?? 'The server rejected the request. Check your account and server settings.', code);
}

// An address typed without a scheme ("music.example.com") is tried as HTTPS, then HTTP.
export const hasScheme = (input: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim());
export function serverUrlCandidates(input: string): string[] {
  const trimmed = input.trim();
  return hasScheme(trimmed) ? [trimmed] : [`https://${trimmed}`, `http://${trimmed}`];
}

export function normalizeServerUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); }
  catch { throw new ServerError('Enter your server\'s address, such as music.example.com.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS server URL without embedded credentials, query parameters, or a fragment.');
  }
  url.search = ''; url.hash = '';
  // Only an explicit API endpoint identifies a suffix we can remove. Bare
  // /app and /rest may be the configured server base path, not UI/API routes.
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/rest\/[a-zA-Z0-9]+\.view$/, '');
  return url.href.replace(/\/+$/, '');
}

// Only credits that name more than one artist are kept: one is already artistId.
const artistRefs = (refs: readonly { id: string; name: string }[] | undefined) => {
  const named = (refs ?? []).filter(ref => ref.id && ref.name.trim()).map(ref => ({ id: ref.id, name: ref.name.trim() }));
  return named.length > 1 ? { artists: named } : {};
};
// A whole number from 1 to 5, or nothing.
const rated = (rating: number | undefined) => rating !== undefined && Number.isInteger(rating) && rating >= 1 && rating <= 5 ? { userRating: rating } : {};
function toAlbum(album: Schema.Schema.Type<Schema.Struct<typeof AlbumFields>>): Album {
  return {
    id: album.id, name: album.name, artist: album.artist ?? 'Unknown artist', songCount: album.songCount ?? 0,
    artistId: album.artistId || null, year: album.year ?? null, genre: album.genre || null, duration: album.duration ?? null,
    coverArt: album.coverArt || null, starred: Boolean(album.starred), ...artistRefs(album.artists),
    ...rated(album.userRating),
  };
}
function toArtist(artist: Schema.Schema.Type<typeof ArtistSchema>): Artist {
  return { id: artist.id, name: artist.name, albumCount: artist.albumCount ?? 0, coverArt: artist.coverArt || null, starred: Boolean(artist.starred), ...rated(artist.userRating) };
}
function toTrack(song: Song, album?: { name: string; artist?: string }): Track {
  return {
    id: song.id, title: song.title, artist: song.artist ?? album?.artist ?? 'Unknown artist', album: song.album ?? album?.name ?? '',
    duration: song.duration ?? null, source: 'navidrome', sourceFormat: song.suffix ?? null,
    sourceSampleRate: song.samplingRate ?? null, sourceBitDepth: song.bitDepth ?? null,
    albumId: song.albumId || null, artistId: song.artistId || null, coverArt: song.coverArt || null,
    trackNumber: song.track ?? null, discNumber: song.discNumber ?? null, year: song.year ?? null,
    genre: song.genre || null, starred: Boolean(song.starred), ...artistRefs(song.artists),
    ...rated(song.userRating),
  };
}
const songList = (songs: readonly Song[] | undefined, max: number) => (songs ?? []).length > max
  ? Effect.fail(new ServerError('The server returned more tracks than requested.')) : Effect.succeed((songs ?? []).map(song => toTrack(song)));
// Most and recently played list played tracks only, as Navidrome's own lists do, and top rated
// lists rated tracks only. Their order puts the rest last, so a page ends where they begin, and
// a short page is the last.
function played(sort: TrackSort, songs: readonly NativeSong[]) {
  const keep = sort === 'frequent' ? (song: NativeSong) => (song.playCount ?? 0) > 0 : sort === 'recent' ? (song: NativeSong) => !!song.playDate
    : sort === 'highest' ? (song: NativeSong) => (song.rating ?? 0) > 0 : null;
  const end = keep ? songs.findIndex(song => !keep(song)) : -1;
  return end < 0 ? songs : songs.slice(0, end);
}
const playlistEditMessages: Record<number, string> = {
  50: 'This playlist cannot be changed. Only its owner can edit it, and smart or imported playlists are read-only.',
  70: 'This playlist no longer exists. Refresh your playlists.',
};
const toItems = (items: Schema.Schema.Type<ReturnType<typeof itemsSchema>>): LibraryItems => ({
  artists: (items.artist ?? []).map(toArtist), albums: (items.album ?? []).map(toAlbum), tracks: (items.song ?? []).map(song => toTrack(song)),
});

// How the client reaches the server. The Android app passes a fetch that runs natively
// (bridge/android/http.ts), which has no CORS or mixed-content rules to satisfy.
export interface ClientOptions { fetch?: typeof globalThis.fetch }

export class SubsonicClient {
  readonly baseUrl: string;
  private auth: { username: string; salt: string; token: string };
  private extensions: Effect.Effect<ReadonlyMap<string, readonly number[]>>;
  // Navidrome's own API, which sorts tracks: whether it's there (null until asked), the session
  // token it gave (in memory only, replaced by the fresh one each answer brings), and the
  // password it signs in with, which Subsonic's token authentication never needed to keep.
  readonly #password: string;
  #native: boolean | null = null;
  #jwt: string | null = null;
  #signingIn: Effect.Effect<string, Error> | null = null;
  // lrclib overrides the LRCLIB address and fetch for tests; it is only contacted when a lyrics lookup allows it.
  constructor(connection: Connection, private metrics: Metrics, private lrclib: LrclibOptions = {}, private options: ClientOptions = {}) {
    this.baseUrl = normalizeServerUrl(connection.url);
    this.#password = connection.password;
    const salt = randomSalt();
    this.auth = {
      username: connection.username, salt,
      // OpenSubsonic token authentication requires MD5(password + salt).
      token: md5Hex(connection.password + salt),
    };
    // Discovery is public and must use baseline GET before formPost is known.
    // Legacy servers may reject this endpoint; cache the safe GET fallback too.
    this.extensions = Effect.runSync(Effect.cached(
      this.exchange('getOpenSubsonicExtensions', ExtensionsSchema, {}, false, false).pipe(
        Effect.map(result => new Map(result.openSubsonicExtensions.map(extension => [extension.name, extension.versions] as const))),
        Effect.catchAll(() => Effect.succeed(new Map<string, readonly number[]>())),
      ),
    ));
  }
  private supports(extension: string, version = 1) {
    return this.extensions.pipe(Effect.map(extensions => extensions.get(extension)?.includes(version) ?? false));
  }
  private endpointUrl(endpoint: string) {
    const url = new URL(this.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/rest/${endpoint}.view`;
    return url;
  }
  // Array values become repeated keys, as in createPlaylist's songId.
  private params(extra: Params = {}) {
    const params = new URLSearchParams({
      u: this.auth.username, t: this.auth.token, s: this.auth.salt,
      v: '1.16.1', c: 'squiggly', f: 'json',
    });
    for (const [key, value] of Object.entries(extra)) for (const item of typeof value === 'string' ? [value] : value) params.append(key, item);
    return params;
  }
  // accept() inspects headers before the body is read; parse() runs on the capped body.
  private transfer<A, B>(endpoint: string, extra: Params, formPost: boolean, authenticated: boolean, limitMB: number, accept: (response: Response) => B, parse: (body: Uint8Array<ArrayBuffer>, accepted: B) => A) {
    const url = this.endpointUrl(endpoint);
    const params = authenticated ? this.params(extra) : new URLSearchParams({ v: '1.16.1', c: 'squiggly', f: 'json' });
    if (!formPost) url.search = params.toString();
    return this.send(`server.${endpoint}`, url.href, { method: formPost ? 'POST' : 'GET', ...(formPost ? { body: params } : {}) }, limitMB, response => {
      if (!response.ok) throw new ServerError(`Server returned HTTP ${response.status}. Check the server address and reverse proxy settings.`);
      return accept(response);
    }, parse);
  }
  private send<A, B>(metric: string, url: string, init: RequestInit, limitMB: number, accept: (response: Response) => B, parse: (body: Uint8Array<ArrayBuffer>, accepted: B) => A) {
    const task = Effect.tryPromise({
      try: async signal => {
        const response = await (this.options.fetch ?? fetch)(url, { ...init, signal, redirect: 'error' });
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const accepted = accept(response);
          // Cap response sizes before parsing untrusted server data.
          reader = response.body?.getReader();
          if (!reader) throw new ServerError('Server returned an empty response.');
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limitMB * 1024 * 1024) throw new ServerError(`Server response exceeded ${limitMB} MB.`);
            chunks.push(value);
          }
          return parse(concatBytes(chunks, total), accepted);
        } finally {
          // Release the transfer on HTTP errors, size limits, read failures, and success.
          if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          else await response.body?.cancel().catch(() => {});
        }
      },
      // Never forward fetch errors containing authenticated URLs or server-provided text.
      catch: error => error instanceof ServerError ? error : new ServerError('Server request failed. Check the address, connection, and Navidrome/OpenSubsonic compatibility.'),
    }).pipe(Effect.timeoutFail({ duration: '15 seconds', onTimeout: () => new ServerError('The server did not respond within 15 seconds. Check your connection and try again.') }));
    return this.metrics.measure(metric, task);
  }
  private exchange<A, I>(endpoint: string, schema: Schema.Schema<A, I>, extra: Params, formPost: boolean, authenticated = true) {
    return this.transfer(endpoint, extra, formPost, authenticated, 8, () => undefined, body => {
      const result = Schema.decodeUnknownSync(EnvelopeSchema)(JSON.parse(utf8(body)))['subsonic-response'];
      const status = Schema.decodeUnknownSync(StatusSchema)(result);
      if (status.status !== 'ok') throw protocolError(status.error?.code);
      return Schema.decodeUnknownSync(schema)(result);
    });
  }
  private request<A, I>(endpoint: string, schema: Schema.Schema<A, I>, extra: Params = {}) {
    return this.supports('formPost').pipe(Effect.flatMap(formPost => this.exchange(endpoint, schema, extra, formPost)));
  }
  // Whether a Subsonic server answers at this address, asked without credentials: any Subsonic
  // reply counts, even one refusing the request. Used to pick HTTPS or HTTP before signing in.
  probe() {
    return this.transfer('ping', {}, false, false, 1, () => undefined, body => {
      Schema.decodeUnknownSync(StatusSchema)(Schema.decodeUnknownSync(EnvelopeSchema)(JSON.parse(utf8(body)))['subsonic-response']);
      return true;
    });
  }
  ping() {
    return this.request('ping', StatusSchema).pipe(Effect.map(result => ({
      name: result.type?.toLowerCase() === 'navidrome' ? 'Navidrome' : 'OpenSubsonic',
    })));
  }
  albumList(type: AlbumListType, offset: number, size: number) {
    const count = clamp(size, 1, 500);
    return this.request('getAlbumList2', AlbumsSchema, { type, size: String(count), offset: String(clamp(offset, 0, Number.MAX_SAFE_INTEGER)) }).pipe(Effect.flatMap(result => {
      const albums = result.albumList2.album ?? [];
      // Reject an oversized page rather than silently truncating it.
      return albums.length > count ? Effect.fail(new ServerError('The server returned more albums than requested.')) : Effect.succeed(albums.map(toAlbum));
    }));
  }
  album(id: string) {
    return this.request('getAlbum', AlbumResponseSchema, { id }).pipe(Effect.flatMap(({ album }) => album.id !== id
      ? Effect.fail(new ServerError('The server did not return the requested album. Refresh the library.'))
      : Effect.succeed<AlbumDetail>({ album: toAlbum({ ...album, songCount: album.songCount ?? album.song?.length }), tracks: (album.song ?? []).map(song => toTrack(song, album)) })));
  }
  artists() {
    return this.request('getArtists', ArtistsSchema).pipe(Effect.flatMap(result => {
      const artists = (result.artists.index ?? []).flatMap(index => index.artist ?? []);
      return artists.length > 10_000 ? Effect.fail(new ServerError('This library has more than 10,000 artists.')) : Effect.succeed(artists.map(toArtist));
    }));
  }
  artist(id: string) {
    return this.request('getArtist', ArtistResponseSchema, { id }).pipe(Effect.flatMap(({ artist }) => artist.id !== id
      ? Effect.fail(new ServerError('The server did not return the requested artist. Refresh the library.'))
      : Effect.succeed<ArtistDetail>({ artist: toArtist(artist), albums: (artist.album ?? []).map(toAlbum) })));
  }
  private toPlaylist(playlist: Schema.Schema.Type<Schema.Struct<typeof PlaylistFields>>): Playlist {
    return {
      id: playlist.id, name: playlist.name, comment: playlist.comment || null, owner: playlist.owner || null,
      songCount: playlist.songCount ?? 0, duration: playlist.duration ?? 0, coverArt: playlist.coverArt || null,
      // Only the owner can edit a playlist, whatever the server reports.
      readonly: playlist.readonly === true || (playlist.owner !== undefined && playlist.owner.toLowerCase() !== this.auth.username.toLowerCase()),
      changed: playlist.changed || null,
    };
  }
  playlists() {
    return this.request('getPlaylists', PlaylistsSchema).pipe(Effect.map(result => (result.playlists.playlist ?? []).map(playlist => this.toPlaylist(playlist))));
  }
  playlist(id: string) {
    return this.request('getPlaylist', PlaylistResponseSchema, { id }).pipe(Effect.flatMap(({ playlist }) => playlist.id !== id
      ? Effect.fail(new ServerError('The server did not return the requested playlist. Refresh your playlists.'))
      : Effect.succeed<PlaylistDetail>({ playlist: this.toPlaylist(playlist), tracks: (playlist.entry ?? []).map(song => toTrack(song)) })));
  }
  genres() {
    return this.request('getGenres', GenresSchema).pipe(Effect.map(result => (result.genres.genre ?? []).map((genre): Genre => ({
      name: genre.value, songCount: genre.songCount ?? 0, albumCount: genre.albumCount ?? 0,
    }))));
  }
  starred() { return this.request('getStarred2', StarredSchema).pipe(Effect.map(result => toItems(result.starred2))); }
  randomSongs(options: RandomSongOptions) {
    const size = clamp(options.size, 1, 500);
    return this.request('getRandomSongs', RandomSongsSchema, {
      size: String(size), ...(options.genre ? { genre: options.genre } : {}),
      ...(options.fromYear !== undefined ? { fromYear: String(options.fromYear) } : {}), ...(options.toYear !== undefined ? { toYear: String(options.toYear) } : {}),
    }).pipe(Effect.flatMap(result => songList(result.randomSongs.song, size)));
  }
  search(query: string) {
    return this.request('search3', SearchSchema, { query, artistCount: '8', albumCount: '16', songCount: '40' }).pipe(Effect.map(result => toItems(result.searchResult3)));
  }
  // Every track. OpenSubsonic can't sort them: an empty search3 query answers with every song in
  // one fixed order (Navidrome's is the order it first scanned them). Navidrome's own API sorts,
  // so it's used where it's there, and search3 where it isn't.
  tracks(sort: TrackSort, offset: number, size: number, seed = ''): Effect.Effect<TrackPage, Error> {
    const count = clamp(size, 1, 500), start = clamp(offset, 0, Number.MAX_SAFE_INTEGER);
    const scan = this.request('search3', SongPageSchema, {
      query: '""', artistCount: '0', albumCount: '0', songCount: String(count), songOffset: String(start),
    }).pipe(Effect.flatMap(result => songList(result.searchResult3.song, count)), Effect.map((tracks): TrackPage => ({ tracks, sorted: false })));
    return this.navidrome().pipe(Effect.flatMap(navidrome => !navidrome ? scan : this.nativeTracks(sort, start, count, seed).pipe(
      Effect.map((tracks): TrackPage => ({ tracks, sorted: true })),
      Effect.catchIf(error => error instanceof NativeMissing, () => Effect.suspend(() => { this.#native = false; return scan; })),
    )));
  }
  // Navidrome, as its ping says, until its own API turns out to be missing.
  private navidrome() {
    return this.#native !== null ? Effect.succeed(this.#native) : this.request('ping', StatusSchema).pipe(Effect.map(result => {
      this.#native ??= result.type?.toLowerCase() === 'navidrome';
      return this.#native;
    }));
  }
  private nativeUrl(path: string) {
    const url = new URL(this.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
    return url;
  }
  private nativeTracks(sort: TrackSort, offset: number, size: number, seed: string) {
    const [order, direction] = nativeSorts[sort];
    const url = this.nativeUrl('/api/song');
    url.search = new URLSearchParams({
      _sort: order, _order: direction, _start: String(offset), _end: String(offset + size), missing: 'false', ...(sort === 'random' && seed ? { seed } : {}),
    }).toString();
    const get = (token: string) => this.send('native.song', url.href, { headers: { 'x-nd-authorization': `Bearer ${token}` } }, 8, response => {
      if (response.status === 401) throw new NativeSignedOut('Navidrome did not accept the sign-in. Try again, or sign in again.');
      if (response.status === 404) throw new NativeMissing('Navidrome\'s own API is not available.');
      if (!response.ok) throw new ServerError(`Server returned HTTP ${response.status}. Check the server address and reverse proxy settings.`);
      // Every answer brings the session token back with a later expiry.
      const fresh = response.headers.get('x-nd-authorization');
      if (fresh) this.#jwt = fresh;
    }, body => Schema.decodeUnknownSync(NativeSongsSchema)(JSON.parse(utf8(body))));
    // An expired session (or a server restarted with a new key) signs in again, once.
    return this.nativeSession().pipe(
      Effect.flatMap(get),
      Effect.catchIf(error => error instanceof NativeSignedOut, () => Effect.suspend(() => { this.#jwt = null; return this.nativeSession().pipe(Effect.flatMap(get)); })),
      Effect.flatMap(songs => songs.length > size ? Effect.fail(new ServerError('The server returned more tracks than requested.'))
        : Effect.succeed(played(sort, songs).map(song => toTrack(fromNative(song))))),
    );
  }
  // One sign-in at a time; a failed one is tried again by the next request.
  private nativeSession(): Effect.Effect<string, Error> {
    return Effect.suspend(() => {
      if (this.#jwt) return Effect.succeed(this.#jwt);
      if (!this.#signingIn) {
        const attempt: Effect.Effect<string, Error> = Effect.runSync(Effect.cached(this.nativeSignIn().pipe(
          Effect.tap(token => Effect.sync(() => { this.#jwt = token; })),
          Effect.ensuring(Effect.sync(() => { if (this.#signingIn === attempt) this.#signingIn = null; })),
        )));
        this.#signingIn = attempt;
      }
      return this.#signingIn;
    });
  }
  private nativeSignIn() {
    const missing = () => new NativeMissing('Navidrome\'s own API is not available.');
    return this.send('native.login', this.nativeUrl('/auth/login').href, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: this.auth.username, password: this.#password }),
    }, 1, response => {
      // No such route, or a server that signs people in some other way (a proxy's own sign-in).
      if ([401, 403, 404, 405].includes(response.status)) throw missing();
      if (!response.ok) throw new ServerError(`Server returned HTTP ${response.status}. Check the server address and reverse proxy settings.`);
    }, body => {
      try { return Schema.decodeUnknownSync(NativeLoginSchema)(JSON.parse(utf8(body))).token; }
      catch { throw missing(); }
    });
  }
  star(target: StarTarget, id: string, starred: boolean) {
    const key = { track: 'id', album: 'albumId', artist: 'artistId' }[target];
    return this.request(starred ? 'star' : 'unstar', StatusSchema, { [key]: id }).pipe(Effect.asVoid);
  }
  // Songs, albums, and artists share one id space here, so setRating takes any of them. 0 clears.
  setRating(id: string, rating: number) {
    return this.request('setRating', StatusSchema, { id, rating: String(clamp(rating, 0, 5)) }).pipe(Effect.asVoid);
  }
  createPlaylist(name: string, trackIds: readonly string[]) {
    return this.request('createPlaylist', CreatedPlaylistSchema, { name, songId: trackIds }).pipe(Effect.flatMap(result => result.playlist
      ? Effect.succeed(this.toPlaylist(result.playlist))
      : Effect.fail(new ServerError('The playlist was created, but the server did not return it. Refresh your playlists.'))));
  }
  // Editing someone else's playlist, or a smart or imported one, fails with a playlist-specific message.
  private editPlaylist(endpoint: string, params: Params) {
    return this.request(endpoint, StatusSchema, params).pipe(Effect.asVoid, Effect.mapError(error =>
      error instanceof ServerError && error.code !== undefined && playlistEditMessages[error.code] ? new ServerError(playlistEditMessages[error.code], error.code) : error));
  }
  addToPlaylist(playlistId: string, trackIds: readonly string[]) { return this.editPlaylist('updatePlaylist', { playlistId, songIdToAdd: trackIds }); }
  updatePlaylist(playlistId: string, changes: { name?: string; comment?: string }) {
    return this.editPlaylist('updatePlaylist', {
      playlistId, ...(changes.name !== undefined ? { name: changes.name } : {}), ...(changes.comment !== undefined ? { comment: changes.comment } : {}),
    });
  }
  removeFromPlaylist(playlistId: string, indexes: readonly number[]) {
    return this.editPlaylist('updatePlaylist', { playlistId, songIndexToRemove: [...new Set(indexes)].map(index => String(clamp(index, 0, Number.MAX_SAFE_INTEGER))) });
  }
  // createPlaylist with an ID replaces the playlist's songs, which is the only way to reorder them.
  reorderPlaylist(playlistId: string, trackIds: readonly string[]) {
    return trackIds.length > 5000 ? Effect.fail(new ServerError('Playlists can hold at most 5,000 songs.'))
      : this.editPlaylist('createPlaylist', { playlistId, songId: trackIds });
  }
  deletePlaylist(playlistId: string) { return this.editPlaylist('deletePlaylist', { id: playlistId }); }
  // Accepts a song, album or artist ID. Servers without similarity data return no songs.
  similarSongs(id: string, count: number) {
    const size = clamp(count, 1, 200);
    return this.request('getSimilarSongs', SimilarSongsSchema, { id, count: String(size) }).pipe(Effect.flatMap(result => songList(result.similarSongs.song, size)));
  }
  // topSongsByArtistId looks songs up by artist ID. Other servers only match by name, so this
  // resolves the name first and keeps songs by that artist; it degrades to no songs.
  topSongs(artistId: string, count: number) {
    const size = clamp(count, 1, 200);
    const top = (params: Params) => this.request('getTopSongs', TopSongsSchema, { ...params, count: String(size) }).pipe(Effect.flatMap(result => songList(result.topSongs.song, size)));
    return this.supports('topSongsByArtistId').pipe(Effect.flatMap(byId => byId ? top({ id: artistId }) : this.artist(artistId).pipe(
      Effect.flatMap(({ artist }) => top({ artist: artist.name })),
      Effect.map(tracks => tracks.filter(track => !track.artistId || track.artistId === artistId)),
      Effect.catchAll(() => Effect.succeed<Track[]>([])),
    )));
  }
  // Server lyrics (embedded or sidecar .lrc) come first. LRCLIB is contacted only when lookup
  // is true and the server has none; it receives the song's title, artist, album and duration.
  lyrics(query: LyricsQuery, lookup: boolean) {
    // songLyrics version 2 adds word cues when asked for them (enhanced=true).
    const structured = Effect.all([this.supports('songLyrics'), this.supports('songLyrics', 2)]);
    const server = structured.pipe(Effect.flatMap(([v1, v2]) => v1 || v2
      ? this.request('getLyricsBySongId', LyricsListSchema, v2 ? { id: query.id, enhanced: 'true' } : { id: query.id })
        .pipe(Effect.map(result => structuredLyrics(result.lyricsList.structuredLyrics ?? [])))
      : this.request('getLyrics', LegacyLyricsSchema, { artist: query.artist, title: query.title }).pipe(Effect.map((result): Lyrics | null => {
        const parsed = result.lyrics?.value ? parseLrc(result.lyrics.value) : null;
        return parsed && { ...timeWords(parsed), source: 'server' };
      }))),
    // An unknown song simply has no server lyrics.
    Effect.catchIf(error => error instanceof ServerError && error.code === 70, () => Effect.succeed(null)));
    return server.pipe(Effect.flatMap(found => found || !lookup ? Effect.succeed(found) : this.metrics.measure('lyrics.lrclib', lrclibLyrics(query, this.lrclib))));
  }
  // Now playing when a song starts; a play count and scrobble when it finishes.
  reportPlay(trackId: string, event: 'started' | 'finished') {
    return this.request('scrobble', StatusSchema, event === 'started' ? { id: trackId, submission: 'false' } : { id: trackId, submission: 'true', time: String(Date.now()) }).pipe(Effect.asVoid);
  }
  private toSavedQueue(queue: QueueValue, index: number): SavedQueue | null {
    const tracks = (queue.entry ?? []).map(song => toTrack(song));
    if (!tracks.length) return null;
    // An unknown current song restarts the queue rather than resuming the wrong song mid-way.
    const known = index >= 0 && index < tracks.length;
    return {
      tracks, currentIndex: known ? index : 0, positionSeconds: known ? (queue.position ?? 0) / 1000 : 0,
      changed: queue.changed || null, changedBy: queue.changedBy || null,
    };
  }
  savedQueue(): Effect.Effect<SavedQueue | null, Error> {
    return this.supports('indexBasedQueue').pipe(Effect.flatMap(byIndex => byIndex
      ? this.request('getPlayQueueByIndex', QueueByIndexSchema).pipe(Effect.map(({ playQueueByIndex: queue }) => this.toSavedQueue(queue, queue.currentIndex ?? 0)))
      : this.request('getPlayQueue', QueueSchema).pipe(Effect.map(({ playQueue: queue }) => queue
        ? this.toSavedQueue(queue, queue.current === undefined ? 0 : (queue.entry ?? []).findIndex(song => song.id === String(queue.current)))
        : null)),
    ), Effect.catchIf(error => error instanceof ServerError && error.code === 70, () => Effect.succeed(null)));
  }
  // An empty list clears the saved queue. indexBasedQueue keeps duplicate songs distinct.
  saveQueue(trackIds: readonly string[], currentIndex: number, positionSeconds: number) {
    if (trackIds.length > 1000) return Effect.fail(new ServerError('The queue is too long to save. Queues of up to 1,000 songs are saved.'));
    const index = clamp(currentIndex, 0, Math.max(0, trackIds.length - 1));
    const position = String(Math.round(Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) * 1000 : 0));
    return this.supports('indexBasedQueue').pipe(Effect.flatMap(byIndex => this.request(byIndex ? 'savePlayQueueByIndex' : 'savePlayQueue', StatusSchema, !trackIds.length ? {}
      : byIndex ? { id: trackIds, currentIndex: String(index), position } : { id: trackIds, current: trackIds[index], position })), Effect.asVoid);
  }
  coverArt(id: string, size: number) {
    return this.supports('formPost').pipe(Effect.flatMap(formPost => this.transfer('getCoverArt', { id, size: String(clamp(size, 32, 1200)) }, formPost, true, 6, response => {
      // Failures arrive as a JSON envelope with HTTP 200. Its text is never forwarded.
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
      if (!coverTypes.has(contentType)) throw new ServerError('Cover art is not available.');
      return contentType;
    }, (body, contentType) => ({ contentType, bytes: body }))));
  }
  // The authenticated getCoverArt address without id and size, for the Android app's native
  // cover proxy, which adds both. Like streamLocation, it must stay out of the page's components.
  coverArtBase() {
    const location = this.endpointUrl('getCoverArt');
    location.search = this.params().toString();
    return location.href;
  }
  // Requests the original stream, but the UI does not claim the server honored it.
  // The location carries credentials and must stay inside the desktop and audio processes.
  // Browsers that cannot decode the original (ALAC, some DSD) ask for a 320 kbps MP3 instead.
  streamLocation(id: string, format: 'raw' | 'mp3' = 'raw') {
    const location = this.endpointUrl('stream');
    location.search = this.params(format === 'raw' ? { id, format } : { id, format, maxBitRate: '320' }).toString();
    return location.href;
  }
  playable(track: Track): PlayableTrack { return { track, location: this.streamLocation(track.id) }; }
}

// The address to sign in at: as typed, or, typed without a scheme, the first of HTTPS and HTTP
// where a server answers. That's asked without credentials, so the password only goes to an
// address that answered, and a failed HTTPS attempt never sends it over plain HTTP.
export function resolveServerAddress(connection: Connection, client: (connection: Connection) => SubsonicClient): Effect.Effect<Connection, Error> {
  const candidates = serverUrlCandidates(connection.url);
  if (candidates.length === 1) return Effect.succeed(connection);
  return Effect.gen(function* () {
    for (const url of candidates) {
      const attempt = yield* Effect.either(Effect.try(() => client({ ...connection, url })).pipe(Effect.flatMap(candidate => candidate.probe())));
      if (Either.isRight(attempt)) return { ...connection, url };
    }
    return yield* Effect.fail(new Error(`No Navidrome server answered at ${connection.url.trim()} over HTTPS or HTTP. Check the address and your connection.`));
  });
}

export type LibraryMethod = Exclude<keyof LibraryApi, 'coverUrl'>;
type LibraryValue<K extends LibraryMethod> = Awaited<ReturnType<LibraryApi[K]>> extends Result<infer T> ? T : never;
interface LibraryEntry<A, R> {
  schema: Schema.Schema<A, any>;
  run(client: SubsonicClient, args: A): Effect.Effect<R, Error>;
  tracks(value: R): readonly Track[];
}
const entry = <A, I, R>(schema: Schema.Schema<A, I>, run: (client: SubsonicClient, args: A) => Effect.Effect<R, Error>, tracks: (value: R) => readonly Track[] = () => []): LibraryEntry<A, R> => ({ schema, run, tracks });
const library = {
  albums: entry(LibraryRequestSchemas.albums, (client, [type, offset, size]) => client.albumList(type, offset, size)),
  album: entry(LibraryRequestSchemas.album, (client, [id]) => client.album(id), value => value.tracks),
  artists: entry(LibraryRequestSchemas.artists, client => client.artists()),
  artist: entry(LibraryRequestSchemas.artist, (client, [id]) => client.artist(id)),
  playlists: entry(LibraryRequestSchemas.playlists, client => client.playlists()),
  playlist: entry(LibraryRequestSchemas.playlist, (client, [id]) => client.playlist(id), value => value.tracks),
  genres: entry(LibraryRequestSchemas.genres, client => client.genres()),
  starred: entry(LibraryRequestSchemas.starred, client => client.starred(), value => value.tracks),
  randomSongs: entry(LibraryRequestSchemas.randomSongs, (client, [options]) => client.randomSongs(options), value => value),
  tracks: entry(LibraryRequestSchemas.tracks, (client, [sort, offset, size, seed]) => client.tracks(sort, offset, size, seed), value => value.tracks),
  search: entry(LibraryRequestSchemas.search, (client, [query]) => client.search(query), value => value.tracks),
  star: entry(LibraryRequestSchemas.star, (client, [target, id, starred]) => client.star(target, id, starred)),
  createPlaylist: entry(LibraryRequestSchemas.createPlaylist, (client, [name, trackIds]) => client.createPlaylist(name, trackIds)),
  addToPlaylist: entry(LibraryRequestSchemas.addToPlaylist, (client, [playlistId, trackIds]) => client.addToPlaylist(playlistId, trackIds)),
  updatePlaylist: entry(LibraryRequestSchemas.updatePlaylist, (client, [playlistId, changes]) => client.updatePlaylist(playlistId, changes)),
  removeFromPlaylist: entry(LibraryRequestSchemas.removeFromPlaylist, (client, [playlistId, indexes]) => client.removeFromPlaylist(playlistId, indexes)),
  reorderPlaylist: entry(LibraryRequestSchemas.reorderPlaylist, (client, [playlistId, trackIds]) => client.reorderPlaylist(playlistId, trackIds)),
  deletePlaylist: entry(LibraryRequestSchemas.deletePlaylist, (client, [playlistId]) => client.deletePlaylist(playlistId)),
  similarSongs: entry(LibraryRequestSchemas.similarSongs, (client, [id, count]) => client.similarSongs(id, count), value => value),
  topSongs: entry(LibraryRequestSchemas.topSongs, (client, [artistId, count]) => client.topSongs(artistId, count), value => value),
  lyrics: entry(LibraryRequestSchemas.lyrics, (client, [query, lookup]) => client.lyrics(query, lookup)),
  reportPlay: entry(LibraryRequestSchemas.reportPlay, (client, [trackId, event]) => client.reportPlay(trackId, event)),
  savedQueue: entry(LibraryRequestSchemas.savedQueue, client => client.savedQueue(), value => value?.tracks ?? []),
  saveQueue: entry(LibraryRequestSchemas.saveQueue, (client, [trackIds, currentIndex, position]) => client.saveQueue(trackIds, currentIndex, position)),
  rate: entry(LibraryRequestSchemas.rate, (client, [, id, rating]) => client.setRating(id, rating)),
} satisfies { [K in LibraryMethod]: LibraryEntry<any, LibraryValue<K>> };
export const libraryMethods = Object.keys(library) as LibraryMethod[];
export const isLibraryMethod = (method: string): method is LibraryMethod => Object.hasOwn(library, method);

// Decodes positional LibraryApi arguments from an untrusted caller and runs the matching
// connector request. `tracks` lists every track in the value, for callers that queue by ID.
export function libraryCall(client: SubsonicClient, method: LibraryMethod, args: unknown): Effect.Effect<{ value: unknown; tracks: readonly Track[] }, Error> {
  const { schema, run, tracks } = library[method] as LibraryEntry<unknown, unknown>;
  return Schema.decodeUnknown(schema)(args).pipe(
    Effect.mapError(() => new Error('Invalid library request.')),
    Effect.flatMap(decoded => run(client, decoded)),
    Effect.map(value => ({ value, tracks: tracks(value) })),
  );
}
