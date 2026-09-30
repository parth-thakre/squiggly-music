import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Track } from '../packages/core/contracts';
import { keyOf, KEPT_LIMITS, KEPT_MESSAGES } from '../packages/core/kept';
import { KeptStore, keptFileName } from '../apps/desktop/main/keptStore';

let dir: string;
afterEach(async () => { vi.useRealTimers(); if (dir) await rm(dir, { recursive: true, force: true }); });
const fresh = async () => { dir = await mkdtemp(join(tmpdir(), 'squiggly-kept-')); return dir; };

export const song = (id: string, extra: Partial<Track> = {}): Track => ({
  id, title: `Song ${id}`, artist: 'Ada Brass', album: 'Test Pressing', duration: 120, source: 'navidrome',
  sourceFormat: 'flac', sourceSampleRate: 44100, sourceBitDepth: 16, albumId: 'al-1', coverArt: 'al-1', ...extra,
});
// A song whose file is in the folder, as the manager leaves it before adding the entry.
async function keepSong(store: KeptStore, id: string, bytes = 4, extra: Partial<Track> = {}) {
  const file = keptFileName('s', id, 'flac');
  await writeFile(join(store.dir, file), new Uint8Array(bytes).fill(7));
  store.addSong(song(id, extra), file, bytes);
  return file;
}
async function keepCover(store: KeptStore, id: string, bytes = 3) {
  const file = keptFileName('c', id, 'png');
  await writeFile(join(store.dir, file), new Uint8Array(bytes));
  store.addCover(id, file, bytes, 'image/png');
  return file;
}
const record = (id: string, trackIds: string[], kind: 'album' | 'playlist' | 'mix' = 'album') =>
  ({ kind, id, name: id, artist: null, coverArt: kind === 'album' ? 'al-1' : null, trackIds, keptAt: 1 });
const onDisk = async () => JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));

describe('kept index', () => {
  it('reads back what it wrote', async () => {
    const store = new KeptStore(await fresh());
    await store.load();
    await store.bind('host\nlistener');
    await keepSong(store, 'a', 5); await keepSong(store, 'b', 6); await keepCover(store, 'al-1');
    await store.setContainer(record('al-1', ['a', 'b']));
    await store.flush();
    const again = new KeptStore(dir);
    await again.load();
    expect(again.account).toBe('host\nlistener');
    expect(again.presentIds().sort()).toEqual(['a', 'b']);
    expect(again.usedBytes).toBe(14);
    expect(again.containers()).toEqual([{ kind: 'album', id: 'al-1', name: 'al-1', artist: null, coverArt: 'al-1', total: 2, present: 2, bytes: 11, keptAt: 1 }]);
    expect(again.detail('album', 'al-1')!.tracks.map(t => t.id)).toEqual(['a', 'b']);
    expect(again.notice).toBeNull();
    // No paths, addresses, or credentials in the index.
    expect(JSON.stringify(await onDisk())).not.toContain(dir);
  });
  it('writes whole or not at all: many writes at once always leave JSON and no temporary file', async () => {
    const store = new KeptStore(await fresh());
    await store.load();
    for (let i = 0; i < 20; i++) await keepSong(store, `s${i}`);
    await store.setContainer(record('al-1', Array.from({ length: 20 }, (_, i) => `s${i}`)));
    const reads: Promise<void>[] = [];
    const writes = Array.from({ length: 200 }, (_, i) => {
      if (i % 10 === 0) reads.push(readFile(join(dir, 'index.json'), 'utf8').then(text => { JSON.parse(text); }));
      return store.write();
    });
    await Promise.all([...writes, ...reads]);
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(Object.keys((await onDisk()).songs)).toHaveLength(20);
  });
  it('sweeps temporary, partial, and unnamed kept files at load, and nothing else', async () => {
    const store = new KeptStore(await fresh());
    await store.load();
    const kept = await keepSong(store, 'a');
    await store.setContainer(record('al-1', ['a']));
    const orphan = keptFileName('s', 'gone', 'mp3');
    const strays = [`${kept}.part`, 'index.json.1234.tmp', orphan, keptFileName('c', 'gone', 'jpg')];
    for (const name of [...strays, 'notes.txt', 's-not-ours.flac']) await writeFile(join(dir, name), 'x');
    await new KeptStore(dir).load();
    const left = await readdir(dir);
    for (const name of strays) expect(left).not.toContain(name);
    expect(left).toEqual(expect.arrayContaining([kept, 'notes.txt', 's-not-ours.flac', 'index.json']));
  });
  it('puts an unreadable or oversized index aside and says so once', async () => {
    await fresh();
    await writeFile(join(dir, 'index.json'), '{broken');
    const store = new KeptStore(dir);
    await store.load();
    expect(store.notice).toBe(KEPT_MESSAGES.broken);
    expect(store.songCount).toBe(0);
    expect(existsSync(join(dir, 'index.broken.json'))).toBe(true);
    await writeFile(join(dir, 'index.json'), Buffer.alloc(KEPT_LIMITS.readBytes + 1, 32));
    const big = new KeptStore(dir);
    await big.load();
    expect(big.notice).toBe(KEPT_MESSAGES.broken);
    expect((await readFile(join(dir, 'index.broken.json'))).length).toBe(KEPT_LIMITS.readBytes + 1);
    // A later load of the fresh index has nothing to say.
    const later = new KeptStore(dir);
    await later.load();
    expect(later.notice).toBeNull();
  });
  it('drops a bad entry and keeps the rest', async () => {
    const store = new KeptStore(await fresh());
    await store.load();
    await keepSong(store, 'a'); await keepSong(store, 'b'); await keepSong(store, 'c'); await keepSong(store, 'd', 4);
    await store.setContainer(record('al-1', ['a', 'b', 'c', 'd']));
    const index = await onDisk();
    index.songs.b.track.source = 'local';
    index.songs.c.file = '../x';
    index.songs.a.bytes = 99;
    index.songs.e = { ...index.songs.d, track: { ...index.songs.d.track, id: 'other' } };
    index.songs[''] = index.songs.d;
    index.songs.f = { ...index.songs.d, file: 's-XYZ.flac' };
    index.containers.push({ kind: 'song', id: 'x', name: 'x', artist: null, coverArt: null, trackIds: [], keptAt: 1 });
    await writeFile(join(dir, 'index.json'), JSON.stringify(index));
    const again = new KeptStore(dir);
    await again.load();
    expect(again.presentIds()).toEqual(['d']);
    expect(again.notice).toBeNull();
    expect(again.containers()).toHaveLength(1);
    expect(again.containers()[0]).toMatchObject({ total: 4, present: 1 });
  });
  it('keeps the newest 20,000 songs of a longer index', async () => {
    await fresh();
    const file = keptFileName('s', 'shared', 'flac');
    await writeFile(join(dir, file), 'x');
    const songs: Record<string, unknown> = {};
    for (let i = 0; i <= KEPT_LIMITS.songs; i++) songs[`t${i}`] = { track: song(`t${i}`), file, bytes: 1, keptAt: i + 1 };
    await writeFile(join(dir, 'index.json'), JSON.stringify({ version: 1, account: null, songs, containers: [], covers: {} }));
    const store = new KeptStore(dir);
    await store.load();
    expect(store.songCount).toBe(KEPT_LIMITS.songs);
    expect(store.has('t0')).toBe(false);
    expect(store.has(`t${KEPT_LIMITS.songs}`)).toBe(true);
  }, 30_000);
  it('writes the index before deleting a file, and leaves a file in use for the next sweep', async () => {
    await fresh();
    const unlink = vi.fn(async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); });
    const store = new KeptStore(dir, { unlink });
    await store.load();
    const file = await keepSong(store, 'a');
    await store.setContainer(record('al-1', ['a']));
    const orphans = await store.removeContainer('album', 'al-1');
    expect((await onDisk()).songs).toEqual({});
    await store.remove(orphans);
    expect(unlink).toHaveBeenCalled();
    expect(existsSync(join(dir, file))).toBe(true);
    await new KeptStore(dir).load();
    expect(existsSync(join(dir, file))).toBe(false);
  });
  it('keeps a song another container lists, and a cover while something refers to it', async () => {
    const store = new KeptStore(await fresh());
    await store.load();
    // Containers first, as the manager admits them; the files and entries follow.
    await store.setContainer(record('al-1', ['a', 'b']));
    await store.setContainer(record('pl-1', ['b', 'c'], 'playlist'));
    await keepSong(store, 'a'); await keepSong(store, 'b'); await keepSong(store, 'c', 4, { coverArt: 'al-2' });
    await keepCover(store, 'al-1'); await keepCover(store, 'al-2');
    let orphans = await store.removeContainer('album', 'al-1');
    expect(orphans.map(o => `${o.kind}:${o.id}`).sort()).toEqual(['song:a']);
    // al-1 is still b's cover; al-2 is c's.
    expect(store.hasCover('al-1')).toBe(true);
    orphans = await store.removeContainer('playlist', 'pl-1');
    expect(orphans.map(o => `${o.kind}:${o.id}`).sort()).toEqual(['cover:al-1', 'cover:al-2', 'song:b', 'song:c']);
    expect(store.usedBytes).toBe(0);
  });
  it('belongs to one account: the same one, or the same over HTTP and HTTPS, keeps everything; another forgets it', async () => {
    const store = new KeptStore(await fresh());
    await store.load();
    const key = keyOf('https://Music.Example.com/navidrome/', 'listener');
    expect(keyOf('http://music.example.com/navidrome', 'listener')).toBe(key);
    await store.bind(key);
    const file = await keepSong(store, 'a');
    await store.setContainer(record('al-1', ['a']));
    await store.bind(key);
    expect(store.has('a')).toBe(true);
    await store.bind(keyOf('https://music.example.com/navidrome', 'someone-else'));
    expect(store.songCount).toBe(0);
    expect(store.containers()).toEqual([]);
    expect(existsSync(join(dir, file))).toBe(false);
  });
  it('writes a dirty index at most every two seconds, and at once on flush', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const store = new KeptStore(await fresh());
    await store.load();
    const write = vi.spyOn(store, 'write');
    for (let i = 0; i < 5; i++) await keepSong(store, `t${i}`);
    expect(write).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) await keepSong(store, `u${i}`);
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(2);
    await keepSong(store, 'late');
    await store.flush();
    expect(write).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).toHaveBeenCalledTimes(3);
  });
  it('finds a kept file only while it is there with its size, and forgets it otherwise', async () => {
    const store = new KeptStore(await fresh());
    await store.load();
    const a = await keepSong(store, 'a'); const b = await keepSong(store, 'b');
    await store.setContainer(record('al-1', ['a', 'b']));
    expect(store.locate('a')).toBe(join(dir, a));
    await rm(join(dir, a));
    expect(store.locate('a')).toBeNull();
    expect(store.has('a')).toBe(false);
    await writeFile(join(dir, b), 'longer than before');
    expect(store.locate('b')).toBeNull();
    expect(store.containers()[0]).toMatchObject({ present: 0, total: 2 });
  });
});
