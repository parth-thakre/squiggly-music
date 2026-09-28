import { Effect, Schema } from 'effect';
import type { Lyrics, LyricsQuery } from '../core/contracts';
import { attachSpaces, type LyricLines, lineSpan, round, timeWords, weightOf } from './words';

export type { LyricLines };
const seconds = (minutes: string, whole: string, fraction: string | undefined) => Number(minutes) * 60 + Number(whole) + (fraction ? Number(`0.${fraction}`) : 0);
type Timed = { start: number; text: string; words: { start: number; end: number | null; text: string }[] | null };

// LRC text: `[mm:ss.xx]` or `[mm:ss.xxx]` stamps (several may share one line), `[ar:...]`-style
// metadata, `<mm:ss.xx>` word stamps from enhanced LRC (A2), and an optional `[offset:+/-ms]`
// where a positive offset shows lyrics sooner. Text without any stamp is returned as unsynced
// lines. Word stamps become the line's words; the text shown has them removed.
const stampPattern = /^\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const wordPattern = /<(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const tagPattern = /^\[([a-zA-Z#]+):([^\]]*)\]\s*$/;
export function parseLrc(text: string): LyricLines | null {
  const timed: Timed[] = [];
  const plain: string[] = [];
  let offsetMs = 0;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.trim();
    const starts: number[] = [];
    for (let match = stampPattern.exec(line); match; match = stampPattern.exec(line)) {
      starts.push(seconds(match[1], match[2], match[3]));
      line = line.slice(match[0].length).trimStart();
    }
    if (starts.length) {
      const { text, words } = wordStamps(line);
      // Word stamps are absolute; when one line is stamped several times, they belong to the
      // stamp nearest the first word and move with the others.
      const first = words?.find(word => word.start !== null)?.start ?? null;
      const reference = first === null ? starts[0] : starts.reduce((a, b) => Math.abs(b - first) < Math.abs(a - first) ? b : a);
      for (const start of starts) timed.push({ start, text, words: words && words.map(word => ({
        text: word.text, start: (word.start ?? reference) + start - reference, end: word.end === null ? null : word.end + start - reference,
      })) });
      continue;
    }
    const tag = tagPattern.exec(line);
    if (tag) {
      if (tag[1].toLowerCase() === 'offset' && /^\s*[+-]?\d{1,7}\s*$/.test(tag[2])) offsetMs = Number(tag[2].trim());
      continue;
    }
    plain.push(line);
  }
  if (timed.length) {
    if (!timed.some(line => line.text)) return null;
    const shift = (at: number) => round(at - offsetMs / 1000);
    // Stable sort keeps the file's order for lines that share a stamp.
    const sorted = timed.map(line => ({ ...line, start: shift(line.start) })).sort((a, b) => a.start - b.start);
    return { synced: true, lines: sorted.map((line, i) => {
      if (!line.words) return { start: line.start, text: line.text };
      // A last word without a closing stamp ends by estimate, before the next line.
      const next = sorted.slice(i + 1).find(other => other.start > line.start)?.start ?? null;
      const words = line.words.map(word => {
        const start = shift(word.start);
        const end = word.end === null ? round(start + lineSpan(start, next, weightOf(word.text))) : Math.max(start, shift(word.end));
        return { start, end, text: word.text };
      });
      return { start: line.start, text: line.text, words };
    }) };
  }
  // Keep single blank lines between stanzas; drop leading, trailing and repeated blanks.
  const lines = plain.filter((line, index) => line || (index > 0 && plain[index - 1] !== '')).map(text => ({ start: null, text }));
  while (lines.length && !lines[lines.length - 1].text) lines.pop();
  while (lines.length && !lines[0].text) lines.shift();
  return lines.length ? { synced: false, lines } : null;
}

// Splits a line at its word stamps. Each stamp starts a word and ends the one before; text before
// the first stamp starts with the line (start null). Spaces are collapsed as in the plain text.
function wordStamps(line: string): { text: string; words: { start: number | null; end: number | null; text: string }[] | null } {
  const pieces: { start: number | null; end: number | null; text: string }[] = [];
  let from = 0, at: number | null = null;
  for (const match of line.matchAll(wordPattern)) {
    const time = seconds(match[1], match[2], match[3]);
    pieces.push({ start: at, end: time, text: line.slice(from, match.index) });
    at = time; from = match.index + match[0].length;
  }
  pieces.push({ start: at, end: null, text: line.slice(from) });
  const text = pieces.map(piece => piece.text).join('').replace(/\s+/g, ' ').trim();
  if (pieces.length === 1 || !text) return { text, words: null };
  for (const piece of pieces) piece.text = piece.text.replace(/\s+/g, ' ');
  const words = attachSpaces(pieces);
  if (!words.length) return { text, words: null };
  words[0].text = words[0].text.trimStart();
  words[words.length - 1].text = words[words.length - 1].text.trimEnd();
  return { text, words: words.map(word => ({ ...word, text: word.text.replace(/\s+/g, ' ') })).filter(word => word.text) };
}

// LRCLIB (https://lrclib.net) is a third-party service. Callers must only reach it when the
// listener has allowed lookups. Nothing about the listener's server or account is sent.
const LyricTextSchema = Schema.NullOr(Schema.String.pipe(Schema.maxLength(200_000)));
const RecordSchema = Schema.Struct({
  trackName: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(1024)))),
  duration: Schema.optional(Schema.NullOr(Schema.Number.pipe(Schema.finite(), Schema.nonNegative()))),
  instrumental: Schema.optional(Schema.Boolean),
  plainLyrics: Schema.optional(LyricTextSchema), syncedLyrics: Schema.optional(LyricTextSchema),
});
const SearchSchema = Schema.Array(RecordSchema).pipe(Schema.maxItems(100));
type LrclibRecord = Schema.Schema.Type<typeof RecordSchema>;
export const lrclibUserAgent = 'Squiggly Music (https://github.com/parth-thakre)';
export interface LrclibOptions { baseUrl?: string; fetch?: typeof globalThis.fetch }
class LookupError extends Error {}
const failed = 'Lyrics lookup failed. Try again later.';

function fromRecord(record: LrclibRecord): Lyrics | null {
  if (record.instrumental) return null;
  const parsed = (record.syncedLyrics && parseLrc(record.syncedLyrics)) || (record.plainLyrics && parseLrc(record.plainLyrics)) || null;
  return parsed && { ...timeWords(parsed), source: 'lrclib' };
}
const normalize = (text: string | null | undefined) => (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
// Search is fuzzy: accept only results within 3 seconds of a known duration, or with the same
// title when the duration is unknown. Synced lyrics win over plain ones.
function pickResult(query: LyricsQuery, records: readonly LrclibRecord[]): Lyrics | null {
  const matches = records.filter(record => !record.instrumental && (query.duration !== null
    ? record.duration != null && Math.abs(record.duration - query.duration) <= 3
    : normalize(record.trackName) === normalize(query.title)));
  const found = matches.map(fromRecord).filter(lyrics => lyrics !== null);
  return found.find(lyrics => lyrics.synced) ?? found[0] ?? null;
}

export function lrclibLyrics(query: LyricsQuery, options: LrclibOptions = {}): Effect.Effect<Lyrics | null, Error> {
  const base = (options.baseUrl ?? 'https://lrclib.net').replace(/\/+$/, '');
  const request = (path: string, params: Record<string, string>) => Effect.tryPromise({
    try: async signal => {
      const response = await (options.fetch ?? fetch)(`${base}/api/${path}?${new URLSearchParams(params)}`, {
        headers: { 'user-agent': lrclibUserAgent, accept: 'application/json' }, signal, redirect: 'error',
      });
      const reader = response.body?.getReader();
      try {
        if (response.status === 404) return null;
        if (!response.ok || !reader) throw new LookupError(failed);
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > 2 * 1024 * 1024) throw new LookupError('The lyrics service sent an unexpectedly large response.');
          chunks.push(value);
        }
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        return JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(body)) as unknown;
      } finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
    },
    // Service error text is never forwarded.
    catch: error => error instanceof LookupError ? error : new LookupError(failed),
  });
  const title = query.title.trim(), artist = query.artist.trim(), album = query.album.trim();
  if (!title || !artist) return Effect.succeed(null);
  const decode = <A, I>(schema: Schema.Schema<A, I>) => (body: unknown) => body === null ? Effect.succeed(null)
    : Schema.decodeUnknown(schema)(body).pipe(Effect.mapError(() => new LookupError(failed)));
  const search = request('search', { track_name: title, artist_name: artist, ...(album ? { album_name: album } : {}) }).pipe(
    Effect.flatMap(decode(SearchSchema)), Effect.map(records => records && pickResult(query, records)));
  // The exact-match endpoint needs all four fields; fall back to search when it has nothing.
  const task = query.duration === null || !album ? search
    : request('get', { track_name: title, artist_name: artist, album_name: album, duration: String(Math.round(query.duration)) }).pipe(
      Effect.flatMap(decode(RecordSchema)), Effect.flatMap(record => record === null ? search
        : Effect.succeed(fromRecord(record)).pipe(Effect.flatMap(found => found || record.instrumental ? Effect.succeed(found) : search))));
  return task.pipe(Effect.timeoutFail({ duration: '8 seconds', onTimeout: () => new LookupError('The lyrics service did not respond within 8 seconds.') }));
}
