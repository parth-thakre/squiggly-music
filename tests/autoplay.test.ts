import { describe, expect, it } from 'vitest';
import { addedRuns, autoplayTurn, freshSongs, keepQueued, noAutoplay } from '../packages/core/autoplay';
import type { Track } from '../packages/core/contracts';

const track = (id: string, source: Track['source'] = 'navidrome'): Track => ({
  id, title: id, artist: 'Artist', album: 'Album', duration: 200, source, sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null,
});
const queue = (...ids: string[]) => ({ queue: ids.map(id => track(id)), entryIds: ids.map((_, i) => `e${i}`), repeat: 'off' as const, radio: false });

describe('autoplay', () => {
  it('takes a turn once the next-to-last or the last entry is the one playing, for the last entry', () => {
    expect(autoplayTurn({ ...queue('a', 'b', 'c', 'd'), index: 1 })).toBeNull();
    expect(autoplayTurn({ ...queue('a', 'b', 'c', 'd'), index: -1 })).toBeNull();
    expect(autoplayTurn({ ...queue(), index: -1 })).toBeNull();
    const turn = { entry: 'e3', seeds: [track('d'), track('c'), track('b')] };
    expect(autoplayTurn({ ...queue('a', 'b', 'c', 'd'), index: 2 })).toEqual(turn);
    expect(autoplayTurn({ ...queue('a', 'b', 'c', 'd'), index: 3 })).toEqual(turn);
  });

  it('never runs under repeat or radio, after a file or a station, and seeds from server songs only', () => {
    expect(autoplayTurn({ ...queue('a', 'b'), index: 1, repeat: 'all' })).toBeNull();
    expect(autoplayTurn({ ...queue('a', 'b'), index: 1, repeat: 'one' })).toBeNull();
    expect(autoplayTurn({ ...queue('a', 'b'), index: 1, radio: true })).toBeNull();
    for (const source of ['local', 'station'] as const) {
      expect(autoplayTurn({ ...queue('a'), queue: [track('a'), track('z', source)], entryIds: ['e0', 'e1'], index: 1 })).toBeNull();
    }
    // Newest first, each song once, files left out, at most three.
    const mixed = [track('a'), track('b'), track('f', 'local'), track('a'), track('c'), track('d')];
    expect(autoplayTurn({ ...queue(), queue: mixed, entryIds: mixed.map((_, i) => `e${i}`), index: 5 })?.seeds.map(t => t.id)).toEqual(['d', 'c', 'a']);
  });

  it('picks new server songs in the server\'s order, each once, up to the count', () => {
    const taken = new Set(['a', 'b']);
    const answer = ['a', 'n1', 'n2', 'n1', 'b', 'n3', 'n4'].map(id => track(id));
    expect(freshSongs([...answer, track('s', 'station')], taken, 3).map(t => t.id)).toEqual(['n1', 'n2', 'n3']);
    // A second seed's answer skips what the first already picked.
    expect(freshSongs(answer, taken, 10).map(t => t.id)).toEqual(['n4']);
    expect(freshSongs(answer, taken, 10)).toEqual([]);
  });

  it('marks runs of added entries and forgets the ones that left the queue', () => {
    const view = { added: ['e3', 'e4', 'e6'], missed: null };
    expect(addedRuns(view, ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'])).toEqual([3, 6]);
    expect(addedRuns(view, ['e3', 'e4'])).toEqual([0]);
    expect(addedRuns(noAutoplay, ['e0'])).toEqual([]);
    expect(keepQueued(view, ['e3', 'e4', 'e6', 'e7'])).toBe(view);
    expect(keepQueued(view, ['e4', 'e7'])).toEqual({ added: ['e4'], missed: null });
  });
});
