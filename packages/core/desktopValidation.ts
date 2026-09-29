import { Schema } from 'effect';
import type { Settings } from './contracts';
import { IdSchema, QUEUE_LIMIT } from './validation';

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

// An mpv audio-device name, as listed by the engine.
const DeviceSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024));
// A stored file may predate a setting, so missing keys take their default. A wrong type rejects the whole file.
const setting = (fallback: boolean) => Schema.optionalWith(Schema.Boolean, { default: () => fallback });
export const SettingsFileSchema = Schema.Struct({
  // Stock GNOME hides tray icons, so closing to the tray would strand the app there. Off on Linux.
  lyricsLookup: setting(false), exclusiveOutput: setting(false), closeToTray: setting(process.platform !== 'linux'), syncQueue: setting(true), reportPlays: setting(true),
  miniOnTop: setting(true),
  outputDevice: Schema.optionalWith(DeviceSchema, { default: () => 'auto' }),
  checkForUpdates: setting(true),
});
export const defaultSettings = (): Settings => Schema.decodeUnknownSync(SettingsFileSchema)({});
// Renderer changes: known keys only, never undefined. Decode with onExcessProperty: 'error'.
export const SettingsPatchSchema = Schema.partialWith(Schema.Struct({
  lyricsLookup: Schema.Boolean, exclusiveOutput: Schema.Boolean, closeToTray: Schema.Boolean, syncQueue: Schema.Boolean, reportPlays: Schema.Boolean,
  miniOnTop: Schema.Boolean, outputDevice: DeviceSchema, checkForUpdates: Schema.Boolean,
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
