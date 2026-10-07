import { Either, Schema } from 'effect';
import type { Settings } from './contracts';
import { DeviceSchema, IdSchema, QUEUE_LIMIT, QueuedPlaysSchema } from './validation';
import { DEFAULT_KEPT_LIMIT_MB, KEPT_LIMIT_MB, KEPT_LIMITS } from './kept';
import { PLAY_COUNTS_AT } from './plays';

// Desktop-only request and file schemas: queue editing, radio, settings, and window state.
// Main-process only; keep out of renderer imports like validation.ts.
export { QUEUE_LIMIT };
const IndexSchema = Schema.Number.pipe(Schema.int(), Schema.between(0, QUEUE_LIMIT - 1));
// Where: next, the end, or before the entry at an index (a drop onto the queue).
export const QueueAddSchema = Schema.Tuple(Schema.Array(IdSchema).pipe(Schema.minItems(1), Schema.maxItems(QUEUE_LIMIT)), Schema.Union(Schema.Literal('next', 'end'), IndexSchema));
// Files dropped on the window: paths the preload looked up, which the main process checks
// again (checkAudioPaths in main/localFiles.ts), and whether they play now or join the end of
// the queue. '' is a dropped File with no path on disk; it is counted as left out.
const PathSchema = Schema.String.pipe(Schema.maxLength(4096));
export const OpenPathsSchema = Schema.Tuple(Schema.Array(PathSchema).pipe(Schema.minItems(1), Schema.maxItems(QUEUE_LIMIT)), Schema.Literal('play', 'queue'));
export const QueueMoveSchema = Schema.Tuple(IndexSchema, IndexSchema);
export const QueueRemoveSchema = Schema.Tuple(Schema.Array(IndexSchema).pipe(Schema.minItems(1), Schema.maxItems(QUEUE_LIMIT)));
// An index into the latest snapshot and the entry id the renderer saw there.
export const QueueJumpSchema = Schema.Tuple(IndexSchema, IdSchema);
const LabelSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256));
export const RadioSeedSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('song'), trackId: IdSchema, label: LabelSchema }),
  Schema.Struct({ kind: Schema.Literal('album', 'artist'), id: IdSchema, label: LabelSchema }),
);

// How much room kept songs may take, in MB (1024 * 1024 bytes).
function KeptLimitSchema() { return Schema.Number.pipe(Schema.int(), Schema.between(KEPT_LIMIT_MB.min, KEPT_LIMIT_MB.max)); }
const PlayCountsAtSchema = Schema.Literal(...PLAY_COUNTS_AT);
// A stored file may predate a setting, so missing keys take their default. A wrong type rejects the whole file.
const setting = (fallback: boolean) => Schema.optionalWith(Schema.Boolean, { default: () => fallback });
export const SettingsFileSchema = Schema.Struct({
  // Stock GNOME hides tray icons, so closing to the tray would strand the app there. Off on Linux.
  lyricsLookup: setting(false), exclusiveOutput: setting(false), closeToTray: setting(process.platform !== 'linux'), syncQueue: setting(true), reportPlays: setting(true),
  miniOnTop: setting(true),
  playCountsAt: Schema.optionalWith(PlayCountsAtSchema, { default: () => 50 as const }),
  outputDevice: Schema.optionalWith(DeviceSchema, { default: () => 'auto' }),
  checkForUpdates: setting(true),
  keptLimitMb: Schema.optionalWith(KeptLimitSchema(), { default: () => DEFAULT_KEPT_LIMIT_MB }),
  // Only betas with remote diagnostics built in read it; everywhere else it does nothing.
  diagnostics: setting(true),
});
export const defaultSettings = (): Settings => Schema.decodeUnknownSync(SettingsFileSchema)({});
// Renderer changes: known keys only, never undefined. Decode with onExcessProperty: 'error'.
export const SettingsPatchSchema = Schema.partialWith(Schema.Struct({
  lyricsLookup: Schema.Boolean, exclusiveOutput: Schema.Boolean, closeToTray: Schema.Boolean, syncQueue: Schema.Boolean, reportPlays: Schema.Boolean,
  miniOnTop: Schema.Boolean, playCountsAt: PlayCountsAtSchema, outputDevice: DeviceSchema, checkForUpdates: Schema.Boolean,
  keptLimitMb: KeptLimitSchema(), diagnostics: Schema.Boolean,
}), { exact: true });

const CoordinateSchema = Schema.Number.pipe(Schema.int(), Schema.between(-100_000, 100_000));
const SizeSchema = Schema.Number.pipe(Schema.int(), Schema.between(1, 100_000));
// The mini player's pin preference lives in Settings (miniOnTop). Older files also carry an
// alwaysOnTop key; decoding ignores it.
export const WindowStateSchema = Schema.Struct({
  mini: Schema.optional(Schema.Struct({ x: CoordinateSchema, y: CoordinateSchema, width: SizeSchema, height: SizeSchema })),
});
export type WindowState = Schema.Schema.Type<typeof WindowStateSchema>;

// Repeat and shuffle (play-modes.json), set by player commands rather than Settings, and handed to
// the audio host when it starts. Missing keys take their default, as in settings.
export const PlayModesSchema = Schema.Struct({
  repeat: Schema.optionalWith(Schema.Literal('off', 'all', 'one'), { default: () => 'off' as const }),
  shuffle: setting(false),
});
export type PlayModes = Schema.Schema.Type<typeof PlayModesSchema>;
export const defaultPlayModes = (): PlayModes => Schema.decodeUnknownSync(PlayModesSchema)({});

// What the sound server says about its sinks (main/sinks.ts). Each object of `pw-dump`'s array
// decodes on its own, so one odd object doesn't spoil the dump. Only the fields the sink line
// reads are declared; everything else (media.name holds the playing file's name) is dropped.
const ObjectIdSchema = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const RateSchema = Schema.Number.pipe(Schema.int(), Schema.between(1, 10_000_000));
const ChannelsSchema = Schema.Number.pipe(Schema.int(), Schema.between(1, 256));
const PidSchema = Schema.Number.pipe(Schema.int(), Schema.positive());
const NameSchema = Schema.String.pipe(Schema.maxLength(1024));
// A field of the wrong type reads as missing rather than rejecting its object.
const loose = <A, I>(schema: Schema.Schema<A, I>) => Schema.optional(Schema.Unknown.pipe(
  Schema.transform(Schema.UndefinedOr(Schema.typeSchema(schema)), {
    strict: false, decode: value => Either.getOrUndefined(Schema.decodeUnknownEither(schema)(value)), encode: value => value,
  }),
));
export const PwNodeSchema = Schema.Struct({
  id: ObjectIdSchema,
  type: Schema.Literal('PipeWire:Interface:Node'),
  info: Schema.Struct({
    props: Schema.Struct({
      'media.class': loose(NameSchema), 'node.name': loose(NameSchema), 'node.description': loose(NameSchema),
      'client.id': loose(ObjectIdSchema), 'application.process.id': loose(PidSchema),
    }),
    // The format the node runs at now: one entry of plain values, or none while suspended.
    // (EnumFormat, which lists what it could run at, uses objects and is not read.)
    params: loose(Schema.Struct({
      Format: loose(Schema.Array(Schema.Struct({ format: loose(NameSchema), rate: loose(RateSchema), channels: loose(ChannelsSchema) }))),
    })),
  }),
});
export const PwLinkSchema = Schema.Struct({
  id: ObjectIdSchema,
  type: Schema.Literal('PipeWire:Interface:Link'),
  info: Schema.Struct({ 'output-node-id': ObjectIdSchema, 'input-node-id': ObjectIdSchema }),
});
export const PwClientSchema = Schema.Struct({
  id: ObjectIdSchema,
  type: Schema.Literal('PipeWire:Interface:Client'),
  info: Schema.Struct({ props: Schema.Struct({ 'application.process.id': loose(PidSchema) }) }),
});
export const PwMetadataSchema = Schema.Struct({
  type: Schema.Literal('PipeWire:Interface:Metadata'),
  props: Schema.Struct({ 'metadata.name': loose(NameSchema) }),
  metadata: loose(Schema.Array(Schema.Struct({ key: loose(NameSchema), value: Schema.Unknown }))),
});
// A metadata value naming a node: `{ "name": ... }`, or the same as JSON text.
export const PwTargetSchema = Schema.Union(Schema.Struct({ name: NameSchema }), Schema.parseJson(Schema.Struct({ name: NameSchema })));
// `pactl -f json` (PulseAudio 16 or newer, and pipewire-pulse). Its lists decode one entry at a time too.
export const PactlSinkSchema = Schema.Struct({
  index: ObjectIdSchema, name: NameSchema, description: loose(NameSchema), driver: loose(NameSchema),
  sample_specification: loose(NameSchema),
});
// PulseAudio gives a sink-input's process id as text.
export const PactlSinkInputSchema = Schema.Struct({
  index: ObjectIdSchema, sink: ObjectIdSchema,
  properties: loose(Schema.Struct({ 'application.process.id': loose(NameSchema) })),
});
export const PactlInfoSchema = Schema.Struct({ default_sink_name: loose(NameSchema) });
// Keep on this device: a record, playlist, or mix's draw, by track ids the main process has
// returned (it looks the tracks up itself, as play-tracks does). Duplicates are dropped, in order.
export const KeepRequestSchema = Schema.Struct({
  kind: Schema.Literal('album', 'playlist', 'mix'), id: IdSchema,
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(KEPT_LIMITS.nameChars)),
  artist: Schema.NullOr(Schema.String.pipe(Schema.maxLength(KEPT_LIMITS.nameChars))),
  coverArt: Schema.NullOr(IdSchema),
  trackIds: Schema.Array(IdSchema).pipe(Schema.minItems(1), Schema.maxItems(KEPT_LIMITS.tracksPerContainer)),
}).pipe(Schema.transform(Schema.Struct({
  kind: Schema.Literal('album', 'playlist', 'mix'), id: Schema.String, name: Schema.String, artist: Schema.NullOr(Schema.String),
  coverArt: Schema.NullOr(Schema.String), trackIds: Schema.Array(Schema.String),
}), { strict: true, decode: request => ({ ...request, trackIds: [...new Set(request.trackIds)] }), encode: request => request }));
export type KeepRequestIds = Schema.Schema.Type<typeof KeepRequestSchema>;
export const KeptIdSchema = Schema.Tuple(Schema.Literal('album', 'playlist', 'mix'), IdSchema);
export const PlaysFileSchema = QueuedPlaysSchema;
