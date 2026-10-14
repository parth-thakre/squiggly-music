import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Lyrics } from '../packages/core/contracts';
import { FOUND_MS, LyricsCache, NONE_MS } from '../apps/desktop/main/lyricsCache';

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
async function cache() {
  dir = await mkdtemp(join(tmpdir(), 'squiggly-lyrics-'));
  const clock = { now: 1_000_000 };
  const lyrics = new LyricsCache(join(dir, 'lyrics'), () => clock.now);
  await lyrics.bind('https://music.example\nada');
  return { lyrics, clock };
}
const sung = (source: Lyrics['source'], text = 'la la'): Lyrics => ({ synced: true, lines: [{ start: 1, text }], wordTiming: null, source });
// An ask that counts its calls and answers in turn.
function asker(...answers: (Lyrics | null | Error)[]) {
  const ask = async () => {
    ask.calls++;
    const answer = answers[Math.min(ask.calls, answers.length) - 1];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  ask.calls = 0;
  return ask;
}

describe('lyrics kept on this computer', () => {
  it('asks once, then answers from what it kept, after a restart too', async () => {
    const { lyrics, clock } = await cache();
    const ask = asker(sung('lrclib'));
    expect((await lyrics.answer('s1', true, ask, false)).lyrics).toEqual(sung('lrclib'));
    expect((await lyrics.answer('s1', true, ask, false)).lyrics).toEqual(sung('lrclib'));
    const again = new LyricsCache(join(dir, 'lyrics'), () => clock.now);
    await again.bind('https://music.example\nada');
    expect((await again.answer('s1', true, ask, false)).lyrics).toEqual(sung('lrclib'));
    expect(ask.calls).toBe(1);
  });

  it('asks again for found lyrics after 30 days and for none after a day', async () => {
    const { lyrics, clock } = await cache();
    const found = asker(sung('server'), sung('server', 'new words'));
    await lyrics.answer('s1', false, found, false);
    clock.now += FOUND_MS - 1;
    expect((await lyrics.answer('s1', false, found, false)).lyrics).toEqual(sung('server'));
    clock.now += 2;
    expect((await lyrics.answer('s1', false, found, false)).lyrics).toEqual(sung('server', 'new words'));
    const none = asker(null, sung('lrclib'));
    await lyrics.answer('s2', true, none, false);
    expect((await lyrics.answer('s2', true, none, false)).lyrics).toBeNull();
    clock.now += NONE_MS;
    expect((await lyrics.answer('s2', true, none, false)).lyrics).toEqual(sung('lrclib'));
    expect([found.calls, none.calls]).toEqual([2, 2]);
  });

  it('answers by the lookup setting: LRCLIB lyrics only with it on, none from the server alone not for it', async () => {
    const { lyrics } = await cache();
    await lyrics.answer('s1', true, asker(sung('lrclib')), false);
    const off = asker(null);
    expect((await lyrics.answer('s1', false, off, false)).lyrics).toBeNull();
    expect(off.calls).toBe(1);
    // None from the server alone: turning lookup on asks LRCLIB.
    await lyrics.answer('s2', false, asker(null), false);
    const on = asker(sung('lrclib'));
    expect((await lyrics.answer('s2', true, on, false)).lyrics).toEqual(sung('lrclib'));
    expect(on.calls).toBe(1);
    // Server lyrics answer either way.
    await lyrics.answer('s3', true, asker(sung('server')), false);
    const either = asker(null);
    expect((await lyrics.answer('s3', false, either, false)).lyrics).toEqual(sung('server'));
    expect(either.calls).toBe(0);
  });

  it('falls back to old lyrics when asking fails or the server is away, and keeps no failures', async () => {
    const { lyrics, clock } = await cache();
    await lyrics.answer('s1', true, asker(sung('lrclib')), false);
    clock.now += FOUND_MS * 3;
    const busy = new Error('The lyrics service is busy.');
    expect(await lyrics.answer('s1', true, asker(busy), false)).toEqual({ lyrics: sung('lrclib'), failed: busy });
    const away = asker(busy);
    expect((await lyrics.answer('s1', true, away, true)).lyrics).toEqual(sung('lrclib'));
    expect(away.calls).toBe(0);
    await expect(lyrics.answer('s2', true, asker(busy), false)).rejects.toBe(busy);
    const later = asker(sung('lrclib'));
    expect((await lyrics.answer('s2', true, later, false)).lyrics).toEqual(sung('lrclib'));
    expect(later.calls).toBe(1);
  });

  it('asks once for requests that arrive together', async () => {
    const { lyrics } = await cache();
    const ask = asker(sung('server'));
    const answers = await Promise.all([lyrics.answer('s1', true, ask, false), lyrics.answer('s1', true, ask, false)]);
    expect(answers.map(answer => answer.lyrics)).toEqual([sung('server'), sung('server')]);
    expect(ask.calls).toBe(1);
  });

  it('removes another account’s lyrics, and all of them on sign-out', async () => {
    const { lyrics } = await cache();
    await lyrics.answer('s1', true, asker(sung('server')), false);
    await lyrics.bind('https://music.example\nbea');
    expect(await readdir(join(dir, 'lyrics'))).toEqual([]);
    const ask = asker(null);
    expect((await lyrics.answer('s1', true, ask, false)).lyrics).toBeNull();
    expect(ask.calls).toBe(1);
    await lyrics.clear();
    expect(existsSync(join(dir, 'lyrics'))).toBe(false);
    // Signed out: nothing is kept.
    await lyrics.answer('s1', true, asker(sung('server')), false);
    expect(existsSync(join(dir, 'lyrics'))).toBe(false);
  });

  it('ignores a kept file that is damaged', async () => {
    const { lyrics } = await cache();
    await lyrics.answer('s1', true, asker(sung('server')), false);
    const [folder] = await readdir(join(dir, 'lyrics'));
    const [file] = await readdir(join(dir, 'lyrics', folder));
    await writeFile(join(dir, 'lyrics', folder, file), '{"id":"s1","lyrics":');
    const ask = asker(sung('server', 'again'));
    expect((await lyrics.answer('s1', true, ask, false)).lyrics).toEqual(sung('server', 'again'));
  });
});
