import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { mp3Kbps, startStreamRelay, type StreamRelay } from '../apps/desktop/main/streamRelay';

// A Navidrome conversion of a 10-second song to a 128 kbps MP3 (16,000 bytes a second): an ID3v2
// tag, then frames. Each audio byte says where it is in the song (its index mod 251), so a test
// can tell which second a response starts from. The first four are a frame header.
const SECONDS = 10, PER_SECOND = 16_000, TAG = 30;
const tag = () => Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, TAG - 10]), Buffer.alloc(TAG - 10)]);
const audioByte = (at: number) => [0xff, 0xfb, 0x90, 0x64][at] ?? at % 251;
// Conversions run a little past the song's length.
const audio = (from: number) => Buffer.from(Array.from({ length: SECONDS * PER_SECOND + 500 - from }, (_, i) => audioByte(from + i)));

type Answer = (url: URL, headers: Record<string, string>) => Response;
const converting: Answer = url => {
  const offset = Number(url.searchParams.get('timeOffset') ?? 0);
  return new Response(Buffer.concat([tag(), audio(offset * PER_SECOND)]), { headers: {
    'content-type': 'audio/mpeg', 'accept-ranges': 'none', 'x-content-duration': String(SECONDS - offset),
    // Navidrome's estimate counts 1,024 bytes a kilobit.
    'content-length': String((SECONDS - offset) * 128 / 8 * 1024),
  } });
};

let relay: StreamRelay | null = null;
const asked: URL[] = [];
async function start(answer: Answer) {
  asked.length = 0;
  relay = await startStreamRelay((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push(url);
    return answer(url, (init?.headers ?? {}) as Record<string, string>);
  }) as typeof fetch);
  return relay.location('https://music.example/rest/stream?id=s1&u=me&t=token&s=salt&format=mp3&maxBitRate=128', SECONDS);
}
afterEach(async () => { await relay?.close(); relay = null; });

async function get(location: string, range?: string) {
  const response = await fetch(location, { headers: range ? { range } : {} });
  return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
}
const offsets = () => asked.map(url => url.searchParams.get('timeOffset'));

describe('the stream relay', () => {
  it('gives a conversion as a constant-bitrate file of the song\'s length, tag first', async () => {
    const location = await start(converting);
    // A loopback address with a random name, never the server's address or its credentials.
    expect(location).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    const whole = await get(location);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('content-length')).toBe(String(TAG + SECONDS * PER_SECOND));
    // Cut at that length, though the conversion ran past it.
    expect(whole.body).toEqual(Buffer.concat([tag(), audio(0)]).subarray(0, TAG + SECONDS * PER_SECOND));
    expect(asked[0].searchParams.get('estimateContentLength')).toBe('true');
    expect(offsets()).toEqual([null]);
  });

  it('reads from a byte by asking for the song from that second, to the byte', async () => {
    const location = await start(converting);
    await get(location);
    // 5.5 seconds in: Navidrome sends from 5 s, and the relay drops the half second and the tag.
    const from = TAG + 5.5 * PER_SECOND;
    const part = await get(location, `bytes=${from}-`);
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes ${from}-${TAG + SECONDS * PER_SECOND - 1}/${TAG + SECONDS * PER_SECOND}`);
    expect(offsets()).toEqual([null, '5']);
    expect(part.body.length).toBe(4.5 * PER_SECOND);
    expect([...part.body.subarray(0, 600)]).toEqual(Array.from({ length: 600 }, (_, i) => audioByte(5.5 * PER_SECOND + i)));
    // Past the end there's nothing to send.
    expect((await get(location, `bytes=${TAG + SECONDS * PER_SECOND}-`)).status).toBe(416);
  });

  it('starts from a byte at once, before anything was read from the start', async () => {
    const location = await start(converting);
    const part = await get(location, `bytes=${TAG + 2 * PER_SECOND}-`);
    expect(part.status).toBe(206);
    // The first answer gives the stream's shape and is dropped; the read starts at 2 s.
    expect(offsets()).toEqual([null, '2']);
    expect(part.body[0]).toBe(audioByte(2 * PER_SECOND));
  });

  it('passes a stream the server serves in ranges through as it is', async () => {
    const file = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    const location = await start((_url, headers) => {
      const start = Number(/bytes=(\d+)-/.exec(headers.range ?? '')?.[1] ?? 0);
      return new Response(file.subarray(start), { status: headers.range ? 206 : 200, headers: {
        'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'content-length': String(file.length - start),
        ...(headers.range ? { 'content-range': `bytes ${start}-${file.length - 1}/${file.length}` } : {}),
      } });
    });
    expect((await get(location)).body).toEqual(file);
    const part = await get(location, 'bytes=1000-');
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 1000-4999/5000');
    expect(part.body).toEqual(file.subarray(1000));
    expect(offsets()).toEqual([null, null]);
  });

  it('plays a stream it can\'t read by bitrate from the start only', async () => {
    const location = await start(() => new Response(Buffer.from('OggS not an mp3'), { headers: { 'content-type': 'audio/ogg', 'accept-ranges': 'none' } }));
    const whole = await get(location);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('none');
    expect(whole.body.toString()).toBe('OggS not an mp3');
    expect((await get(location, 'bytes=100-')).status).toBe(416);
  });

  it('tries again while the server is at its limit of conversions', async () => {
    let refusals = 1;
    const location = await start((url, headers) => refusals-- > 0 ? new Response(null, { status: 429 }) : converting(url, headers));
    expect((await get(location)).status).toBe(200);
    expect(asked).toHaveLength(2);
  });

  it('turns a server error into a failed stream, not a song', async () => {
    const location = await start(() => new Response('<subsonic-response status="failed"/>', { headers: { 'content-type': 'text/xml' } }));
    expect((await get(location)).status).toBe(502);
  });

  it('serves only its own songs, under its own name', async () => {
    const location = await start(converting);
    const { port, pathname } = new URL(location);
    expect((await get(`http://127.0.0.1:${port}/${'0'.repeat(32)}`)).status).toBe(404);
    // A page that renamed another host to 127.0.0.1 (DNS rebinding) still sends that host's name.
    const status = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: pathname, headers: { host: `attacker.example:${port}` } }, response => { response.resume(); resolve(response.statusCode!); })
        .on('error', reject).end();
    });
    expect(status).toBe(404);
    relay!.forget();
    expect((await get(location)).status).toBe(404);
    expect(asked).toHaveLength(0);
  });

  it('waits for a player that reads slowly as often as it needs to', async () => {
    // An hour-long conversion, read a little at a time, as mpv does once its cache is full.
    const hour = 3600 * PER_SECOND;
    const chunk = Buffer.from(Array.from({ length: PER_SECOND }, (_, i) => audioByte(i)));
    let sent = 0;
    asked.length = 0;
    relay = await startStreamRelay((async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(tag())); },
      pull(controller) { if (sent >= hour) controller.close(); else { controller.enqueue(new Uint8Array(chunk)); sent += chunk.length; } },
    }), { headers: { 'content-type': 'audio/mpeg', 'accept-ranges': 'none', 'x-content-duration': '3600' } })) as typeof fetch);
    const location = relay.location('https://music.example/rest/stream?id=s1&format=mp3&maxBitRate=128', 3600);
    const warnings: Error[] = [];
    const warned = (warning: Error) => warnings.push(warning);
    process.on('warning', warned);
    try {
      const read = await new Promise<number>((resolve, reject) => {
        request(location, response => {
          let bytes = 0;
          response.on('data', (data: Buffer) => {
            bytes += data.length;
            response.pause();
            setTimeout(() => response.resume(), 1);
          }).on('end', () => resolve(bytes)).on('error', reject);
        }).on('error', reject).end();
      });
      expect(read).toBe(TAG + hour);
      await new Promise(resolve => setImmediate(resolve));
      expect(warnings.map(warning => warning.name)).not.toContain('MaxListenersExceededWarning');
    } finally { process.off('warning', warned); }
  }, 30_000);

  it('reads an MP3 frame\'s bitrate', () => {
    expect(mp3Kbps(Uint8Array.from([0xff, 0xfb, 0x90, 0x64]))).toBe(128);
    expect(mp3Kbps(Uint8Array.from([0xff, 0xfb, 0xe0, 0x64]))).toBe(320);
    // MPEG-2, 22.05 kHz: the lower table.
    expect(mp3Kbps(Uint8Array.from([0xff, 0xf3, 0x90, 0x64]))).toBe(80);
    for (const bytes of [[0x49, 0x44, 0x33, 4], [0xff, 0xfb, 0xf0, 0x64], [0xff, 0xfd, 0x90, 0x64], [0xff, 0xfb]]) expect(mp3Kbps(Uint8Array.from(bytes))).toBeNull();
  });
});
