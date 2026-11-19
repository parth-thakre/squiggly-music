import { afterEach, expect, it } from 'vitest';
import type { Result } from '../packages/core/contracts';
import { drop, isStale, load, notKept, peek, playReported, resetLibraryCaches } from '../apps/desktop/renderer/src/app/library';

// The desktop answers library reads with what it kept first, then the server's. An artist's page
// reads every record of theirs, and the desktop refuses past 32 requests in flight, a Pause among
// them: kept answers are read six at a time, as the server's are.

afterEach(() => { resetLibraryCaches(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const never = <T,>() => new Promise<Result<T>>(() => undefined);

function slowKept() {
  let open = 0, most = 0, calls = 0;
  const finish: (() => void)[] = [];
  const kept = (value: string) => () => new Promise<Result<string>>(resolve => {
    calls++; open++; most = Math.max(most, open);
    finish.push(() => { open--; resolve(ok(value)); });
  });
  const settle = async () => { while (finish.length || open) { finish.splice(0).forEach(done => done()); await tick(); } };
  return { kept, most: () => most, calls: () => calls, settle };
}

it('reads at most six kept answers at once, and each shows', async () => {
  const kept = slowKept();
  const reads = Array.from({ length: 40 }, (_, i) => load(`album:k${i}`, never<string>, kept.kept(`kept ${i}`)));
  await tick();
  expect(kept.most()).toBe(6);
  await kept.settle();
  expect((await Promise.all(reads)).map(r => r.ok && r.value)).toEqual(Array.from({ length: 40 }, (_, i) => `kept ${i}`));
  expect(kept.most()).toBe(6);
});

it("doesn't read what was kept once the server has answered while it waited", async () => {
  const kept = slowKept();
  const waiting = Array.from({ length: 6 }, (_, i) => load(`album:w${i}`, never<string>, kept.kept('kept')));
  const answered = load('album:fast', async () => ok('fresh'), kept.kept('kept'));
  expect(await answered).toEqual(ok('fresh'));
  await kept.settle();
  await Promise.all(waiting);
  expect(kept.calls()).toBe(6);
});

// A play the server has been told of changes its song's count: the next look at its record, or at
// any artist's songs (Most played), reads them again. What a page shows now stays.
it('a reported play forgets its record and every artist\'s songs, and nothing else', async () => {
  let reads = 0;
  const album = (id: string) => load(`album:${id}`, async () => { reads++; return ok(`${id} ${reads}`); });
  await album('a'); await album('b');
  await load('artistTracks:ar', async () => ok(['a-1']));
  await load('artistTracks:other', async () => ok(['b-1']));
  await tick();
  playReported({ albumId: 'a' });
  expect(peek('album:a')).toBeUndefined();
  expect(peek('artistTracks:ar')).toBeUndefined();
  expect(peek('artistTracks:other')).toBeUndefined();
  expect(peek('album:b')).toEqual(ok('b 2'));
  expect(await album('a')).toEqual(ok('a 3'));
  expect(await album('b')).toEqual(ok('b 2'));
});

// A server answer the test gives when it chooses.
function held<T>() {
  let give: (result: Result<T>) => void = () => undefined;
  const asked = new Promise<Result<T>>(resolve => { give = resolve; });
  return { loader: () => asked, give };
}

// What the host kept predates the play, so the next look at the song's record and artists waits
// for the server, once; the kept answer shows only if the server can't answer.
it('after a reported play, the next read of its record and artists waits for the server though an answer was kept', async () => {
  expect(await load('album:x', async () => ok('before'), async () => ok('before'))).toEqual(ok('before'));
  expect(await load('artist:guest', async () => ok('guest before'), async () => ok('guest before'))).toEqual(ok('guest before'));
  await tick();
  playReported({ albumId: 'x', artistId: 'main', artists: [{ id: 'guest', name: 'Guest' }] });
  expect(peek('artist:guest')).toBeUndefined();
  const server = held<string>(), artist = held<string>();
  const record = load('album:x', server.loader, async () => ok('kept before'));
  const guest = load('artist:guest', artist.loader, async () => ok('guest kept before'));
  await tick(); await tick();
  server.give(ok('after')); artist.give(ok('guest after'));
  expect(await record).toEqual(ok('after'));
  expect(await guest).toEqual(ok('guest after'));
  // Once: dropped again, the kept answer shows first as before.
  await tick();
  drop('album:x');
  expect(await load('album:x', never<string>, async () => ok('kept'))).toEqual(ok('kept'));
});

it('after a reported play, a record the server can\'t read shows what was kept, marked stale', async () => {
  playReported({ albumId: 'away' });
  expect(await load('album:away', async () => ({ ok: false, error: 'away' }) as Result<string>, async () => ok('kept'))).toEqual(ok('kept'));
  expect(isStale('album:away')).toBe(true);
});

it('a read of the record already on its way when the play is reported lands', async () => {
  const server = held<string>();
  const shown = load('album:y', server.loader, async () => ok('kept'));
  expect(await shown).toEqual(ok('kept'));
  playReported({ albumId: 'y' });
  server.give(ok('fresh'));
  await tick();
  expect(peek('album:y')).toEqual(ok('fresh'));
});

it('lets go of one answer by its whole key, not every key it begins', async () => {
  await load('artistTracks:a1', async () => ok(1));
  await load('artistTracks:a10', async () => ok(10));
  await tick();
  drop('artistTracks:a1');
  expect(peek('artistTracks:a1')).toBeUndefined();
  expect(peek('artistTracks:a10')).toEqual(ok(10));
});

// Songs put together from what was kept for a record the server couldn't read are shown, and not
// kept for the next page, which reads that record again.
it('marks what was kept as stale when the server fails, and keeps no answer marked notKept', async () => {
  const shown = await load('album:away', async () => ({ ok: false, error: 'away' }) as Result<string>, async () => ok('kept'));
  expect(shown).toEqual(ok('kept'));
  // Already, as the songs are put together straight after (menu.tsx tracksOf).
  expect(isStale('album:away')).toBe(true);
  let builds = 0;
  const songs = () => load('artistTracks:ar', async () => { builds++; return isStale('album:away') ? notKept(ok(['kept'])) : ok(['fresh']); });
  expect(await songs()).toEqual(ok(['kept']));
  await tick();
  expect(peek('artistTracks:ar')).toBeUndefined();
  await songs();
  expect(builds).toBe(2);
});
