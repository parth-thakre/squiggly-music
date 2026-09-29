import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSleepTimer, describeSleep, SONG_END_GRACE_MS, type SleepPlayer } from '../apps/desktop/renderer/src/app/commands/sleepTimer';

// A stand-in player: its state changes by `report`, which tells subscribers as the store does.
function fakePlayer(start: Partial<SleepPlayer> = {}) {
  let state: SleepPlayer = { entry: 'e1', playing: true, position: 0, duration: 200, ...start };
  const listeners = new Set<() => void>();
  let deaf = false;
  const pause = vi.fn(() => { state = { ...state, playing: false }; });
  return {
    pause,
    get listeners() { return listeners.size; },
    report(patch: Partial<SleepPlayer>) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); },
    // The desktop's window hidden in the tray: no reports reach the page.
    hide() { deaf = true; },
    timer: createSleepTimer({
      read: () => state,
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      pause,
      now: () => Date.now(),
      deaf: () => deaf,
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
});

describe('sleep after this song', () => {
  it('pauses when the next entry starts', () => {
    const p = fakePlayer();
    expect(p.timer.sleepAfterSong()).toBe(true);
    expect(p.timer.get()).toEqual({ kind: 'song', entry: 'e1' });
    p.report({ position: 120 });
    expect(p.pause).not.toHaveBeenCalled();
    p.report({ entry: 'e2', position: 0 });
    expect(p.pause).toHaveBeenCalledTimes(1);
    expect(p.timer.get()).toBeNull();
    // It stops listening once it has fired.
    expect(p.listeners).toBe(0);
    p.report({ entry: 'e3' });
    expect(p.pause).toHaveBeenCalledTimes(1);
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
    expect(p.timer.get()).toEqual({ kind: 'song', entry: 'e1' });
  });

  it('pauses when the queue is replaced or cleared', () => {
    const p = fakePlayer();
    p.timer.sleepAfterSong();
    p.report({ entry: undefined, playing: false });
    expect(p.pause).toHaveBeenCalledTimes(1);
  });

  it('is done without pausing when the last song plays out and playback stops', () => {
    const p = fakePlayer();
    p.timer.sleepAfterSong();
    p.report({ playing: false, position: 200 });
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
    q.report({ playing: true, position: 1 });
    q.report({ entry: 'e2' });
    expect(q.pause).not.toHaveBeenCalled();
  });

  it('needs a song to wait for', () => {
    const p = fakePlayer({ entry: undefined, playing: false });
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
    expect(p.listeners).toBe(0);
    p.report({ entry: 'e2' });
    expect(p.pause).not.toHaveBeenCalled();
  });

  it('cancelling stops watching the song', () => {
    const p = fakePlayer();
    p.timer.sleepAfterSong();
    p.timer.cancel();
    expect(p.listeners).toBe(0);
    p.report({ entry: 'e2' });
    expect(p.pause).not.toHaveBeenCalled();
  });

  it('while no reports arrive (a window hidden in the tray), pauses at the song’s projected end', () => {
    const p = fakePlayer({ position: 150 });
    p.timer.sleepAfterSong();
    p.hide();
    vi.advanceTimersByTime(50_000 + SONG_END_GRACE_MS - 1);
    expect(p.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(p.pause).toHaveBeenCalledTimes(1);
    expect(p.timer.get()).toBeNull();
  });

  it('while reports arrive, the projection never pauses on its own, and a seek moves it', () => {
    const p = fakePlayer({ position: 150 });
    p.timer.sleepAfterSong();
    vi.advanceTimersByTime(50_000 + SONG_END_GRACE_MS + 10);
    expect(p.pause).not.toHaveBeenCalled();
    // Seeking back while hidden: the projection follows the last report.
    p.report({ position: 20 });
    p.hide();
    vi.advanceTimersByTime(60_000);
    expect(p.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180_000 + SONG_END_GRACE_MS);
    expect(p.pause).toHaveBeenCalledTimes(1);
  });

  it('a paused song has no projected end', () => {
    const p = fakePlayer({ position: 150 });
    p.timer.sleepAfterSong();
    p.report({ playing: false });
    p.hide();
    vi.advanceTimersByTime(10 * 60_000);
    expect(p.pause).not.toHaveBeenCalled();
    expect(p.timer.get()).toEqual({ kind: 'song', entry: 'e1' });
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
    expect(describeSleep({ kind: 'song', entry: 'e1' }, now)).toBe('Sleeps after this song');
  });
});
