import { Schema } from 'effect';
import { IdSchema } from './validation';
import { KEPT_LIMITS } from './kept';

// The kept index (packages/core/kept.ts) as read from disk. Main process only; keep it out of the
// renderer and the audio host. The top level is checked whole, then each entry on its own, so
// one bad entry is dropped rather than losing everything kept.
const Text = (max: number) => Schema.String.pipe(Schema.maxLength(max));
const Count = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const When = Schema.Number.pipe(Schema.int(), Schema.between(0, 253_402_300_799_999));
export const KeptIndexShapeSchema = Schema.Struct({
  version: Schema.Literal(1),
  account: Schema.NullOr(Text(2048)),
  // Keys are checked entry by entry (IdSchema), so one bad key drops one entry.
  songs: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  containers: Schema.Array(Schema.Unknown).pipe(Schema.maxItems(KEPT_LIMITS.containers)),
  covers: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});
const Reference = Schema.NullOr(Text(256));
const Optional = <A, I>(schema: Schema.Schema<A, I>) => Schema.optional(schema);
// Track, as the connector makes it, with bounded strings. Only server songs are ever kept.
export const KeptTrackSchema = Schema.Struct({
  id: IdSchema, title: Text(4096), artist: Text(4096), album: Text(4096),
  duration: Schema.NullOr(Schema.Number.pipe(Schema.finite(), Schema.nonNegative())),
  source: Schema.Literal('navidrome'),
  sourceFormat: Schema.NullOr(Text(64)), sourceSampleRate: Schema.NullOr(Count), sourceBitDepth: Schema.NullOr(Count),
  albumId: Optional(Reference), artistId: Optional(Reference), coverArt: Optional(Reference),
  artists: Optional(Schema.Array(Schema.Struct({ id: Text(256), name: Text(4096) })).pipe(Schema.maxItems(50))),
  trackNumber: Optional(Schema.NullOr(Count)), discNumber: Optional(Schema.NullOr(Count)), year: Optional(Schema.NullOr(Count)),
  genre: Optional(Schema.NullOr(Text(1024))),
  path: Optional(Schema.NullOr(Text(4096))),
  size: Optional(Count),
});
const FileName = Text(64);
export const KeptSongSchema = Schema.Struct({ track: KeptTrackSchema, file: FileName, bytes: Count, keptAt: When });
export const KeptCoverSchema = Schema.Struct({
  file: FileName, bytes: Count, keptAt: When,
  type: Schema.Literal('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'),
});
export const KeptContainerSchema = Schema.Struct({
  kind: Schema.Literal('album', 'playlist', 'mix'), id: IdSchema, name: Text(KEPT_LIMITS.nameChars).pipe(Schema.minLength(1)),
  artist: Schema.NullOr(Text(KEPT_LIMITS.nameChars)), coverArt: Schema.NullOr(IdSchema),
  trackIds: Schema.Array(IdSchema).pipe(Schema.maxItems(KEPT_LIMITS.tracksPerContainer)), keptAt: When,
});
