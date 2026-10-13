// Songs streamed at a lower quality (Settings › Streaming quality) are MP3s Navidrome converts as
// it sends them, and a stream it's still converting can't be read from an offset (Accept-Ranges:
// none). libmpv could then seek only as far as it had downloaded; past that, the seek did nothing.
// The relay, on 127.0.0.1, gives libmpv each such stream as a constant-bitrate file it can read
// from any byte: a read from byte B asks Navidrome for the song from the second B stands for
// (timeOffset, which Navidrome hands ffmpeg as -ss) and sends that. libmpv's MP3 reader finds a
// second's byte the same way (fflags=+fastseek, native.ts), so the two agree to within a frame.
//
// A stream Navidrome serves with ranges itself passes through as it is: the original, when it's
// already an MP3 at or under the bitrate, or a conversion Navidrome has kept whole. One that is
// neither an MP3 nor ranged plays from its start, as without the relay.
//
// The addresses carry the account's credentials, so they stay in this process: libmpv is given
// http://127.0.0.1:<port>/<random token>, and nothing else is served.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// Songs remembered: more than a queue holds (QUEUE_LIMIT). The oldest go first.
const MAX_SONGS = 2_000;
// Navidrome refuses a conversion past its limit (429 or 503) without waiting. Right after a seek,
// the conversion the seek replaced may still hold its place for a moment.
const ATTEMPTS = 3;
const RETRY_MS = 1_000;
// How far into a stream its first MP3 frame may be: past an ID3v2 tag, which comes first.
const HEAD_BYTES = 64 * 1024;

type Shape =
  | { kind: 'ranges' }
  // `tag`: the ID3v2 tag the stream starts with, in bytes. `perSecond`: the frames' bitrate in bytes.
  | { kind: 'mp3'; tag: number; perSecond: number; length: number }
  | { kind: 'whole' };
interface Song { upstream: string; duration: number | null; shape?: Shape }

export interface StreamRelay {
  // The address libmpv plays for `upstream`, a Subsonic stream address with format=mp3.
  // `duration` is the library's, for a server that doesn't send X-Content-Duration.
  location(upstream: string, duration: number | null): string;
  // Forgets every song, as when the account signs out.
  forget(): void;
  close(): Promise<void>;
}

export async function startStreamRelay(fetchSong: typeof fetch = fetch): Promise<StreamRelay> {
  const songs = new Map<string, Song>();
  const server = createServer((request, response) => {
    serve(request, response).catch(() => { if (!response.headersSent) response.writeHead(502); response.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function open(song: Song, offset: number, signal: AbortSignal, range?: string) {
    const url = new URL(song.upstream);
    // A conversion's length, from its duration and bitrate, so libmpv knows it as a file.
    url.searchParams.set('estimateContentLength', 'true');
    if (offset > 0) url.searchParams.set('timeOffset', String(offset));
    for (let attempt = 1; ; attempt++) {
      const answer = await fetchSong(url, { signal, redirect: 'error', headers: range ? { range } : {} });
      if ((answer.status !== 429 && answer.status !== 503) || attempt === ATTEMPTS) return answer;
      await answer.body?.cancel().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, RETRY_MS));
    }
  }

  async function serve(request: IncomingMessage, response: ServerResponse) {
    // Only this relay's own name: a page in a browser can't reach it through another (DNS rebinding).
    const song = request.headers.host === host && (request.method === 'GET' || request.method === 'HEAD') ? songs.get(request.url?.slice(1) ?? '') : undefined;
    if (!song) { response.writeHead(404).end(); return; }
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    const range = request.headers.range;
    const start = Number(/^bytes=(\d+)-/.exec(range ?? '')?.[1] ?? 0);

    let first: Body | null = null;
    if (!song.shape) {
      const answer = await open(song, 0, abort.signal);
      if (!playable(answer)) { await answer.body?.cancel().catch(() => {}); response.writeHead(502).end(); return; }
      first = new Body(answer);
      song.shape = await shapeOf(answer, first, song.duration);
      if (song.shape.kind === 'ranges' && !range) return pass(answer, first, response, request.method === 'HEAD');
      // This answer runs from the start: kept when that's where the read starts.
      const fromStart = song.shape.kind === 'mp3' ? start < song.shape.tag : song.shape.kind === 'whole' && start === 0;
      if (!fromStart) { first.cancel(); first = null; }
    }
    const head = request.method === 'HEAD';
    const shape = song.shape;
    if (shape.kind === 'ranges') {
      const answer = await open(song, 0, abort.signal, range);
      if (!playable(answer)) { await answer.body?.cancel().catch(() => {}); response.writeHead(502).end(); return; }
      return pass(answer, new Body(answer), response, head);
    }
    if (shape.kind === 'whole') {
      // No reading from an offset: the song plays from its start.
      if (start > 0) { response.writeHead(416, { 'content-range': 'bytes */*' }).end(); return; }
      const body = first ?? await opened(await open(song, 0, abort.signal));
      if (!body) { response.writeHead(502).end(); return; }
      response.writeHead(200, { 'content-type': 'audio/mpeg', 'accept-ranges': 'none' });
      return finish(body, response, head, Infinity);
    }
    if (start >= shape.length) { first?.cancel(); response.writeHead(416, { 'content-range': `bytes */${shape.length}` }).end(); return; }
    let body = first;
    if (body) await body.skip(start);
    else if (start < shape.tag) {
      body = await opened(await open(song, 0, abort.signal));
      await body?.skip(start);
    } else {
      // The second this byte stands for. Navidrome starts on whole seconds, so the rest is skipped
      // here; libmpv's reader then finds the next frame.
      const seconds = (start - shape.tag) / shape.perSecond;
      const offset = Math.floor(seconds);
      body = await opened(await open(song, offset, abort.signal));
      if (body) { await body.skip(await tagLength(body)); await body.skip(Math.round((seconds - offset) * shape.perSecond)); }
    }
    if (!body) { response.writeHead(502).end(); return; }
    response.writeHead(range ? 206 : 200, {
      'content-type': 'audio/mpeg', 'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${shape.length - 1}/${shape.length}` } : { 'content-length': String(shape.length) }),
    });
    // Never past the length libmpv was told: a conversion runs a frame or two over it.
    return finish(body, response, head, shape.length - start);
  }

  return {
    location(upstream, duration) {
      const token = randomBytes(16).toString('hex');
      songs.set(token, { upstream, duration });
      if (songs.size > MAX_SONGS) songs.delete(songs.keys().next().value!);
      return `http://${host}/${token}`;
    },
    forget() { songs.clear(); },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// A song's stream, not an error: Subsonic errors arrive as a JSON or XML envelope with HTTP 200.
function playable(answer: Response) {
  const type = answer.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  return answer.ok && answer.body !== null && !type.startsWith('text/') && type !== 'application/json' && type !== 'application/xml';
}
async function opened(answer: Response) {
  if (playable(answer)) return new Body(answer);
  await answer.body?.cancel().catch(() => {});
  return null;
}

async function shapeOf(answer: Response, body: Body, duration: number | null): Promise<Shape> {
  const length = Number(answer.headers.get('content-length'));
  if (answer.headers.get('accept-ranges') === 'bytes' && length > 0) return { kind: 'ranges' };
  const tag = await tagLength(body);
  await body.fill(tag + 4);
  const kbps = mp3Kbps(body.peek().subarray(tag));
  const seconds = Number(answer.headers.get('x-content-duration')) || duration;
  if (!kbps || !seconds || seconds <= 0) return { kind: 'whole' };
  const perSecond = kbps * 1000 / 8;
  return { kind: 'mp3', tag, perSecond, length: tag + Math.ceil(seconds * perSecond) };
}

// The ID3v2 tag at the start of the bytes ahead, if there is one, in bytes (header included).
async function tagLength(body: Body) {
  await body.fill(10);
  const head = body.peek();
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  const length = 10 + size + (head[5] & 0x10 ? 10 : 0);
  return length <= HEAD_BYTES ? length : 0;
}

// The bitrate of the MPEG audio layer III frame these bytes start with, in kbps; null for anything else.
const MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
export function mp3Kbps(bytes: Uint8Array): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[1] >> 3) & 3, layer = (bytes[1] >> 1) & 3, index = bytes[2] >> 4;
  if (version === 1 || layer !== 1 || index === 0 || index === 15 || (bytes[2] >> 2 & 3) === 3) return null;
  return (version === 3 ? MPEG1 : MPEG2)[index];
}

function pass(answer: Response, body: Body, response: ServerResponse, head: boolean) {
  const headers: Record<string, string> = {};
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = answer.headers.get(name);
    if (value) headers[name] = value;
  }
  response.writeHead(answer.status, headers);
  return finish(body, response, head, Infinity);
}

// Until the player wants more, or has gone. mpv stops reading once its cache is full, so a song
// waits here many times; each wait takes both listeners off again.
const drained = (response: ServerResponse) => new Promise<void>(resolve => {
  const done = () => { response.off('drain', done); response.off('close', done); resolve(); };
  response.once('drain', done).once('close', done);
});

// Sends the body on, at most `limit` bytes; a HEAD request gets the headers alone.
async function finish(body: Body, response: ServerResponse, head: boolean, limit: number) {
  if (head) { body.cancel(); response.end(); return; }
  try {
    for await (const chunk of body.chunks()) {
      const part = chunk.length > limit ? chunk.subarray(0, limit) : chunk;
      limit -= part.length;
      if (!response.write(part)) await drained(response);
      if (limit <= 0 || response.destroyed) break;
    }
  } finally {
    body.cancel();
    response.end();
  }
}

// A response body read ahead as far as needed (fill, peek, skip), then sent on (chunks).
class Body {
  private head = Buffer.alloc(0);
  private ended = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(answer: Response) { this.reader = answer.body!.getReader(); }
  async fill(bytes: number) {
    while (this.head.length < bytes && !this.ended) {
      const { done, value } = await this.reader.read();
      if (done) this.ended = true; else this.head = Buffer.concat([this.head, value]);
    }
  }
  peek() { return this.head; }
  async skip(bytes: number) {
    while (bytes > 0) {
      if (!this.head.length) { await this.fill(1); if (!this.head.length) return; }
      const taken = Math.min(bytes, this.head.length);
      this.head = this.head.subarray(taken); bytes -= taken;
    }
  }
  async *chunks() {
    if (this.head.length) { const head = this.head; this.head = Buffer.alloc(0); yield head; }
    while (!this.ended) {
      const { done, value } = await this.reader.read();
      if (done) { this.ended = true; return; }
      yield Buffer.from(value);
    }
  }
  cancel() { this.ended = true; void this.reader.cancel().catch(() => {}); }
}
