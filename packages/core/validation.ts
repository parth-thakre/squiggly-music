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
  Schema.Struct({ type: Schema.Literal('select'), id: IdSchema }),
  Schema.Struct({ type: Schema.Literal('device'), id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024)) }),
);
export const ConnectionSchema = Schema.Struct({
  url: Schema.String.pipe(Schema.maxLength(2048)),
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
export const AlbumListTypeSchema = Schema.Literal('newest', 'recent', 'frequent', 'highest', 'random', 'starred', 'alphabeticalByName', 'alphabeticalByArtist');
export const LibraryRequestSchemas = {
  albums: Schema.Tuple(AlbumListTypeSchema, IntSchema(0, 1_000_000), IntSchema(1, 500)),
  album: Schema.Tuple(IdSchema), artists: Schema.Tuple(), artist: Schema.Tuple(IdSchema),
  playlists: Schema.Tuple(), playlist: Schema.Tuple(IdSchema), genres: Schema.Tuple(), starred: Schema.Tuple(),
  randomSongs: Schema.Tuple(Schema.Struct({
    size: IntSchema(1, 500), genre: Schema.optional(TextSchema),
    fromYear: Schema.optional(IntSchema(0, 9999)), toYear: Schema.optional(IntSchema(0, 9999)),
  })),
  search: Schema.Tuple(Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(256))),
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
};
// Track IDs must already be known to the main process; startIndex is checked against their count.
export const PlayTracksSchema = Schema.Tuple(Schema.Array(IdSchema).pipe(Schema.minItems(1), Schema.maxItems(QUEUE_LIMIT)), QueueIndexSchema);
