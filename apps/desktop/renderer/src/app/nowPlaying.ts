import { useSyncExternalStore } from 'react';
import { nav } from './route';

// Hooks into the shell for actions that live in components.
export const shell = { openNowPlaying: null as (() => void) | null };

// A Galaxy Z Flip's cover screen (Flex Window): a small window on a small, nearly square screen.
// The Flip 7's is 361×399 CSS px (542×599 at a smaller display size), the Flip 5 and 6 about
// 374×360. Checking the screen as well as the window keeps split screen, pop-up windows, and small
// browser windows on a phone or computer in their usual layout; the shape keeps phones out.
// app.css repeats this query.
export const COVER_SCREEN = '(max-width: 630px) and (max-height: 700px) and (max-device-width: 630px) and (max-device-height: 700px) and (min-device-aspect-ratio: 3/4) and (max-device-aspect-ratio: 4/3)';
const cover = typeof matchMedia === 'function' ? matchMedia(COVER_SCREEN) : null;
export const useCoverScreen = () => useSyncExternalStore(listener => {
  cover?.addEventListener('change', listener);
  return () => cover?.removeEventListener('change', listener);
}, () => !!cover?.matches);

// After Play or Shuffle on a record, playlist, artist, or automatic playlist, you're taken to what
// is playing: the phone opens its now-playing sheet, and the desktop shows the queue, with the
// sleeve already beside it. Playing one song from a list leaves you where you are. The cover
// screen always shows what's playing.
export function showNowPlaying() {
  if (cover?.matches) return;
  if (matchMedia('(max-width: 760px)').matches) shell.openNowPlaying?.();
  else nav.go({ view: 'queue' });
}
