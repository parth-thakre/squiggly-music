import { Schema } from 'effect';

// Keep runtime schemas out of renderer imports. UI contracts are type-only.
export const IdSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256));
// One queue bound everywhere: play requests, edits, saved queues, and the audio host (player-mpv/queue.ts).
export const QUEUE_LIMIT = 1000;
const QueueIndexSchema = Schema.Number.pipe(Schema.int(), Schema.between(0, QUEUE_LIMIT - 1));
export const CommandSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal('play', 'pause', 'stop', 'next', 'previous', 'restart') }),
  Schema.Struct({
    type: Schema.Literal('seek'),
    seconds: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()),
    queueIndex: QueueIndexSchema,
    trackId: IdSchema,
    // The queue entry (PlayerSnapshot.entryIds) the gesture began on. Optional for older callers.
    entryId: Schema.optional(IdSchema),
  }),
  Schema.Struct({ type: Schema.Literal('volume'), percent: Schema.Number.pipe(Schema.finite(), Schema.between(0, 100)) }),
  Schema.Struct({ type: Schema.Literal('device'), id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024)) }),
  // Queue modes (PlayerSnapshot.repeat and .shuffle). Shuffle on reorders the songs after the current one.
  Schema.Struct({ type: Schema.Literal('repeat'), mode: Schema.Literal('off', 'all', 'one') }),
  Schema.Struct({ type: Schema.Literal('shuffle'), on: Schema.Boolean }),
);
export const ConnectionSchema = Schema.Struct({
  url: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048)),
  username: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  password: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
});

// Positional arguments for each LibraryApi method except coverUrl. The desktop IPC
// handlers and the browser preview server decode renderer input with these.
const IntSchema = (min: number, max: number) => Schema.Number.pipe(Schema.int(), Schema.between(min, max));
const TextSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256));
// Up to a full queue, so "save the queue as a playlist" works at the queue limit.
const TrackIdsSchema = Schema.Array(IdSchema).pipe(Schema.maxItems(QUEUE_LIMIT));
const PlaylistNameSchema = Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(256));
const LyricsTextSchema = Schema.String.pipe(Schema.maxLength(1024));
export const AlbumListTypeSchema = Schema.Literal('newest', 'recent', 'frequent', 'highest', 'random', 'starred', 'alphabeticalByName', 'alphabeticalByArtist', 'byYear');
export const LibraryRequestSchemas = {
  // byYear, and only byYear, carries the years it covers.
  albums: Schema.Tuple(AlbumListTypeSchema, IntSchema(0, 1_000_000), IntSchema(1, 500), Schema.optionalElement(Schema.Struct({ fromYear: IntSchema(0, 9999), toYear: IntSchema(0, 9999) })))
    .pipe(Schema.filter(([type, , , years]) => (type === 'byYear') === (years !== undefined))),
  album: Schema.Tuple(IdSchema), artists: Schema.Tuple(), artist: Schema.Tuple(IdSchema),
  playlists: Schema.Tuple(), playlist: Schema.Tuple(IdSchema), genres: Schema.Tuple(), starred: Schema.Tuple(),
  randomSongs: Schema.Tuple(Schema.Struct({
    size: IntSchema(1, 500), genre: Schema.optional(TextSchema),
    fromYear: Schema.optional(IntSchema(0, 9999)), toYear: Schema.optional(IntSchema(0, 9999)),
  })),
  tracks: Schema.Tuple(Schema.Literal('newest', 'alphabeticalByName', 'alphabeticalByArtist', 'frequent', 'recent', 'random', 'highest'),
    IntSchema(0, 10_000_000), IntSchema(1, 500), Schema.String.pipe(Schema.maxLength(64))),
  // The options are optional, so a bare query still works. A count of 0 skips that kind.
  search: Schema.Tuple(Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(256)), Schema.optionalElement(Schema.Struct({
    artistCount: Schema.optional(IntSchema(0, 200)), artistOffset: Schema.optional(IntSchema(0, 1_000_000)),
    albumCount: Schema.optional(IntSchema(0, 200)), albumOffset: Schema.optional(IntSchema(0, 1_000_000)),
    songCount: Schema.optional(IntSchema(0, 200)), songOffset: Schema.optional(IntSchema(0, 1_000_000)),
  }))),
  star: Schema.Tuple(Schema.Literal('track', 'album', 'artist'), IdSchema, Schema.Boolean),
  createPlaylist: Schema.Tuple(PlaylistNameSchema, TrackIdsSchema),
  addToPlaylist: Schema.Tuple(IdSchema, TrackIdsSchema.pipe(Schema.minItems(1))),
  updatePlaylist: Schema.Tuple(IdSchema, Schema.Struct({ name: Schema.optional(PlaylistNameSchema), comment: Schema.optional(Schema.String.pipe(Schema.maxLength(4096))) })
    .pipe(Schema.filter(changes => changes.name !== undefined || changes.comment !== undefined))),
  // Indexes are positions in the playlist as last loaded, not track IDs.
  removeFromPlaylist: Schema.Tuple(IdSchema, Schema.Array(IntSchema(0, 4999)).pipe(Schema.minItems(1), Schema.maxItems(5000))),
  reorderPlaylist: Schema.Tuple(IdSchema, Schema.Array(IdSchema).pipe(Schema.maxItems(5000))),
  deletePlaylist: Schema.Tuple(IdSchema),
  similarSongs: Schema.Tuple(IdSchema, IntSchema(1, 200)),
  topSongs: Schema.Tuple(IdSchema, IntSchema(1, 200)),
  lyrics: Schema.Tuple(Schema.Struct({
    id: IdSchema, title: LyricsTextSchema, artist: LyricsTextSchema, album: LyricsTextSchema,
    duration: Schema.NullOr(Schema.Number.pipe(Schema.finite(), Schema.between(0, 86_400))),
  }), Schema.Boolean),
  reportPlay: Schema.Tuple(IdSchema, Schema.Literal('started', 'finished')),
  savedQueue: Schema.Tuple(),
  // An empty queue clears the saved one; otherwise currentIndex must point into it.
  saveQueue: Schema.Tuple(Schema.Array(IdSchema).pipe(Schema.maxItems(QUEUE_LIMIT)), QueueIndexSchema, Schema.Number.pipe(Schema.finite(), Schema.between(0, 604_800)))
    .pipe(Schema.filter(([trackIds, currentIndex]) => currentIndex < Math.max(1, trackIds.length))),
  // 0 clears the rating.
  rate: Schema.Tuple(Schema.Literal('track', 'album', 'artist'), IdSchema, Schema.Literal(0, 1, 2, 3, 4, 5)),
  artistInfo: Schema.Tuple(IdSchema),
  songsByGenre: Schema.Tuple(TextSchema, IntSchema(0, 10_000_000), IntSchema(1, 500)),
  nowPlaying: Schema.Tuple(),
  // Songs, a record, or a playlist. The description and expiry (epoch ms, up to the year 9999) are
  // null when not given, since JSON turns a missing array element into null.
  createShare: Schema.Tuple(Schema.Array(IdSchema).pipe(Schema.minItems(1), Schema.maxItems(QUEUE_LIMIT)),
    Schema.optionalElement(Schema.NullOr(Schema.String.pipe(Schema.maxLength(1024)))),
    Schema.optionalElement(Schema.NullOr(IntSchema(0, 253_402_300_799_999)))),
  shares: Schema.Tuple(),
  deleteShare: Schema.Tuple(IdSchema),
  radioStations: Schema.Tuple(),
};
// Track IDs must already be known to the main process; startIndex is checked against their count.
export const PlayTracksSchema = Schema.Tuple(Schema.Array(IdSchema).pipe(Schema.minItems(1), Schema.maxItems(QUEUE_LIMIT)), QueueIndexSchema);

// saveM3u, on the desktop and Android: a playlist file's name and songs, as the renderer describes
// them (m3u.ts). The desktop's main process fills in local files' paths itself and ignores the
// renderer's. Server paths come from the renderer as given; buildM3u writes only relative ones.
const M3uTextSchema = Schema.String.pipe(Schema.maxLength(1024));
export const SaveM3uSchema = Schema.Tuple(
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  Schema.Array(Schema.Struct({
    id: IdSchema, local: Schema.Boolean, title: M3uTextSchema, artist: M3uTextSchema, album: M3uTextSchema,
    duration: Schema.NullOr(Schema.Number.pipe(Schema.finite(), Schema.between(0, 604_800))),
    path: Schema.NullOr(Schema.String.pipe(Schema.maxLength(4096))), suffix: Schema.NullOr(Schema.String.pipe(Schema.maxLength(32))),
  })).pipe(Schema.maxItems(5000)),
);
// Finished plays waiting to be reported (packages/core/plays.ts): the desktop's plays.json and the
// Android page's localStorage. Bound to one account.
export const QueuedPlaysSchema = Schema.Struct({
  version: Schema.Literal(1),
  account: Schema.NullOr(Schema.String.pipe(Schema.maxLength(2048))),
  plays: Schema.Array(Schema.Struct({ trackId: IdSchema, at: IntSchema(0, 253_402_300_799_999) })).pipe(Schema.maxItems(500)),
});
