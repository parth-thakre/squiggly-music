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
// With a cache folder (the app's), every server song comes through the relay, the original too,
// and each is downloaded whole to a file there while it plays: libmpv reads the file as it fills,
// so a song that has downloaded can't stall, however the network does later. A download that goes
// quiet for STALL_MS is asked for again from the byte it reached (a stream that goes silent
// without closing otherwise holds libmpv for its network timeout, or, as seen on Windows, for
// good). Once the songs being played have downloaded, the ones queued next (want) download, one
// at a time. A read further on than the download has reached is fetched for itself, as without
// the cache, while the download goes on.
//
// The addresses carry the account's credentials, so they stay in this process: libmpv is given
// http://127.0.0.1:<port>/<random token>, and nothing else is served. The files hold only audio,
// and go when the account signs out (forget) and each time the relay starts.
import { randomBytes } from 'node:crypto';
import { open as openFile, mkdir, rm, type FileHandle } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

// Songs remembered: more than a queue holds (QUEUE_LIMIT). The oldest go first.
const MAX_SONGS = 2_000;
// Navidrome refuses a conversion past its limit (429 or 503) without waiting. Right after a seek,
// the conversion the seek replaced may still hold its place for a moment.
const ATTEMPTS = 3;
const RETRY_MS = 1_000;
// How far into a stream its first MP3 frame may be: past an ID3v2 tag, which comes first.
const HEAD_BYTES = 64 * 1024;
// A stream that sends nothing for this long is given up on and asked for again.
const STALL_MS = 10_000;
// Tries in a row that bring nothing before a download gives up; the wait grows with each.
const FAILURES = 5;
// A read this close past what has downloaded waits for the download rather than asking for its
// own stream: at least this many bytes, or what the download brings in two seconds.
const NEAR_BYTES = 256 * 1024;
const NEAR_SECONDS = 2;

type Shape =
  | { kind: 'ranges' }
  // `tag`: the ID3v2 tag the stream starts with, in bytes. `perSecond`: the frames' bitrate in bytes.
  | { kind: 'mp3'; tag: number; perSecond: number; length: number }
  | { kind: 'whole' };
interface Song { token: string; upstream: string; duration: number | null; key?: string; shape?: Shape; download?: Download }

// A song's file, filling from its start. `length`: the bytes it will have when whole (the
// constant-bitrate length for a conversion, unknown for a 'whole' stream). `readers`: responses
// to libmpv for the song open now; the song is playing, and its download runs.
class Download {
  have = 0;
  length: number | null = null;
  type = 'audio/mpeg';
  done = false;
  failed = false;
  readers = 0;
  used = Date.now();
  running: AbortController | null = null;
  // Bytes a second over the current try, for NEAR_SECONDS.
  rate = 0;
  // Settles with the song's shape once the first answer has come, and its length is known.
  readonly ready: Promise<Shape>;
  settle!: { resolve(shape: Shape): void; reject(error: Error): void };
  private waiting: (() => void)[] = [];
  constructor(readonly path: string, readonly file: Promise<FileHandle>) {
    this.ready = new Promise<Shape>((resolve, reject) => { this.settle = { resolve, reject }; });
    this.ready.catch(() => {});
  }
  // Wakes every read waiting for more (or for the end).
  moved() { const waiting = this.waiting; this.waiting = []; for (const wake of waiting) wake(); }
  next() { return new Promise<void>(resolve => this.waiting.push(resolve)); }
}

export interface RelayEvent { name: 'stream.stalled' | 'stream.downloaded' | 'stream.failed'; key: string | null; bytes: number; ms?: number }
export interface RelayOptions {
  // Where songs download to. Without one, nothing is kept: each read is its own stream.
  cacheDir?: string;
  // The most the files may hold together; the songs used longest ago go first.
  cacheBytes?: number;
  stallMs?: number;
  // For diagnostics: never the addresses, only the song's key and sizes.
  onEvent?: (event: RelayEvent) => void;
}

export interface StreamRelay {
  // The address libmpv plays for `upstream`, a Subsonic stream address (format=mp3 with a bitrate,
  // or the original with the cache). `duration` is the library's, for a server that doesn't send
  // X-Content-Duration. `key` names the song at this quality: the same key gives the same address,
  // and the same download, whatever credentials the newer `upstream` carries.
  location(upstream: string, duration: number | null, key?: string): string;
  // The songs, by key, queued after the one playing, in the order they'll play: each downloads,
  // one at a time, once the songs being played have.
  want(keys: string[]): void;
  // Forgets every song, as when the account signs out.
  forget(): void;
  close(): Promise<void>;
}

export async function startStreamRelay(fetchSong: typeof fetch = fetch, options: RelayOptions = {}): Promise<StreamRelay> {
  const { cacheDir, cacheBytes = 2 * 1024 ** 3, stallMs = STALL_MS, onEvent } = options;
  if (cacheDir) { await rm(cacheDir, { recursive: true, force: true }); await mkdir(cacheDir, { recursive: true }); }
  const songs = new Map<string, Song>();
  const keyed = new Map<string, Song>();
  let wanted: string[] = [];
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
    const head = request.method === 'HEAD';
    if (cacheDir) return serveDownload(song, response, abort.signal, range, start, head);

    let first: Body | null = null;
    if (!song.shape) {
      const answer = await open(song, 0, abort.signal);
      if (!playable(answer)) { await answer.body?.cancel().catch(() => {}); response.writeHead(502).end(); return; }
      first = new Body(answer, stallMs);
      song.shape = await shapeOf(answer, first, song.duration);
      if (song.shape.kind === 'ranges' && !range) return pass(answer, first, response, head);
      // This answer runs from the start: kept when that's where the read starts.
      const fromStart = song.shape.kind === 'mp3' ? start < song.shape.tag : song.shape.kind === 'whole' && start === 0;
      if (!fromStart) { first.cancel(); first = null; }
    }
    return live(song, song.shape, first, response, abort.signal, range, start, head);
  }

  // A read from the song's own stream (or `first`, the answer that gave its shape, when it starts
  // where the read does), not its download.
  async function live(song: Song, shape: Shape, first: Body | null, response: ServerResponse, signal: AbortSignal, range: string | undefined, start: number, head: boolean) {
    if (shape.kind === 'ranges') {
      const answer = await open(song, 0, signal, range);
      if (!playable(answer)) { await answer.body?.cancel().catch(() => {}); response.writeHead(502).end(); return; }
      return pass(answer, new Body(answer, stallMs), response, head);
    }
    if (shape.kind === 'whole') {
      // No reading from an offset: the song plays from its start.
      if (start > 0) { response.writeHead(416, { 'content-range': 'bytes */*' }).end(); return; }
      const body = first ?? await opened(await open(song, 0, signal), stallMs);
      if (!body) { response.writeHead(502).end(); return; }
      response.writeHead(200, { 'content-type': 'audio/mpeg', 'accept-ranges': 'none' });
      return finish(body, response, head, Infinity);
    }
    if (start >= shape.length) { first?.cancel(); response.writeHead(416, { 'content-range': `bytes */${shape.length}` }).end(); return; }
    const body = first ? (await first.skip(start), first) : await fromByte(song, shape, start, signal);
    if (!body) { response.writeHead(502).end(); return; }
    response.writeHead(range ? 206 : 200, {
      'content-type': 'audio/mpeg', 'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${shape.length - 1}/${shape.length}` } : { 'content-length': String(shape.length) }),
    });
    // Never past the length libmpv was told: a conversion runs a frame or two over it.
    return finish(body, response, head, shape.length - start);
  }

  // A conversion from byte `start` of its constant-bitrate file.
  async function fromByte(song: Song, shape: Extract<Shape, { kind: 'mp3' }>, start: number, signal: AbortSignal) {
    if (start < shape.tag) {
      const body = await opened(await open(song, 0, signal), stallMs);
      await body?.skip(start);
      return body;
    }
    // The second this byte stands for. Navidrome starts on whole seconds, so the rest is skipped
    // here; libmpv's reader then finds the next frame.
    const seconds = (start - shape.tag) / shape.perSecond;
    const offset = Math.floor(seconds);
    const body = await opened(await open(song, offset, signal), stallMs);
    if (body) { await body.skip(await tagLength(body)); await body.skip(Math.round((seconds - offset) * shape.perSecond)); }
    return body;
  }

  // With the cache: from the song's file as it downloads, or, past where it has reached, live.
  async function serveDownload(song: Song, response: ServerResponse, signal: AbortSignal, range: string | undefined, start: number, head: boolean) {
    let download = song.download;
    if (!download || download.failed) { drop(song); download = create(song); }
    const reading = download;
    reading.readers++; reading.used = Date.now();
    response.once('close', () => { reading.readers--; reading.used = Date.now(); schedule(); });
    schedule();
    let shape: Shape;
    try { shape = await reading.ready; } catch { response.writeHead(502).end(); return; }
    const length = shape.kind === 'mp3' ? shape.length : reading.length;
    const near = reading.have + Math.max(NEAR_BYTES, reading.rate * NEAR_SECONDS);
    if (reading.failed || start > near || (shape.kind === 'ranges' && length === null)) return live(song, shape, null, response, signal, range, start, head);
    if (shape.kind === 'whole') {
      if (start > 0) { response.writeHead(416, { 'content-range': 'bytes */*' }).end(); return; }
      response.writeHead(200, { 'content-type': reading.type, 'accept-ranges': 'none' });
      return send(fromFile(reading, 0, Infinity), () => {}, response, head, Infinity);
    }
    const end = length!;
    if (start >= end) { response.writeHead(416, { 'content-range': `bytes */${end}` }).end(); return; }
    response.writeHead(range ? 206 : 200, {
      'content-type': reading.type, 'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${end - 1}/${end}` } : { 'content-length': String(end) }),
    });
    return send(fromFile(reading, start, end), () => {}, response, head, end - start);
  }

  let files = 0;
  function create(song: Song) {
    // A file of its own each time: one being deleted can't take a new download's with it.
    const path = join(cacheDir!, `${song.token}-${++files}`);
    const file = openFile(path, 'w+');
    file.catch(() => {});
    song.download = new Download(path, file);
    return song.download;
  }
  function drop(song: Song) {
    const download = song.download;
    if (!download) return Promise.resolve();
    song.download = undefined;
    download.running?.abort();
    download.settle.reject(new Error('The song was let go.'));
    download.moved();
    return download.file.then(file => file.close()).catch(() => {}).then(() => rm(download.path, { force: true })).catch(() => {});
  }

  // Songs being played download first. Once each of those has, the first song wanted that hasn't
  // downloads; any other stops where it is, to go on if it's wanted again.
  function schedule() {
    if (!cacheDir) return;
    const held = [...songs.values()].filter(song => song.download);
    const playing = held.some(song => { const d = song.download!; return d.readers > 0 && !d.done && !d.failed; });
    let next: Song | undefined;
    if (!playing) for (const key of wanted) {
      const song = keyed.get(key);
      if (song && !song.download?.done && !song.download?.failed) { next = song; break; }
    }
    if (next && !next.download) { create(next); held.push(next); }
    for (const song of held) {
      const download = song.download!;
      const run = download.readers > 0 || song === next;
      if (run && !download.running && !download.done && !download.failed) void fetchWhole(song, download);
      else if (!run && download.running) download.running.abort();
    }
    evict();
  }
  // Over the limit, the songs used longest ago go, but never one playing, downloading or wanted.
  function evict() {
    const held = [...songs.values()].filter(song => song.download);
    let total = held.reduce((sum, song) => sum + song.download!.have, 0);
    if (total <= cacheBytes) return;
    const spare = held.filter(song => { const d = song.download!; return !d.readers && !d.running && !(song.key && wanted.includes(song.key)); })
      .sort((a, b) => a.download!.used - b.download!.used);
    for (const song of spare) {
      if (total <= cacheBytes) break;
      total -= song.download!.have;
      void drop(song);
    }
  }

  async function fetchWhole(song: Song, download: Download) {
    const control = new AbortController();
    download.running = control;
    const began = Date.now();
    let failures = 0;
    try {
      const file = await download.file;
      while (!download.done && !download.failed && !control.signal.aborted) {
        const before = download.have;
        const outcome = await fetchFrom(song, download, file, control.signal).catch((error: unknown) => error instanceof Stall ? 'stalled' : 'error');
        if (download.done || control.signal.aborted) break;
        if (outcome === 'refused') { fail(song, download); break; }
        if (outcome === 'stalled') onEvent?.({ name: 'stream.stalled', key: song.key ?? null, bytes: download.have });
        if (download.have > before) failures = 0;
        else if (++failures >= FAILURES) { fail(song, download); break; }
        await new Promise(resolve => { const timer = setTimeout(resolve, RETRY_MS * failures); control.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null); }, { once: true }); });
      }
      if (download.done) onEvent?.({ name: 'stream.downloaded', key: song.key ?? null, bytes: download.have, ms: Date.now() - began });
    } catch {
      if (!control.signal.aborted) fail(song, download);
    } finally {
      if (download.running === control) download.running = null;
      download.moved();
      if (song.download === download) schedule();
    }
  }
  function fail(song: Song, download: Download) {
    download.failed = true;
    download.settle.reject(new Error('The song could not be downloaded.'));
    onEvent?.({ name: 'stream.failed', key: song.key ?? null, bytes: download.have });
  }

  // One try: from the byte the download has reached to its end, or until the stream fails.
  async function fetchFrom(song: Song, download: Download, file: FileHandle, outer: AbortSignal): Promise<'ended' | 'refused'> {
    const control = new AbortController();
    let body: Body | null = null;
    // Cancelling the body ends a read that's waiting on the stream, too.
    const stop = () => { control.abort(); body?.cancel(); };
    outer.addEventListener('abort', stop, { once: true });
    try {
      const signal = control.signal;
      // A stream with no offsets starts again from the top; reads following it wait to catch up.
      if (song.shape?.kind === 'whole' && download.have > 0) { download.have = 0; await file.truncate(0); }
      if (download.have === 0) {
        const answer = await open(song, 0, signal);
        if (!playable(answer)) { await answer.body?.cancel().catch(() => {}); return 'refused'; }
        body = new Body(answer, stallMs);
        song.shape ??= await shapeOf(answer, body, song.duration);
        const shape = song.shape;
        download.type = answer.headers.get('content-type') ?? 'application/octet-stream';
        download.length = shape.kind === 'mp3' ? shape.length : shape.kind === 'ranges' ? Number(answer.headers.get('content-length')) || null : null;
        download.settle.resolve(shape);
      } else if (song.shape?.kind === 'ranges') {
        const answer = await open(song, 0, signal, `bytes=${download.have}-`);
        body = await opened(answer, stallMs);
        if (!body) throw new Error('No stream.');
        if (answer.status === 200) await body.skip(download.have);
      } else if (song.shape?.kind === 'mp3') {
        body = await fromByte(song, song.shape, download.have, signal);
        if (!body) throw new Error('No stream.');
      } else throw new Error('No shape.');
      const from = download.have, at = Date.now();
      for await (const chunk of body.chunks()) {
        const room = download.length === null ? chunk.length : Math.max(0, download.length - download.have);
        const part = chunk.subarray(0, Math.min(chunk.length, room));
        if (part.length) {
          await file.write(part, 0, part.length, download.have);
          download.have += part.length;
          download.rate = (download.have - from) / Math.max(1, (Date.now() - at) / 1000);
          download.moved();
        }
        if ((download.length !== null && download.have >= download.length) || signal.aborted) break;
      }
      // A file served in ranges has its length to reach, and is asked for again until it does; a
      // conversion is whole where it ends.
      if (!signal.aborted && (song.shape.kind !== 'ranges' || download.have >= (download.length ?? 0))) download.done = true;
      return 'ended';
    } finally {
      outer.removeEventListener('abort', stop);
      body?.cancel();
      control.abort();
    }
  }

  return {
    location(upstream, duration, key) {
      const known = key === undefined ? undefined : keyed.get(key);
      if (known) {
        // The newest credentials; and it's the last to go when there are too many songs.
        known.upstream = upstream; known.duration = duration;
        songs.delete(known.token); songs.set(known.token, known);
        return `http://${host}/${known.token}`;
      }
      const token = randomBytes(16).toString('hex');
      const song: Song = { token, upstream, duration, key };
      songs.set(token, song);
      if (key !== undefined) keyed.set(key, song);
      if (songs.size > MAX_SONGS) {
        const oldest = songs.values().next().value!;
        songs.delete(oldest.token);
        if (oldest.key !== undefined && keyed.get(oldest.key) === oldest) keyed.delete(oldest.key);
        void drop(oldest);
      }
      return `http://${host}/${token}`;
    },
    want(keys) {
      if (keys.length === wanted.length && keys.every((key, index) => key === wanted[index])) return;
      wanted = [...keys];
      const now = Date.now();
      for (const key of wanted) { const download = keyed.get(key)?.download; if (download) download.used = now; }
      schedule();
    },
    forget() { forgetAll(); },
    close: async () => {
      await forgetAll();
      await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    },
  };
  function forgetAll() {
    const dropped = [...songs.values()].map(drop);
    songs.clear(); keyed.clear(); wanted = [];
    return Promise.all(dropped);
  }
}

// What a download has written, from `at` to `end`, waiting for more as it comes.
async function* fromFile(download: Download, at: number, end: number) {
  const file = await download.file;
  const buffer = Buffer.alloc(256 * 1024);
  while (at < end) {
    if (at >= download.have) {
      if (download.done || download.failed || !download.running && download.readers === 0) return;
      await download.next();
      continue;
    }
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, download.have - at, end - at), at);
    if (!bytesRead) return;
    at += bytesRead;
    yield Buffer.from(buffer.subarray(0, bytesRead));
  }
}

class Stall extends Error {}

// A song's stream, not an error: Subsonic errors arrive as a JSON or XML envelope with HTTP 200.
function playable(answer: Response) {
  const type = answer.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  return answer.ok && answer.body !== null && !type.startsWith('text/') && type !== 'application/json' && type !== 'application/xml';
}
async function opened(answer: Response, idle = Infinity) {
  if (playable(answer)) return new Body(answer, idle);
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

const finish = (body: Body, response: ServerResponse, head: boolean, limit: number) => send(body.chunks(), () => body.cancel(), response, head, limit);

// Sends the chunks on, at most `limit` bytes; a HEAD request gets the headers alone. Cut short (the
// stream stalled or failed), the connection closes: libmpv then asks again from where it got to,
// where a reply that merely ended would leave it waiting for the bytes it was promised.
async function send(chunks: AsyncIterable<Buffer>, stop: () => void, response: ServerResponse, head: boolean, limit: number) {
  if (head) { stop(); response.end(); return; }
  try {
    for await (const chunk of chunks) {
      const part = chunk.length > limit ? chunk.subarray(0, limit) : chunk;
      limit -= part.length;
      if (!response.write(part)) await drained(response);
      if (limit <= 0 || response.destroyed) break;
    }
    response.end();
  } catch {
    response.destroy();
  } finally {
    stop();
  }
}

// A response body read ahead as far as needed (fill, peek, skip), then sent on (chunks).
// `idle`: how long a read may wait for the stream before it's taken as stalled (Stall).
class Body {
  private head = Buffer.alloc(0);
  private ended = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(answer: Response, private readonly idle = Infinity) { this.reader = answer.body!.getReader(); }
  private async read() {
    if (this.idle === Infinity) return this.reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quiet = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Stall('The stream went quiet.')), this.idle); });
    try { return await Promise.race([this.reader.read(), quiet]); } finally { clearTimeout(timer); }
  }
  async fill(bytes: number) {
    while (this.head.length < bytes && !this.ended) {
      const { done, value } = await this.read();
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
      const { done, value } = await this.read();
      if (done) { this.ended = true; return; }
      yield Buffer.from(value);
    }
  }
  cancel() { this.ended = true; void this.reader.cancel().catch(() => {}); }
}
