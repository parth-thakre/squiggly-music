// The sleep timer's logic, without the player or the DOM, so it can be tested on its own.
// commands/sleep.ts connects one to the app's player.
//
// Two kinds of timer:
//   minutes  pauses when the time is up.
//   song     pauses when the playing entry changes (the next song started, or the queue was
//            replaced or cleared). A seek stays on the same entry, so it never counts. When the
//            last song simply ends, playback has stopped by itself and the timer is done.
//
// A host can also say when it has stopped hearing from the player (`deaf`): the desktop's window
// hidden in the tray gets no snapshots, so it can't see the entry change. The song timer then
// keeps a projection of when the song ends, made from the last report, and pauses a moment after.

export type SleepMode = { kind: 'minutes'; endsAt: number } | { kind: 'song'; entry: string };

export interface SleepPlayer {
  // The playing queue entry, if any.
  entry: string | undefined;
  playing: boolean;
  position: number;
  duration: number;
}

export interface SleepHost {
  read(): SleepPlayer;
  subscribe(listener: () => void): () => void;
  pause(): void;
  now?(): number;
  deaf?(): boolean;
}

export interface SleepTimer {
  get(): SleepMode | null;
  subscribe(listener: () => void): () => void;
  sleepIn(minutes: number): void;
  sleepAfterSong(): boolean;
  cancel(): void;
}

// How long after a projected song end the deaf host pauses, so a late report can still say
// the entry changed first.
export const SONG_END_GRACE_MS = 1500;
// Seconds from a song's end that count as its end: reports come two to four times a second.
const END_WINDOW = 2;

export function createSleepTimer(host: SleepHost): SleepTimer {
  const now = () => host.now?.() ?? Date.now();
  let mode: SleepMode | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let stopWatching: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const set = (next: SleepMode | null) => { mode = next; listeners.forEach(listener => listener()); };

  const clear = () => {
    clearTimeout(timer); timer = undefined;
    clearTimeout(fallback); fallback = undefined;
    stopWatching?.(); stopWatching = undefined;
  };
  const sleep = () => { clear(); set(null); host.pause(); };

  // The song timer's projection of the song's end, from the latest report. Only a deaf host acts on it.
  const project = (state: SleepPlayer) => {
    clearTimeout(fallback); fallback = undefined;
    if (!state.playing || !(state.duration > 0)) return;
    const left = Math.max(0, state.duration - state.position) * 1000;
    fallback = setTimeout(() => { fallback = undefined; if (host.deaf?.()) sleep(); }, left + SONG_END_GRACE_MS);
  };

  return {
    get: () => mode,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    sleepIn(minutes) {
      clear();
      const ms = Math.max(0, minutes) * 60_000;
      timer = setTimeout(sleep, ms);
      set({ kind: 'minutes', endsAt: now() + ms });
    },
    // Returns false when nothing is playing, so there is no song to wait for.
    sleepAfterSong() {
      const start = host.read();
      if (!start.entry) return false;
      clear();
      const entry = start.entry;
      let last = start;
      project(start);
      stopWatching = host.subscribe(() => {
        const state = host.read();
        if (state.entry !== entry) { sleep(); return; }
        // The last song played out and playback stopped by itself: nothing left to pause. Players
        // report the end differently (at its length, or back at its start), so the report before
        // counts too: it was playing within a moment of the end.
        const atEnd = (s: SleepPlayer) => s.duration > 0 && s.position >= s.duration - END_WINDOW;
        if (!state.playing && (atEnd(state) || (last.playing && atEnd(last)))) { clear(); set(null); return; }
        last = state;
        project(state);
      });
      set({ kind: 'song', entry });
      return true;
    },
    cancel() { if (!mode) return; clear(); set(null); },
  };
}

// The deck's quiet note: "Sleeps in 12 min", counting whole minutes up.
export function describeSleep(mode: SleepMode | null, at: number): string | null {
  if (!mode) return null;
  if (mode.kind === 'song') return 'Sleeps after this song';
  const minutes = Math.max(1, Math.ceil((mode.endsAt - at) / 60_000));
  return `Sleeps in ${minutes} min`;
}
