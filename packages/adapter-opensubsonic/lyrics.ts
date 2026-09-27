import { Option, Schema } from 'effect';
import type { LyricLine, LyricWord, Lyrics } from '../core/contracts';
import { attachSpaces, round, timeWords } from '../lyrics/words';

// OpenSubsonic songLyrics (getLyricsBySongId). Times and the offset are milliseconds; a positive
// offset shows lyrics sooner. Version 2 with enhanced=true adds, per entry, `cueLine[]`: word (or
// syllable) cues for each line, located by UTF-8 byte ranges, and `agents[]` when several voices
// sing. Cue data is checked separately, so a malformed cue never costs the listener the lines.
const Milliseconds = Schema.Number.pipe(Schema.finite(), Schema.nonNegative());
const Count = Milliseconds.pipe(Schema.int());
export const StructuredLyricsSchema = Schema.Struct({
  synced: Schema.Boolean, offset: Schema.optional(Schema.Number.pipe(Schema.finite())), kind: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Array(Schema.Struct({ start: Schema.optional(Milliseconds), value: Schema.String.pipe(Schema.maxLength(4096)) })).pipe(Schema.maxItems(5000))),
  cueLine: Schema.optional(Schema.Unknown), agents: Schema.optional(Schema.Unknown),
});
export const LyricsListSchema = Schema.Struct({ lyricsList: Schema.Struct({ structuredLyrics: Schema.optional(Schema.Array(StructuredLyricsSchema).pipe(Schema.maxItems(50))) }) });
type Entry = Schema.Schema.Type<typeof StructuredLyricsSchema>;

const CueSchema = Schema.Struct({
  start: Milliseconds, end: Schema.optional(Milliseconds), value: Schema.optional(Schema.String.pipe(Schema.maxLength(4096))),
  byteStart: Count, byteEnd: Count,
});
const CueLineSchema = Schema.Struct({
  index: Count, start: Schema.optional(Milliseconds), end: Schema.optional(Milliseconds),
  value: Schema.String.pipe(Schema.maxLength(4096)), agentId: Schema.optional(Schema.String.pipe(Schema.maxLength(256))),
  cue: Schema.optional(Schema.Array(CueSchema).pipe(Schema.maxItems(500))),
});
const CueLinesSchema = Schema.Array(CueLineSchema).pipe(Schema.maxItems(20_000));
const AgentsSchema = Schema.Array(Schema.Struct({
  id: Schema.String.pipe(Schema.maxLength(256)), role: Schema.String.pipe(Schema.maxLength(64)),
})).pipe(Schema.maxItems(64));
export type CueLine = Schema.Schema.Type<typeof CueLineSchema>;
type Cue = Schema.Schema.Type<typeof CueSchema>;

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const continuation = (bytes: Uint8Array, at: number) => at < bytes.length && (bytes[at] & 0xc0) === 0x80;

// The substring each cue covers. byteStart and byteEnd are inclusive offsets into the UTF-8 bytes
// of the cue line's value. Servers that count differently are caught by the checks (a range that
// splits a character, runs past the end, or overlaps the one before); then, if the cue values
// appear in order in the text, those are used instead. Otherwise null.
export function cueRanges(value: string, cues: readonly Cue[]): { from: number; to: number }[] | null {
  const bytes = encoder.encode(value);
  const ranges: { from: number; to: number }[] = [];
  let after = 0, valid = true;
  for (const i of cues.map((_, i) => i).sort((a, b) => cues[a].byteStart - cues[b].byteStart)) {
    const { byteStart, byteEnd } = cues[i], end = byteEnd + 1;
    if (byteStart < after || byteEnd < byteStart || end > bytes.length || continuation(bytes, byteStart) || continuation(bytes, end)) { valid = false; break; }
    // Character offsets, so the text can be cut as a string.
    ranges[i] = { from: decoder.decode(bytes.subarray(0, byteStart)).length, to: decoder.decode(bytes.subarray(0, end)).length };
    after = end;
  }
  if (valid) return ranges;
  ranges.length = 0; after = 0;
  for (const cue of cues) {
    const at = cue.value ? value.indexOf(cue.value, after) : -1;
    if (at < 0) return null;
    ranges.push({ from: at, to: at + cue.value!.length });
    after = at + cue.value!.length;
  }
  return ranges;
}

// The words of one line from its cue line. `text` is the line as shown (line[index].value): when a
// main voice's cue line is only part of it, the rest is added as words that light whole at the
// edges of the sung part. Joined, the words spell `text`. Null when the cues can't be placed.
export function cueWords(text: string, cueLine: CueLine, offsetMs: number): LyricWord[] | null {
  const cues = cueLine.cue ?? [];
  if (!cues.length) return null;
  const ranges = cueRanges(cueLine.value, cues);
  if (!ranges) return null;
  const order = cues.map((cue, i) => ({ cue, range: ranges[i] })).sort((a, b) => a.range.from - b.range.from);
  const at = (ms: number) => round((ms - offsetMs) / 1000);
  const lineEnd = cueLine.end;
  const pieces: { start: number; end: number; text: string }[] = [];
  let cursor = 0;
  order.forEach(({ cue, range }, i) => {
    // Untimed text between cues rides with the word before it.
    const gap = cueLine.value.slice(cursor, range.from);
    if (gap && pieces.length) pieces[pieces.length - 1].text += gap;
    const start = at(cue.start);
    // Without an end, a cue lasts until the next one starts, and the last until its line ends.
    const nextStart = order[i + 1]?.cue.start ?? lineEnd;
    const end = cue.end !== undefined ? at(cue.end) : nextStart !== undefined ? at(nextStart) : start;
    pieces.push({ start, end: Math.max(start, end), text: (pieces.length ? '' : gap) + cueLine.value.slice(range.from, range.to) });
    cursor = range.to;
  });
  pieces[pieces.length - 1].text += cueLine.value.slice(cursor);
  const sung = cueLine.value.trim();
  const where = text.indexOf(sung);
  if (!sung || where < 0) return null;
  // Trim the cue line to what `text` contains, then add what's around it.
  pieces[0].text = pieces[0].text.trimStart();
  pieces[pieces.length - 1].text = pieces[pieces.length - 1].text.trimEnd();
  const before = text.slice(0, where), after = text.slice(where + sung.length);
  const first = pieces[0], last = pieces[pieces.length - 1];
  const words = attachSpaces([
    ...(before ? [{ start: first.start, end: first.start, text: before }] : []),
    ...pieces,
    ...(after ? [{ start: last.end, end: last.end, text: after }] : []),
  ]);
  return words.length && words.map(word => word.text).join('') === text ? words : null;
}

// Main-voice cue lines by the line they belong to. With agents, only the main agent's; without
// agents, cue lines carry no agent. Anything that doesn't follow those rules gives no cues.
function mainCueLines(entry: Entry): Map<number, CueLine> {
  const found = new Map<number, CueLine>();
  const cueLines = Option.getOrNull(Schema.decodeUnknownOption(CueLinesSchema)(entry.cueLine ?? []));
  if (!cueLines?.length) return found;
  let main: string | undefined;
  if (entry.agents !== undefined) {
    const agents = Option.getOrNull(Schema.decodeUnknownOption(AgentsSchema)(entry.agents));
    const mains = agents?.filter(agent => agent.role === 'main') ?? [];
    if (mains.length !== 1) return found;
    main = mains[0].id;
  }
  for (const cueLine of cueLines) if (cueLine.agentId === main && !found.has(cueLine.index)) found.set(cueLine.index, cueLine);
  return found;
}

function fromEntry(entry: Entry): Lyrics {
  const lines = entry.line ?? [];
  const synced = entry.synced && lines.every(line => line.start !== undefined);
  const offset = entry.offset ?? 0;
  if (!synced) return { ...timeWords({ synced: false, lines: lines.map(line => ({ start: null, text: line.value.trim() })) }), source: 'server' };
  const cues = mainCueLines(entry);
  const timed = lines.map((line, index): LyricLine => {
    const text = line.value.trim();
    const start = Math.max(0, Math.round((line.start ?? 0) - offset) / 1000);
    const cueLine = cues.get(index);
    if (!cueLine || !text) return { start, text };
    const words = cueWords(text, cueLine, offset);
    // Cues that can't be placed still say when the line ends.
    const end = cueLine.end !== undefined ? Math.max(start, round((cueLine.end - offset) / 1000)) : null;
    return words ? { start, end: end ?? Math.max(...words.map(word => word.end)), text, words } : { start, end, text };
  }).sort((a, b) => a.start! - b.start!);
  return { ...timeWords({ synced: true, lines: timed }), source: 'server' };
}

// Picks the main synced layer when there is one, otherwise the fullest unsynced layer.
// Translations and pronunciations (enhanced responses only) are left out.
export function structuredLyrics(entries: readonly Entry[]): Lyrics | null {
  const candidates = entries.filter(entry => !entry.kind || entry.kind === 'main').map(fromEntry)
    .filter(lyrics => lyrics.lines.some(line => line.text));
  return candidates.sort((a, b) => Number(b.synced) - Number(a.synced) || b.lines.length - a.lines.length)[0] ?? null;
}
