import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { following, nextRepeat, preceding, shuffleOrder } from '../packages/core/playOrder';
import { CommandSchema } from '../packages/core/validation';
import { defaultPlayModes, PlayModesSchema } from '../packages/core/desktopValidation';

// A small seeded generator, so a failure names a case that can be run again.
function random(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

describe('what plays next', () => {
  it('stops after the last song with repeat off', () => {
    expect(following(0, 3, 'off', 'ended')).toBe(1);
    expect(following(2, 3, 'off', 'ended')).toBe(-1);
    expect(following(2, 3, 'off', 'skip')).toBe(-1);
  });
  it('wraps from the last song to the first with repeat all, finished or skipped', () => {
    expect(following(1, 3, 'all', 'ended')).toBe(2);
    expect(following(2, 3, 'all', 'ended')).toBe(0);
    expect(following(2, 3, 'all', 'skip')).toBe(0);
    // One song repeating on its own.
    expect(following(0, 1, 'all', 'ended')).toBe(0);
  });
  it('plays a finished song again with repeat one, while Next still moves on', () => {
    expect(following(1, 3, 'one', 'ended')).toBe(1);
    expect(following(2, 3, 'one', 'ended')).toBe(2);
    expect(following(1, 3, 'one', 'skip')).toBe(2);
    expect(following(2, 3, 'one', 'skip')).toBe(-1);
  });
  it('has nothing to follow an empty queue or no current song', () => {
    for (const repeat of ['off', 'all', 'one'] as const) {
      expect(following(0, 0, repeat, 'ended')).toBe(-1);
      expect(following(-1, 3, repeat, 'skip')).toBe(-1);
      expect(preceding(-1, 3, repeat)).toBe(-1);
    }
  });
  it('goes back from the first song to the last only with repeat all', () => {
    expect(preceding(2, 3, 'off')).toBe(1);
    expect(preceding(0, 3, 'off')).toBe(-1);
    expect(preceding(0, 3, 'one')).toBe(-1);
    expect(preceding(0, 3, 'all')).toBe(2);
    expect(preceding(0, 1, 'all')).toBe(-1);
  });
  it('cycles repeat off, all, one', () => {
    expect([nextRepeat('off'), nextRepeat('all'), nextRepeat('one')]).toEqual(['all', 'one', 'off']);
  });
});

describe('shuffling', () => {
  it('keeps the current song and the songs already played in place', () => {
    const next = random(7);
    for (let round = 0; round < 300; round++) {
      const length = Math.floor(next() * 40) + 1;
      const current = Math.floor(next() * length);
      const order = shuffleOrder(length, current, next);
      expect(order.slice(0, current + 1), `round ${round}`).toEqual(Array.from({ length: current + 1 }, (_, i) => i));
      // Every later song is still there, once.
      expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length }, (_, i) => i));
    }
  });
  it('moves the songs after the current one', () => {
    const order = shuffleOrder(50, 9, random(3));
    expect(order.slice(10)).not.toEqual(Array.from({ length: 40 }, (_, i) => i + 10));
  });
  it('shuffles everything with nothing current, and leaves a short tail alone', () => {
    const order = shuffleOrder(30, -1, random(11));
    expect(order).not.toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(shuffleOrder(4, 3, random(1))).toEqual([0, 1, 2, 3]);
    expect(shuffleOrder(0, -1)).toEqual([]);
  });
  it('reaches every order of the upcoming songs', () => {
    const next = random(5);
    const seen = new Set<string>();
    for (let i = 0; i < 600; i++) seen.add(shuffleOrder(4, 0, next).join());
    // The three songs after the first can come in any of 3! orders.
    expect(seen.size).toBe(6);
  });
});

describe('play mode requests', () => {
  const decode = Schema.decodeUnknownSync(CommandSchema);
  it('accepts the three repeat modes and a shuffle switch, and nothing else', () => {
    for (const mode of ['off', 'all', 'one']) expect(decode({ type: 'repeat', mode })).toEqual({ type: 'repeat', mode });
    expect(decode({ type: 'shuffle', on: true })).toEqual({ type: 'shuffle', on: true });
    expect(() => decode({ type: 'repeat', mode: 'twice' })).toThrow();
    expect(() => decode({ type: 'repeat' })).toThrow();
    expect(() => decode({ type: 'shuffle', on: 'yes' })).toThrow();
  });
  it('reads a saved file with defaults for missing keys and refuses a bad one', () => {
    const read = Schema.decodeUnknownEither(PlayModesSchema);
    expect(defaultPlayModes()).toEqual({ repeat: 'off', shuffle: false });
    expect(read({ repeat: 'one' })).toMatchObject({ right: { repeat: 'one', shuffle: false } });
    expect(read({ repeat: 'sometimes' })._tag).toBe('Left');
  });
});
