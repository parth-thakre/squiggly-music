import { afterEach, expect, it } from 'vitest';
import type { AlbumDetail, Result } from '../packages/core/contracts';
import { albumDetail, albumDetails, api, resetLibraryCaches } from '../apps/desktop/renderer/src/app/library';

// Records' songs are read six at a time across the whole page: Home's three mixes asked for 32 at
// once, and the desktop refuses past 32 requests in flight ("Too many pending operations").

const real = api.album;
afterEach(() => { api.album = real; resetLibraryCaches(); });

function slowAlbums() {
  let open = 0, most = 0, calls = 0;
  const finish: (() => void)[] = [];
  api.album = id => new Promise<Result<AlbumDetail>>(resolve => {
    calls++; open++; most = Math.max(most, open);
    finish.push(() => { open--; resolve({ ok: true, value: { album: { id, name: id, artist: '', songCount: 0 }, tracks: [] } as unknown as AlbumDetail }); });
  });
  const settle = async () => { while (finish.length || open) { finish.splice(0).forEach(done => done()); await new Promise(resolve => setTimeout(resolve, 0)); } };
  return { most: () => most, calls: () => calls, settle };
}
const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);

it('reads at most six records at once across every caller, and each one once', async () => {
  const albums = slowAlbums();
  // Home's three mixes at once: 12, 10, and 10 records, two of them shared.
  const reads = [albumDetails(ids('new', 12)), albumDetails(ids('often', 10)), albumDetails([...ids('lately', 8), 'new0', 'often0'])];
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(albums.most()).toBe(6);
  await albums.settle();
  const [newest, often, lately] = await Promise.all(reads);
  expect([newest.length, often.length, lately.length]).toEqual([12, 10, 10]);
  expect([...newest, ...often, ...lately].every(result => result.ok)).toBe(true);
  expect(albums.most()).toBe(6);
  expect(albums.calls()).toBe(30);
  // Read already: no wait for a slot.
  expect((await albumDetail('new3')).ok).toBe(true);
  expect(albums.calls()).toBe(30);
});
