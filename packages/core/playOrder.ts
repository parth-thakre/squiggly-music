import type { RepeatMode } from './contracts';

// What plays next, and shuffling, shared by the desktop's audio host and the queue the page keeps
// in the browser and on Android. Queue behaviour only: nothing here touches the signal.

export const repeatModes: readonly RepeatMode[] = ['off', 'all', 'one'];
// The repeat button and command go off, all, one, and round again.
export const nextRepeat = (mode: RepeatMode): RepeatMode => repeatModes[(repeatModes.indexOf(mode) + 1) % repeatModes.length];

// The index that follows `index` in a queue of `length`, or -1 when the queue stops there.
// 'ended': the song finished by itself, so repeat one plays it again. 'skip': Next was pressed,
// which moves on even under repeat one, as in most players.
export function following(index: number, length: number, repeat: RepeatMode, reason: 'ended' | 'skip'): number {
  if (index < 0 || index >= length) return -1;
  if (reason === 'ended' && repeat === 'one') return index;
  if (index + 1 < length) return index + 1;
  return repeat === 'all' ? 0 : -1;
}

// The index before `index`, or -1 at the front. Under repeat all the first song's previous is the last.
// Past this many seconds into a song, Previous starts it again rather than going back a song, in
// every build: the browser and Android's page (player.ts), the desktop's audio host, and Android's
// notification (Media3's own default is the same three seconds).
export const RESTART_AFTER = 3;
export function preceding(index: number, length: number, repeat: RepeatMode): number {
  if (index < 0 || index >= length) return -1;
  if (index > 0) return index - 1;
  return repeat === 'all' && length > 1 ? length - 1 : -1;
}

// A new order for a queue, as indexes into it. The current song and the songs before it (already
// played) keep their places; the songs after it come in random order. With nothing current (-1)
// the whole queue is shuffled. `random` returns [0, 1), like Math.random.
export function shuffleOrder(length: number, current: number, random: () => number = Math.random): number[] {
  const order = Array.from({ length }, (_, i) => i);
  const first = Math.max(0, current + 1);
  for (let i = length - 1; i > first; i--) {
    const j = Math.min(i, first + Math.floor(random() * (i - first + 1)));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
