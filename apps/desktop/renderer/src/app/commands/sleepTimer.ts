// The sleep timer's logic, without the player or the DOM, so it can be tested on its own.
// commands/sleep.ts connects one to the app's player.
//
// Two kinds of timer:
//   minutes  pauses when the time is up.
//   song     pauses when the play it was set in is over and another begins: the playId changes
//            on the next song, on a repeat-one loop, on the same song played again, and when the
//            queue is replaced. A seek or a pause never changes it.
// Either ends, without pausing, when the queue is emptied.
//
// The last song with repeat off ends without a new play: playback stops by itself, there is
// nothing to pause, and the song timer is done. It counts as played out only when the report
// before was playing within a moment of the end and this one has stopped and gone back to the
// start or unloaded the song, which is how every player reports the end of its queue (the audio
// host goes idle with no entry; the browser and the phone rest the deck at 0). A pause near the
// end stays where it was, so it isn't mistaken for the end: the timer stays set and pauses when
// the next song begins. If a player ever reports its end some other way, the same holds: the
// timer stays set rather than ending early.

export type SleepMode = { kind: 'minutes'; endsAt: number } | { kind: 'song'; playId: string };

export interface SleepPlayer {
  // The playing queue entry, if any.
  entry: string | undefined;
  // Changes whenever a song starts from the top (PlayerState.playId), never on a seek or pause.
  playId: string;
  playing: boolean;
  position: number;
  duration: number;
  // Whether the queue holds anything.
  queued: boolean;
}

export interface SleepHost {
  read(): SleepPlayer;
  subscribe(listener: () => void): () => void;
  pause(): void;
  now?(): number;
}

export interface SleepTimer {
  get(): SleepMode | null;
  subscribe(listener: () => void): () => void;
  sleepIn(minutes: number): void;
  sleepAfterSong(): boolean;
  cancel(): void;
}

// Seconds from a song's end that count as its end: reports come two to four times a second.
const END_WINDOW = 2;
const nearEnd = (s: SleepPlayer) => s.duration > 0 && s.position >= s.duration - END_WINDOW;
// The song played out and playback stopped by itself (see above).
const playedOut = (before: SleepPlayer, after: SleepPlayer) =>
  before.playing && nearEnd(before) && !after.playing && (!after.entry || after.position < 1);

export function createSleepTimer(host: SleepHost): SleepTimer {
  const now = () => host.now?.() ?? Date.now();
  let mode: SleepMode | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopWatching: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const set = (next: SleepMode | null) => { mode = next; listeners.forEach(listener => listener()); };

  const clear = () => {
    clearTimeout(timer); timer = undefined;
    stopWatching?.(); stopWatching = undefined;
  };
  const end = () => { clear(); set(null); };
  const sleep = () => { end(); host.pause(); };

  return {
    get: () => mode,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    sleepIn(minutes) {
      clear();
      const ms = Math.max(0, minutes) * 60_000;
      timer = setTimeout(sleep, ms);
      stopWatching = host.subscribe(() => { if (!host.read().queued) end(); });
      set({ kind: 'minutes', endsAt: now() + ms });
    },
    // Returns false when nothing is playing, so there is no song to wait for.
    sleepAfterSong() {
      const start = host.read();
      if (!start.entry || !start.playId) return false;
      clear();
      const { playId } = start;
      let last = start;
      stopWatching = host.subscribe(() => {
        const state = host.read();
        if (!state.queued) { end(); return; }
        if (state.playId !== playId) { sleep(); return; }
        if (playedOut(last, state)) { end(); return; }
        // The queue was replaced and the new song hasn't started yet.
        if (!state.entry) { sleep(); return; }
        last = state;
      });
      set({ kind: 'song', playId });
      return true;
    },
    cancel() { if (mode) end(); },
  };
}

// The deck's quiet note: "Sleeps in 12 min", counting whole minutes up.
export function describeSleep(mode: SleepMode | null, at: number): string | null {
  if (!mode) return null;
  if (mode.kind === 'song') return 'Sleeps after this song';
  const minutes = Math.max(1, Math.ceil((mode.endsAt - at) / 60_000));
  return `Sleeps in ${minutes} min`;
}
