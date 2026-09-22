import { createHash, randomBytes } from 'node:crypto';
import { Effect, Schema } from 'effect';
import type { Album, Connection, Track } from '../core/contracts';
import type { PlayableTrack } from '../player-mpv/protocol';
import { Metrics } from '../core/metrics';

const SongSchema = Schema.Struct({
  id: Schema.String, title: Schema.String,
  artist: Schema.optional(Schema.String), album: Schema.optional(Schema.String),
  duration: Schema.optional(Schema.Number), suffix: Schema.optional(Schema.String),
  samplingRate: Schema.optional(Schema.Number), bitDepth: Schema.optional(Schema.Number),
});
const AlbumSchema = Schema.Struct({
  id: Schema.String, name: Schema.String, artist: Schema.optional(Schema.String),
  songCount: Schema.optional(Schema.Number), song: Schema.optional(Schema.Array(SongSchema)),
});
const ResponseSchema = Schema.Struct({ 'subsonic-response': Schema.Struct({
  status: Schema.String,
  error: Schema.optional(Schema.Struct({ code: Schema.Number })),
  albumList2: Schema.optional(Schema.Struct({ album: Schema.optional(Schema.Array(AlbumSchema)) })),
  album: Schema.optional(AlbumSchema),
}) });

export function normalizeServerUrl(input: string): string {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS server URL without embedded credentials, query parameters, or a fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export class SubsonicClient {
  readonly baseUrl: string;
  private auth: { username: string; salt: string; token: string };
  constructor(connection: Connection, private metrics: Metrics) {
    this.baseUrl = normalizeServerUrl(connection.url);
    const salt = randomBytes(16).toString('hex');
    this.auth = {
      username: connection.username, salt,
      // OpenSubsonic token authentication requires MD5(password + salt).
      token: createHash('md5').update(connection.password + salt).digest('hex'),
    };
  }
  private params(extra: Record<string, string> = {}) {
    return new URLSearchParams({
      u: this.auth.username, t: this.auth.token, s: this.auth.salt,
      v: '1.16.1', c: 'squiggly', f: 'json', ...extra,
    });
  }
  private request(endpoint: string, extra: Record<string, string> = {}) {
    const task = Effect.tryPromise({
      try: async signal => {
        const response = await fetch(`${this.baseUrl}/rest/${endpoint}.view`, {
          method: 'POST', body: this.params(extra), signal, redirect: 'error',
        });
        if (!response.ok) throw new Error(`Server returned HTTP ${response.status}.`);
        // Cap response sizes before parsing untrusted server JSON.
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Server returned an empty response.');
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Server response exceeded 8 MB.'); }
          chunks.push(value);
        }
        const decoded = Schema.decodeUnknownSync(ResponseSchema)(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const result = decoded['subsonic-response'];
        if (result.status !== 'ok') throw new Error(`Server rejected the request (code ${result.error?.code ?? 'unknown'}). Check your credentials and server permissions.`);
        return result;
      },
      // Never forward fetch errors containing authenticated URLs or server-provided text.
      catch: () => new Error('Server request failed. Check the address, credentials, connection, and OpenSubsonic compatibility.'),
    }).pipe(Effect.timeout('15 seconds'));
    return this.metrics.measure(`server.${endpoint}`, task);
  }
  ping() { return this.request('ping'); }
  albums(offset: number) {
    return this.request('getAlbumList2', { type: 'newest', size: '48', offset: String(offset) }).pipe(
      Effect.map(result => (result.albumList2?.album ?? []).map((album): Album => ({
        id: album.id, name: album.name, artist: album.artist ?? 'Unknown artist', songCount: album.songCount ?? 0,
      }))),
    );
  }
  albumQueue(id: string) {
    return this.request('getAlbum', { id }).pipe(Effect.map(result => {
      return (result.album?.song ?? []).map((song): PlayableTrack => {
        const track: Track = {
          id: song.id, title: song.title, artist: song.artist ?? 'Unknown artist', album: song.album ?? '',
          duration: song.duration ?? null, source: 'navidrome', sourceFormat: song.suffix ?? null,
          sourceSampleRate: song.samplingRate ?? null, sourceBitDepth: song.bitDepth ?? null,
        };
        // Requests the original stream, but the UI does not claim the server honored it.
        const location = `${this.baseUrl}/rest/stream.view?${this.params({ id: song.id, format: 'raw' })}`;
        return { track, location };
      });
    }));
  }
}
