import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSleepTimer, describeSleep, type SleepPlayer } from '../apps/desktop/renderer/src/app/commands/sleepTimer';

// A stand-in player: its state changes by `report`, which tells subscribers as the store does.
function fakePlayer(start: Partial<SleepPlayer> = {}) {
  let state: SleepPlayer = { entry: 'e1', playId: 'p1', playing: true, position: 0, duration: 200, queued: true, ...start };
  const listeners = new Set<() => void>();
  const pause = vi.fn(() => { state = { ...state, playing: false }; });
  return {
    pause,
    get listeners() { return listeners.size; },
    report(patch: Partial<SleepPlayer>) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); },
    timer: createSleepTimer({
      read: () => state,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      pause,
      now: () => Date.now(),
    }),
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-29T22:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('sleep in minutes', () => {
  it('pauses once the time is up, and not before', () => {
    const p = fakePlayer();
    p.timer.sleepIn(15);
    expect(p.timer.get()).toEqual({ kind: 'minutes', endsAt: Date.now() + 15 * 60_000 });
    vi.advanceTimersByTime(15 * 60_000 - 1);
    expect(p.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(p.pause).toHaveBeenCalledTimes(1);
    expect(p.timer.get()).toBeNull();
  });

  it('setting a new time replaces the old one, and cancelling stops it', () => {
    const p = fakePlayer();
    p.timer.sleepIn(15);
    p.timer.sleepIn(60);
    vi.advanceTimersByTime(30 * 60_000);
    expect(p.pause).not.toHaveBeenCalled();
    p.timer.cancel();
    expect(p.timer.get()).toBeNull();
    vi.advanceTimersByTime(60 * 60_000);
    expect(p.pause).not.toHaveBeenCalled();
  });

  it('keeps counting through song changes and seeks', () => {
    const p = fakePlayer();
    p.timer.sleepIn(30);
    p.report({ entry: 'e2', position: 0 });
    p.report({ position: 150 });
    expect(p.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30 * 60_000);
    expect(p.pause).toHaveBeenCalledTimes(1);
  });

  it('tells listeners when it is set, fires, and is cancelled', () => {
    const p = fakePlayer();
    const heard = vi.fn();
    p.timer.subscribe(heard);
    p.timer.sleepIn(15);
    vi.advanceTimersByTime(15 * 60_000);
    p.timer.sleepIn(30);
    p.timer.cancel();
    p.timer.cancel();
    expect(heard).toHaveBeenCalledTimes(4);
  });

  it('ends without pausing when the queue is emptied', () => {
    const p = fakePlayer();
    p.timer.sleepIn(15);
    p.report({ entry: undefined, playing: false, queued: false });
    expect(p.timer.get()).toBeNull();
    expect(p.listeners).toBe(0);
    vi.advanceTimersByTime(15 * 60_000);
    expect(p.pause).not.toHaveBeenCalled();
  });
});

describe('sleep after this song', () => {
  it('pauses when the next song starts', () => {
    const p = fakePlayer();
    expect(p.timer.sleepAfterSong()).toBe(true);
    expect(p.timer.get()).toEqual({ kind: 'song', playId: 'p1' });
    p.report({ position: 120 });
    expect(p.pause).not.toHaveBeenCalled();
    p.report({ entry: 'e2', playId: 'p2', position: 0 });
    expect(p.pause).toHaveBeenCalledTimes(1);
    expect(p.timer.get()).toBeNull();
    // It stops listening once it has fired.
    expect(p.listeners).toBe(0);
    p.report({ entry: 'e3', playId: 'p3' });
    expect(p.pause).toHaveBeenCalledTimes(1);
  });

  it('pauses when the same song starts over: a repeat-one loop, or played again', () => {
    const p = fakePlayer({ position: 150 });
    p.timer.sleepAfterSong();
    p.report({ position: 199.8 });
    p.report({ playId: 'p2', position: 0.1 });
    expect(p.pause).toHaveBeenCalledTimes(1);
    expect(p.timer.get()).toBeNull();
  });

  it('does not fire on a seek, back or forward, or on pause and resume', () => {
    const p = fakePlayer();
    p.timer.sleepAfterSong();
    p.report({ position: 190 });
    p.report({ position: 5 });
    p.report({ playing: false });
    p.report({ playing: true, position: 199 });
    vi.advanceTimersByTime(10 * 60_000);
    expect(p.pause).not.toHaveBeenCalled();
    expect(p.timer.get()).toEqual({ kind: 'song', playId: 'p1' });
  });

  it('a pause a moment before the end is not the end: it stays set and fires on the next song', () => {
    const p = fakePlayer();
    p.timer.sleepAfterSong();
    p.report({ position: 199 });
    p.report({ playing: false });
    expect(p.timer.get()).toEqual({ kind: 'song', playId: 'p1' });
    p.report({ playing: true });
    p.report({ position: 199.9 });
    p.report({ entry: 'e2', playId: 'p2', position: 0 });
    expect(p.pause).toHaveBeenCalledTimes(1);
  });

  it('a seek to near the end while paused is not the end either', () => {
    const p = fakePlayer({ position: 40 });
    p.timer.sleepAfterSong();
    p.report({ playing: false });
    p.report({ position: 199.5 });
    p.report({ position: 200 });
    expect(p.timer.get()).toEqual({ kind: 'song', playId: 'p1' });
    p.report({ playing: true });
    p.report({ entry: 'e2', playId: 'p2', position: 0 });
    expect(p.pause).toHaveBeenCalledTimes(1);
  });

  it('pauses when the queue is replaced, and ends when it is emptied', () => {
    const p = fakePlayer();
    p.timer.sleepAfterSong();
    // The audio host reports the new queue before its first song has started.
    p.report({ entry: undefined, playing: false, position: 0 });
    expect(p.pause).toHaveBeenCalledTimes(1);

    const q = fakePlayer();
    q.timer.sleepAfterSong();
    q.report({ entry: undefined, playing: false, queued: false });
    expect(q.pause).not.toHaveBeenCalled();
    expect(q.timer.get()).toBeNull();
  });

  it('is done without pausing when the last song plays out with repeat off', () => {
    // The audio host goes idle with no entry and the same playId.
    const p = fakePlayer();
    p.timer.sleepAfterSong();
    p.report({ position: 199.8 });
    p.report({ entry: undefined, playing: false, position: 0 });
    expect(p.pause).not.toHaveBeenCalled();
    expect(p.timer.get()).toBeNull();
    expect(p.listeners).toBe(0);

    // The browser and the phone rest the deck back at the start of the last song.
    const q = fakePlayer();
    q.timer.sleepAfterSong();
    q.report({ position: 199.7 });
    q.report({ playing: false, position: 0 });
    expect(q.pause).not.toHaveBeenCalled();
    expect(q.timer.get()).toBeNull();
    // Played again, the same entry isn't paused by a timer that is done.
    q.report({ playing: true, playId: 'p2', position: 0 });
    q.report({ entry: 'e2', playId: 'p3' });
    expect(q.pause).not.toHaveBeenCalled();
  });

  it('needs a song to wait for', () => {
    const p = fakePlayer({ entry: undefined, playId: '', playing: false });
    expect(p.timer.sleepAfterSong()).toBe(false);
    expect(p.timer.get()).toBeNull();
  });

  it('replaces a minutes timer, and a minutes timer replaces it', () => {
    const p = fakePlayer();
    p.timer.sleepIn(15);
    p.timer.sleepAfterSong();
    vi.advanceTimersByTime(15 * 60_000);
    expect(p.pause).not.toHaveBeenCalled();
    p.timer.sleepIn(30);
    expect(p.listeners).toBe(1);
    p.report({ entry: 'e2', playId: 'p2' });
    expect(p.pause).not.toHaveBeenCalled();
  });

  it('cancelling stops watching the song', () => {
    const p = fakePlayer();
    p.timer.sleepAfterSong();
    p.timer.cancel();
    expect(p.listeners).toBe(0);
    p.report({ entry: 'e2', playId: 'p2' });
    expect(p.pause).not.toHaveBeenCalled();
  });
});

describe('the deck’s note', () => {
  it('counts whole minutes up and names the song timer', () => {
    const now = Date.now();
    expect(describeSleep(null, now)).toBeNull();
    expect(describeSleep({ kind: 'minutes', endsAt: now + 12 * 60_000 }, now)).toBe('Sleeps in 12 min');
    expect(describeSleep({ kind: 'minutes', endsAt: now + 11 * 60_000 + 1 }, now)).toBe('Sleeps in 12 min');
    expect(describeSleep({ kind: 'minutes', endsAt: now + 20_000 }, now)).toBe('Sleeps in 1 min');
    expect(describeSleep({ kind: 'minutes', endsAt: now - 1 }, now)).toBe('Sleeps in 1 min');
    expect(describeSleep({ kind: 'song', playId: 'p1' }, now)).toBe('Sleeps after this song');
  });
});
