import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { readLocalCover, readLocalTracks } from '../apps/desktop/main/localFiles';

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

// A one-pixel PNG, built rather than stored so the test shows what it is.
function png() {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
    return out;
  };
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 200, 40, 40]))), chunk('IEND', Buffer.alloc(0))]);
}
// A FLAC file's metadata and no audio: STREAMINFO (44.1 kHz, 16-bit, stereo, 10 s), Vorbis
// comments, and a front-cover picture. Enough for tags, length, format, and the cover.
function flac(tags: Record<string, string>, picture: Buffer, type = 'image/png') {
  const block = (type: number, data: Buffer, last = false) => Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type, data.length >> 16, (data.length >> 8) & 255, data.length & 255]), data]);
  const info = Buffer.alloc(34);
  info.writeUInt16BE(4096, 0); info.writeUInt16BE(4096, 2);
  const samples = 441_000;
  // 20 bits rate, 3 bits channels-1, 5 bits bits-per-sample-1, 36 bits total samples.
  const packed = (BigInt(44_100) << 44n) | (1n << 41n) | (15n << 36n) | BigInt(samples);
  info.writeBigUInt64BE(packed, 10);
  const text = (value: string) => { const bytes = Buffer.from(value, 'utf8'); const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length); return Buffer.concat([length, bytes]); };
  const entries = Object.entries(tags).map(([key, value]) => text(`${key}=${value}`));
  const count = Buffer.alloc(4); count.writeUInt32LE(entries.length);
  const comments = Buffer.concat([text('squiggly test'), count, ...entries]);
  const be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const mime = Buffer.from(type);
  const pictureBlock = Buffer.concat([be(3), be(mime.length), mime, be(0), be(1), be(1), be(24), be(0), be(picture.length), picture]);
  return Buffer.concat([Buffer.from('fLaC'), block(0, info), block(4, comments), block(6, pictureBlock, true)]);
}

describe('files opened from this computer', () => {
  it('take their title, artist, album, length, format, and embedded cover from the file', async () => {
    directory = await mkdtemp(join(tmpdir(), 'squiggly-local-'));
    const cover = png();
    const path = join(directory, '01 track.flac');
    await writeFile(path, flac({ TITLE: 'Kismis', ARTIST: 'A. R. Rahman', ALBUM: 'Main Vaapas Aaunga', TRACKNUMBER: '2' }, cover));
    const [track] = await readLocalTracks([path]);
    expect(track).toMatchObject({
      title: 'Kismis', artist: 'A. R. Rahman', album: 'Main Vaapas Aaunga', source: 'local',
      duration: 10, sourceFormat: 'flac', sourceSampleRate: 44_100, sourceBitDepth: 16, trackNumber: 2,
    });
    expect(track.coverArt).toMatch(/^local-/);
    expect(await readLocalCover(track.coverArt!)).toEqual({ bytes: cover, contentType: 'image/png' });
  });

  it('fall back to a cover image in the folder, then to the file name, and keep their order', async () => {
    directory = await mkdtemp(join(tmpdir(), 'squiggly-local-'));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await writeFile(join(directory, 'Cover.JPG'), jpeg);
    await writeFile(join(directory, 'b.wav'), Buffer.from('not really audio'));
    await writeFile(join(directory, 'a.flac'), flac({ TITLE: 'Tagged' }, png()));
    const tracks = await readLocalTracks([join(directory, 'b.wav'), join(directory, 'a.flac')]);
    expect(tracks.map(track => track.title)).toEqual(['b', 'Tagged']);
    expect(tracks[0]).toMatchObject({ artist: 'Unknown artist', album: '', sourceFormat: 'wav' });
    expect(await readLocalCover(tracks[0].coverArt!)).toEqual({ bytes: jpeg, contentType: 'image/jpeg' });
    // Two songs in the folder share its cover's id; an embedded picture has its own.
    const [again] = await readLocalTracks([join(directory, 'b.wav')]);
    expect(again.coverArt).toBe(tracks[0].coverArt);
    expect(tracks[1].coverArt).not.toBe(tracks[0].coverArt);
    expect(await readLocalCover('local-unknown')).toBeNull();
  });

  it('serve an embedded picture only under a raster image type', async () => {
    directory = await mkdtemp(join(tmpdir(), 'squiggly-local-'));
    const cover = png();
    const served = async (name: string, type: string) => {
      const path = join(directory!, name);
      await writeFile(path, flac({ TITLE: name }, cover, type));
      const [track] = await readLocalTracks([path]);
      return readLocalCover(track.coverArt!);
    };
    expect(await served('svg.flac', 'image/svg+xml')).toBeNull();
    expect(await served('html.flac', 'text/html')).toBeNull();
    // A common misspelling in taggers, served under its proper name.
    expect(await served('jpg.flac', 'image/JPG')).toEqual({ bytes: cover, contentType: 'image/jpeg' });
  });
});
