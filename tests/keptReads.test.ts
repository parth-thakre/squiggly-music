import { afterEach, expect, it } from 'vitest';
import type { Result } from '../packages/core/contracts';
import { assemble, forget, load, peek, resetLibraryCaches } from '../apps/desktop/renderer/src/app/library';

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

// An artist's songs are put together from their records' answers. When the server's answers come
// after what was kept, the songs are put together again, so Most played isn't a session behind.
type Detail = { tracks: { id: string; playCount: number }[] };
function records(ids: string[], held: Record<string, Promise<void>> = {}) {
  const fresh = new Map<string, (r: Result<Detail>) => void>();
  const read = (id: string, plays: number) => load<Detail>(`album:${id}`,
    () => new Promise(resolve => fresh.set(id, resolve)),
    async () => { await held[id]; return ok({ tracks: [{ id: `${id}-1`, playCount: plays }] }); });
  const songs = () => load('artistTracks:ar', async () => {
    const details = await Promise.all(ids.map(id => read(id, 1)));
    return assemble('artistTracks:ar', ids.map(id => `album:${id}`), details,
      held => ok(held.flatMap(d => d.ok ? d.value.tracks : [])));
  });
  const answer = (id: string, plays: number) => fresh.get(id)!(ok({ tracks: [{ id: `${id}-1`, playCount: plays }] }));
  return { songs, answer };
}
const counts = () => (peek<Detail['tracks']>('artistTracks:ar') as { value: Detail['tracks'] } | undefined)?.value.map(t => t.playCount);

it("puts an artist's songs together again as their records' fresh answers come", async () => {
  const { songs, answer } = records(['a', 'b']);
  const first = await songs();
  expect(first.ok && first.value.map(t => t.playCount)).toEqual([1, 1]);
  await tick();
  answer('a', 5); await tick();
  expect(counts()).toEqual([5, 1]);
  answer('b', 3); await tick();
  expect(counts()).toEqual([5, 3]);
  // Read again, they're the fresh ones.
  const again = await songs();
  expect(again.ok && again.value.map(t => t.playCount)).toEqual([5, 3]);
});

it('takes a fresh answer that came while the songs were being put together', async () => {
  let release = () => {};
  const { songs, answer } = records(['a', 'b'], { b: new Promise<void>(resolve => { release = resolve; }) });
  const reading = songs();
  await tick();
  // The first record's kept answer has shown, and its fresh one lands before the second's kept one.
  expect((peek<Detail>('album:a') as { value: Detail }).value.tracks[0].playCount).toBe(1);
  answer('a', 7); await tick();
  release();
  const first = await reading;
  expect(first.ok && first.value.map(t => t.playCount)).toEqual([7, 1]);
});

it('lets go of songs that were forgotten (a play counted): the next visit reads them again', async () => {
  const { songs, answer } = records(['a']);
  await songs(); await tick();
  forget('artistTracks:');
  answer('a', 9); await tick();
  expect(peek('artistTracks:ar')).toBeUndefined();
  const again = await songs();
  expect(again.ok && again.value.map(t => t.playCount)).toEqual([9]);
});
