import { describe, expect, it } from 'vitest';
import { applyQueue, planQueue } from '../apps/android/web/queue';
import { shuffleOrder } from '../packages/core/playOrder';

const ids = (count: number, prefix = 'e') => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
const apply = (before: string[], after: string[]) => applyQueue(before, planQueue(before, after), id => id);
// A small seeded generator, so a failure names a case that can be run again.
function random(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

describe('mirroring the queue to the native player', () => {
  it('sends nothing when nothing changed', () => {
    expect(planQueue(ids(5), ids(5))).toEqual([]);
    expect(planQueue([], [])).toEqual([]);
  });
  it('replaces a queue that shares no entries with the last one', () => {
    expect(planQueue(ids(3), ids(4, 'n'))).toEqual([{ type: 'replace', ids: ids(4, 'n') }]);
    expect(planQueue([], ids(2))).toEqual([{ type: 'replace', ids: ids(2) }]);
    expect(planQueue(ids(2), [])).toEqual([{ type: 'replace', ids: [] }]);
  });
  it('adds songs next, at the end, and from radio in one step', () => {
    const before = ids(5);
    expect(planQueue(before, [...before.slice(0, 3), 'x', 'y', ...before.slice(3)])).toEqual([{ type: 'insert', at: 3, ids: ['x', 'y'] }]);
    expect(planQueue(before, [...before, 'x', 'y', 'z'])).toEqual([{ type: 'insert', at: 5, ids: ['x', 'y', 'z'] }]);
  });
  it('removes runs of songs from the end first, so indexes stay right', () => {
    const before = ids(8);
    const after = before.filter((_, i) => ![1, 2, 5].includes(i));
    expect(planQueue(before, after)).toEqual([{ type: 'remove', from: 5, count: 1 }, { type: 'remove', from: 1, count: 2 }]);
    expect(apply(before, after)).toEqual(after);
  });
  it('moves one dragged song in one step, up or down the queue', () => {
    const before = ids(10);
    const down = [...before]; down.splice(8, 0, ...down.splice(2, 1));
    const up = [...before]; up.splice(1, 0, ...up.splice(7, 1));
    expect(planQueue(before, down)).toEqual([{ type: 'move', from: 2, to: 8 }]);
    expect(planQueue(before, up)).toEqual([{ type: 'move', from: 7, to: 1 }]);
    const last = [...before]; last.push(...last.splice(0, 1));
    expect(planQueue(before, last)).toEqual([{ type: 'move', from: 0, to: 9 }]);
  });
  it('keeps the entry that plays when the queue is cleared around it', () => {
    const before = ids(6);
    expect(planQueue(before, ['e3'])).toEqual([{ type: 'remove', from: 4, count: 2 }, { type: 'remove', from: 0, count: 3 }]);
  });
  it('turns any queue into any other that shares entries with it', () => {
    const next = random(42);
    for (let round = 0; round < 500; round++) {
      const before = ids(Math.floor(next() * 30) + 1);
      // Keep some, shuffle a little, and add some new ones in between.
      let after = before.filter(() => next() > .3);
      for (let swaps = Math.floor(next() * 4); swaps > 0; swaps--) {
        const a = Math.floor(next() * after.length), b = Math.floor(next() * after.length);
        after.splice(b, 0, ...after.splice(a, 1));
      }
      after = after.flatMap((id, i) => next() > .85 ? [`new${round}-${i}`, id] : [id]);
      if (next() > .7) after.push(`tail${round}`);
      expect(apply(before, after), `round ${round}`).toEqual(after);
    }
  });
  it('sends a shuffle as moves only, so the song playing and those before it never leave', () => {
    const next = random(9);
    for (let round = 0; round < 200; round++) {
      const before = ids(Math.floor(next() * 40) + 2);
      const current = Math.floor(next() * before.length);
      // As the page shuffles (player.shuffle): by the shared order, the current entry in place.
      const after = shuffleOrder(before.length, current, next).map(i => before[i]);
      const ops = planQueue(before, after);
      expect(ops.every(op => op.type === 'move'), `round ${round}`).toBe(true);
      expect(ops.every(op => op.type === 'move' && op.from > current && op.to > current), `round ${round}`).toBe(true);
      expect(apply(before, after), `round ${round}`).toEqual(after);
    }
  });
});
