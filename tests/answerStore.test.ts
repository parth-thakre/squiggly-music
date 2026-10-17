import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Result } from '../packages/core/contracts';
import { storedKey } from '../packages/core/stored';
import { AnswerStore } from '../apps/desktop/main/answerStore';
import { invalidate, load, peek, resetLibraryCaches } from '../apps/desktop/renderer/src/app/library';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'squiggly-answers-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function store(version = '1.0.0') {
  const answers = new AnswerStore(join(dir, 'library'), version);
  await answers.bind('https://music.example\nada');
  return answers;
}

describe('library answers kept on this computer', () => {
  it('keeps what describes the library, and no searches, random draws, or edits', () => {
    expect(storedKey('artist', ['a1'])).toBe('artist\n["a1"]');
    expect(storedKey('albums', ['newest', 0, 12])).not.toBeNull();
    expect(storedKey('albums', ['random', 0, 12])).toBeNull();
    for (const method of ['search', 'randomSongs', 'nowPlaying', 'shares', 'star', 'savedQueue', 'playlist']) expect(storedKey(method, [])).toBeNull();
  });

  it('answers after a restart with what the server last said', async () => {
    const answers = await store();
    await answers.write('artist\n["a1"]', { artist: { id: 'a1' }, albums: [] });
    expect(await answers.read('artist\n["a1"]')).toEqual({ artist: { id: 'a1' }, albums: [] });
    const again = await store();
    expect(await again.read('artist\n["a1"]')).toEqual({ artist: { id: 'a1' }, albums: [] });
    expect(await again.read('artist\n["a2"]')).toBeUndefined();
  });

  it('passes over what another version wrote', async () => {
    await (await store('1.0.0')).write('genres\n[]', [{ name: 'Jazz' }]);
    expect(await (await store('1.1.0')).read('genres\n[]')).toBeUndefined();
  });

  it('removes another account’s answers, and everything on sign-out', async () => {
    const answers = await store();
    await answers.write('genres\n[]', [{ name: 'Jazz' }]);
    await answers.bind('https://music.example\nbea');
    expect(await answers.read('genres\n[]')).toBeUndefined();
    expect(await readdir(join(dir, 'library'))).toHaveLength(0);
    await answers.write('genres\n[]', [{ name: 'Folk' }]);
    await answers.clear();
    expect(existsSync(join(dir, 'library'))).toBe(false);
    expect(await answers.read('genres\n[]')).toBeUndefined();
  });
});

describe('pages showing kept answers', () => {
  afterEach(() => resetLibraryCaches());
  const later = <T,>(value: T, ms: number) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
  const ok = <T,>(value: T): Result<T> => ({ ok: true, value });

  it('shows the kept answer first, then the server’s when it differs', async () => {
    const kept = ok(['old']);
    expect(await load('k1', () => later(ok(['new']), 20), () => later(kept, 1))).toBe(kept);
    await later(null, 30);
    expect(peek<string[]>('k1')).toEqual(ok(['new']));
  });

  it('keeps showing the kept answer when the server says the same', async () => {
    const kept = ok(['same']);
    await load('k2', () => later(ok(['same']), 20), () => later(kept, 1));
    await later(null, 30);
    expect(peek('k2')).toBe(kept);
  });

  it('takes the server’s answer when it comes first, or nothing is kept', async () => {
    expect(await load('k3', () => later(ok(['fresh']), 1), () => later(ok(['old']), 20))).toEqual(ok(['fresh']));
    await later(null, 30);
    expect(peek('k3')).toEqual(ok(['fresh']));
    expect(await load('k4', () => later(ok(['fresh']), 5), () => later<Result<string[]>>({ ok: false, error: 'Not kept' }, 1))).toEqual(ok(['fresh']));
  });

  it('waits for the server once the item has changed here, rather than show it as it was', async () => {
    await load('album:a1', () => later(ok(['rated 0']), 5));
    invalidate('album:a1');
    expect(await load('album:a1', () => later(ok(['rated 4']), 20), () => later(ok(['rated 0']), 1))).toEqual(ok(['rated 4']));
  });

  it('keeps the kept answer while the server is away, and asks again next time', async () => {
    const kept = ok(['old']);
    let asked = 0;
    const away = () => { asked++; return later<Result<string[]>>({ ok: false, error: 'Away' }, 5); };
    expect(await load('k5', away, () => later(kept, 1))).toBe(kept);
    await later(null, 10);
    expect(peek('k5')).toBe(kept);
    expect(await load('k5', away, () => later(kept, 1))).toBe(kept);
    expect(asked).toBe(2);
  });
});
