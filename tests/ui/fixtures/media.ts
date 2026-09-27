import { deflateSync } from 'node:zlib';

// Generated media for the fake Navidrome: small raster covers and short PCM WAV files.
// Everything is deterministic, so screenshots of palettes and durations never drift.

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)];
}

/** A 32×32 RGB PNG: a pale ground in one hue with a vivid block in the opposite hue. */
export function coverPng(hue: number) {
  const size = 32;
  const ground = hslToRgb(hue, .35, .8);
  const mark = hslToRgb((hue + 180) % 360, .75, .45);
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const inside = x >= 8 && x < 24 && y >= 8 && y < 24;
      const [r, g, b] = inside ? mark : ground;
      row.writeUInt8(r, 1 + x * 3); row.writeUInt8(g, 2 + x * 3); row.writeUInt8(b, 3 + x * 3);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); header.writeUInt8(2, 9); // 8-bit truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const wavCache = new Map<string, Buffer>();
/** A mono 16-bit, 8 kHz WAV of a quiet tone, exactly `seconds` long. */
export function toneWav(seconds: number, frequency = 440) {
  const key = `${seconds}:${frequency}`;
  const cached = wavCache.get(key);
  if (cached) return cached;
  const rate = 8000, samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / rate) * 2000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(data.length, 40);
  const wav = Buffer.concat([header, data]);
  wavCache.set(key, wav);
  return wav;
}
