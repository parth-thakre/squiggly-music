import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoverCache, FRESH_MS } from '../apps/desktop/main/coverCache';

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
async function cache(maxBytes?: number) {
  dir = await mkdtemp(join(tmpdir(), 'squiggly-covers-'));
  const clock = { now: 1_000_000 };
  const covers = new CoverCache(join(dir, 'covers'), () => clock.now, maxBytes);
  await covers.bind('https://music.example\nada');
  return { covers, clock };
}
const sleeve = (fill: number, length = 1000) => ({ bytes: new Uint8Array(length).fill(fill), contentType: 'image/jpeg' });

describe('sleeves kept on this computer', () => {
  it('keeps each sleeve at each size, after a restart too', async () => {
    const { covers, clock } = await cache();
    expect(await covers.read('al-1', 300)).toBeNull();
    await covers.write('al-1', 300, sleeve(1));
    await covers.write('al-1', 600, sleeve(2, 2000));
    expect(await covers.read('al-1', 300)).toEqual(sleeve(1));
    expect(await covers.read('al-1', 600)).toEqual(sleeve(2, 2000));
    expect(await covers.read('al-1', 160)).toBeNull();
    const again = new CoverCache(join(dir, 'covers'), () => clock.now);
    await again.bind('https://music.example\nada');
    expect(await again.read('al-1', 300)).toEqual(sleeve(1));
  });

  it('asks again for a sleeve kept longer than two weeks', async () => {
    const { covers, clock } = await cache();
    await covers.write('al-1', 300, sleeve(1));
    clock.now += FRESH_MS;
    expect(await covers.read('al-1', 300)).toEqual(sleeve(1));
    clock.now += 1;
    expect(await covers.read('al-1', 300)).toBeNull();
  });

  it('keeps nothing but images, and reads a damaged file as nothing', async () => {
    const { covers } = await cache();
    await covers.write('al-1', 300, { bytes: new Uint8Array([1, 2, 3]), contentType: 'text/html' });
    expect(await covers.read('al-1', 300)).toBeNull();
    await covers.write('al-2', 300, sleeve(1));
    const folder = join(dir, 'covers', (await readdir(join(dir, 'covers')))[0]);
    for (const name of await readdir(folder)) await writeFile(join(folder, name), 'image/jpeg\n');
    expect(await covers.read('al-2', 300)).toBeNull();
  });

  it('lets the sleeves shown longest ago go past the size limit', async () => {
    const { covers, clock } = await cache(2500);
    await covers.write('a', 300, sleeve(1));
    clock.now += 1000; await covers.write('b', 300, sleeve(2));
    await new Promise(resolve => setTimeout(resolve, 20));
    // a is shown again, so b is now the one shown longest ago.
    await covers.read('a', 300);
    clock.now += 1000; await covers.write('c', 300, sleeve(3));
    await covers.trim();
    expect(await covers.read('a', 300)).not.toBeNull();
    expect(await covers.read('b', 300)).toBeNull();
    expect(await covers.read('c', 300)).not.toBeNull();
  });

  it('removes another account\'s sleeves, and all of them on sign-out', async () => {
    const { covers } = await cache();
    await covers.write('al-1', 300, sleeve(1));
    await covers.bind('https://music.example\nbo');
    expect(await covers.read('al-1', 300)).toBeNull();
    expect(await readdir(join(dir, 'covers'))).toHaveLength(0);
    await covers.write('al-2', 300, sleeve(2));
    await covers.clear();
    expect(existsSync(join(dir, 'covers'))).toBe(false);
    expect(await covers.read('al-2', 300)).toBeNull();
  });
});
