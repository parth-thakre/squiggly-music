import { createHash, randomBytes } from 'node:crypto';
import { Effect, Schema } from 'effect';
import type { Album, Connection, Track } from '../core/contracts';
import type { PlayableTrack } from '../player-mpv/protocol';
import { Metrics } from '../core/metrics';
import { IdSchema } from '../core/validation';

const DurationSchema = Schema.Number.pipe(Schema.finite(), Schema.nonNegative());
const CountSchema = DurationSchema.pipe(Schema.int());
// OpenSubsonic fields may carry a default zero when the source value is unknown.
const ResolutionSchema = Schema.transform(Schema.NullOr(CountSchema), Schema.NullOr(CountSchema.pipe(Schema.positive())), {
  strict: true, decode: value => value === 0 ? null : value, encode: value => value,
});
const SongSchema = Schema.Struct({
  id: IdSchema, title: Schema.String,
  artist: Schema.optional(Schema.String), album: Schema.optional(Schema.String),
  duration: Schema.optional(DurationSchema), suffix: Schema.optional(Schema.String),
  samplingRate: Schema.optional(ResolutionSchema), bitDepth: Schema.optional(ResolutionSchema),
});
const AlbumSchema = Schema.Struct({
  id: IdSchema, name: Schema.String, artist: Schema.optional(Schema.String),
  songCount: Schema.optional(CountSchema), song: Schema.optional(Schema.Array(SongSchema).pipe(Schema.maxItems(500))),
});
const EnvelopeSchema = Schema.Struct({ 'subsonic-response': Schema.Unknown });
const StatusSchema = Schema.Struct({ status: Schema.Literal('ok', 'failed') });
const AlbumsSchema = Schema.Struct({
  albumList2: Schema.Struct({ album: Schema.optional(Schema.Array(AlbumSchema).pipe(Schema.maxItems(48))) }),
});
const AlbumResponseSchema = Schema.Struct({ album: AlbumSchema });
const ExtensionsSchema = Schema.Struct({ openSubsonicExtensions: Schema.Array(Schema.Struct({
  name: Schema.String, versions: Schema.Array(CountSchema),
})) });

export function normalizeServerUrl(input: string): string {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS server URL without embedded credentials, query parameters, or a fragment.');
  }
  url.search = ''; url.hash = '';
  return url.href.replace(/\/+$/, '');
}

export class SubsonicClient {
  readonly baseUrl: string;
  private auth: { username: string; salt: string; token: string };
  private supportsFormPost: Effect.Effect<boolean>;
  constructor(connection: Connection, private metrics: Metrics) {
    this.baseUrl = normalizeServerUrl(connection.url);
    const salt = randomBytes(16).toString('hex');
    this.auth = {
      username: connection.username, salt,
      // OpenSubsonic token authentication requires MD5(password + salt).
      token: createHash('md5').update(connection.password + salt).digest('hex'),
    };
    // Discovery is public and must use baseline GET before formPost is known.
    // Legacy servers may reject this endpoint; cache the safe GET fallback too.
    this.supportsFormPost = Effect.runSync(Effect.cached(
      this.exchange('getOpenSubsonicExtensions', ExtensionsSchema, {}, false, false).pipe(
        Effect.map(result => result.openSubsonicExtensions.some(extension => extension.name === 'formPost' && extension.versions.includes(1))),
        Effect.catchAll(() => Effect.succeed(false)),
      ),
    ));
  }
  private endpointUrl(endpoint: string) {
    const url = new URL(this.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/rest/${endpoint}.view`;
    return url;
  }
  private params(extra: Record<string, string> = {}) {
    return new URLSearchParams({
      u: this.auth.username, t: this.auth.token, s: this.auth.salt,
      v: '1.16.1', c: 'squiggly', f: 'json', ...extra,
    });
  }
  private exchange<A, I>(endpoint: string, schema: Schema.Schema<A, I>, extra: Record<string, string>, formPost: boolean, authenticated = true) {
    const task = Effect.tryPromise({
      try: async signal => {
        const url = this.endpointUrl(endpoint);
        const params = authenticated ? this.params(extra) : new URLSearchParams({ v: '1.16.1', c: 'squiggly', f: 'json' });
        if (!formPost) url.search = params.toString();
        const response = await fetch(url.href, {
          method: formPost ? 'POST' : 'GET', ...(formPost ? { body: params } : {}), signal, redirect: 'error',
        });
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          if (!response.ok) throw new Error(`Server returned HTTP ${response.status}.`);
          // Cap response sizes before parsing untrusted server JSON.
          reader = response.body?.getReader();
          if (!reader) throw new Error('Server returned an empty response.');
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > 8 * 1024 * 1024) throw new Error('Server response exceeded 8 MB.');
            chunks.push(value);
          }
          const result = Schema.decodeUnknownSync(EnvelopeSchema)(JSON.parse(Buffer.concat(chunks).toString('utf8')))['subsonic-response'];
          if (Schema.decodeUnknownSync(StatusSchema)(result).status !== 'ok') throw new Error('Server rejected the request.');
          return Schema.decodeUnknownSync(schema)(result);
        } finally {
          // Release the transfer on HTTP errors, size limits, read failures, and success.
          if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          else await response.body?.cancel().catch(() => {});
        }
      },
      // Never forward fetch errors containing authenticated URLs or server-provided text.
      catch: () => new Error('Server request failed. Check the address, credentials, connection, and OpenSubsonic compatibility.'),
    }).pipe(Effect.timeout('15 seconds'));
    return this.metrics.measure(`server.${endpoint}`, task);
  }
  private request<A, I>(endpoint: string, schema: Schema.Schema<A, I>, extra: Record<string, string> = {}) {
    return this.supportsFormPost.pipe(Effect.flatMap(formPost => this.exchange(endpoint, schema, extra, formPost)));
  }
  ping() { return this.request('ping', StatusSchema); }
  albums(offset: number) {
    return this.request('getAlbumList2', AlbumsSchema, { type: 'newest', size: '48', offset: String(offset) }).pipe(
      Effect.map(result => (result.albumList2.album ?? []).map((album): Album => ({
        id: album.id, name: album.name, artist: album.artist ?? 'Unknown artist', songCount: album.songCount ?? 0,
      }))),
    );
  }
  albumQueue(id: string) {
    return this.request('getAlbum', AlbumResponseSchema, { id }).pipe(Effect.map(result => {
      return (result.album.song ?? []).map((song): PlayableTrack => {
        const track: Track = {
          id: song.id, title: song.title, artist: song.artist ?? 'Unknown artist', album: song.album ?? '',
          duration: song.duration ?? null, source: 'navidrome', sourceFormat: song.suffix ?? null,
          sourceSampleRate: song.samplingRate ?? null, sourceBitDepth: song.bitDepth ?? null,
        };
        // Requests the original stream, but the UI does not claim the server honored it.
        const location = this.endpointUrl('stream');
        location.search = this.params({ id: song.id, format: 'raw' }).toString();
        return { track, location: location.href };
      });
    }));
  }
}
