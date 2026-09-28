import { nav } from './route';

// Hooks into the shell for actions that live in components.
export const shell = { openNowPlaying: null as (() => void) | null };

// After Play or Shuffle on a record, playlist, artist, or automatic playlist, you're taken to what
// is playing: the phone opens its now-playing sheet, and the desktop shows the queue, with the
// sleeve already beside it. Playing one song from a list leaves you where you are.
export function showNowPlaying() {
  if (matchMedia('(max-width: 760px)').matches) shell.openNowPlaying?.();
  else nav.go({ view: 'queue' });
}
