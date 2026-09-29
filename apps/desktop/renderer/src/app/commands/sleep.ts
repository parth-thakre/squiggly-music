import { useEffect, useState, useSyncExternalStore } from 'react';
import { currentEntry, getPlayer, player, subscribePlayer } from '../player';
import { createSleepTimer, describeSleep } from './sleepTimer';

// The built-in sleep timer, in the page so it works on the desktop, in the browser, and on
// Android. The logic is in ./sleepTimer; this connects it to the player.
//
// On the desktop, closing the window to the tray only hides it: the page keeps running and its
// timers fire, but a hidden window gets no player snapshots. So player.pause() goes straight to
// the audio host rather than through the page's copy of the state, and "after this song" pauses
// at the song's projected end while the window is hidden.
const desktop = typeof window !== 'undefined' ? window.squiggly : undefined;

export const sleepTimer = createSleepTimer({
  read() {
    const state = getPlayer();
    return { entry: currentEntry(state), playing: state.playing, position: state.position, duration: state.duration };
  },
  subscribe: subscribePlayer,
  // The entry change is heard in the middle of the player's own update, before the browser
  // starts the next song; pausing once that update is done stops it.
  pause: () => queueMicrotask(() => player.pause()),
  deaf: () => !!desktop && document.hidden,
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
