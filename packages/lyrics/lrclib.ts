import { Effect, Schema } from 'effect';
import type { Lyrics, LyricsQuery } from '../core/contracts';

export type LyricLines = Pick<Lyrics, 'synced' | 'lines'>;
const round = (seconds: number) => Math.max(0, Math.round(seconds * 1000) / 1000);

// LRC text: `[mm:ss.xx]` or `[mm:ss.xxx]` stamps (several may share one line), `[ar:...]`-style
// metadata, `<mm:ss.xx>` word stamps from enhanced LRC, and an optional `[offset:+/-ms]` where a
// positive offset shows lyrics sooner. Text without any stamp is returned as unsynced lines.
const stampPattern = /^\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
const tagPattern = /^\[([a-zA-Z#]+):([^\]]*)\]\s*$/;
export function parseLrc(text: string): LyricLines | null {
  const timed: { start: number; text: string }[] = [];
  const plain: string[] = [];
  let offsetMs = 0;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.trim();
    const starts: number[] = [];
    for (let match = stampPattern.exec(line); match; match = stampPattern.exec(line)) {
      starts.push(Number(match[1]) * 60 + Number(match[2]) + (match[3] ? Number(`0.${match[3]}`) : 0));
      line = line.slice(match[0].length).trimStart();
    }
    if (starts.length) {
      const words = line.replace(/<\d{1,4}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim();
      for (const start of starts) timed.push({ start, text: words });
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
    // Stable sort keeps the file's order for lines that share a stamp.
    return { synced: true, lines: timed.map(line => ({ start: round(line.start - offsetMs / 1000), text: line.text })).sort((a, b) => a.start - b.start) };
  }
  // Keep single blank lines between stanzas; drop leading, trailing and repeated blanks.
  const lines = plain.filter((line, index) => line || (index > 0 && plain[index - 1] !== '')).map(text => ({ start: null, text }));
  while (lines.length && !lines[lines.length - 1].text) lines.pop();
  while (lines.length && !lines[0].text) lines.shift();
  return lines.length ? { synced: false, lines } : null;
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
  return parsed && { ...parsed, source: 'lrclib' };
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
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
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
