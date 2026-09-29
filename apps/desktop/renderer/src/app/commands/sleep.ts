import { useEffect, useState, useSyncExternalStore } from 'react';
import { onLibraryReset } from '../library';
import { currentEntry, getPlayer, player, subscribePlayer } from '../player';
import { createSleepTimer, describeSleep } from './sleepTimer';

// The built-in sleep timer, in the page so it works on the desktop, in the browser, and on
// Android. The logic is in ./sleepTimer; this connects it to the player.
//
// On the desktop, closing the window to the tray only hides it: the page keeps running and its
// timers fire, but a hidden window gets no player snapshots unless it asks. So player.pause()
// goes straight to the audio host rather than through the page's copy of the state, and while
// "after this song" waits, the window asks to follow the player while hidden.
//
// On Android the page goes when the app is swiped away and the player plays on, so the native
// player is told the timer too and pauses by itself (player.sleepNatively).
const desktop = typeof window !== 'undefined' ? window.squiggly : undefined;

export const sleepTimer = createSleepTimer({
  read() {
    const state = getPlayer();
    return {
      entry: currentEntry(state), playId: state.playId, playing: state.playing,
      position: state.position, duration: state.duration, queued: state.queue.length > 0,
    };
  },
  subscribe: subscribePlayer,
  // The play change is heard in the middle of the player's own update, before the browser
  // starts the next song; pausing once that update is done stops it.
  pause: () => queueMicrotask(() => player.pause()),
});
// A timer from another server or account, or from before signing out, never pauses this one.
onLibraryReset(() => sleepTimer.cancel());
let following = false;
sleepTimer.subscribe(() => {
  const mode = sleepTimer.get();
  const song = mode?.kind === 'song';
  if (desktop && song !== following) { following = song; void desktop.window.followWhileHidden(song); }
  player.sleepNatively(mode?.kind === 'minutes' ? mode.endsAt : null, mode?.kind === 'song' ? mode.playId : null);
});
import.meta.hot?.dispose(() => sleepTimer.cancel());

export const useSleepTimer = () => useSyncExternalStore(sleepTimer.subscribe, sleepTimer.get);

// The note under the song, recounted every few seconds while a timer counts down.
export function useSleepNote(): string | null {
  const mode = useSleepTimer();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (mode?.kind !== 'minutes') return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(tick);
  }, [mode]);
  return describeSleep(mode, now);
}
