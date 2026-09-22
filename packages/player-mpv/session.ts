import type { PlayerSnapshot } from '../core/contracts';

interface SessionPlayer {
  command(...args: string[]): void;
}

// Stop first so playlist-clear can remove every entry, including the URL that
// was active. Volume and audio-device are properties of the existing engine and
// deliberately remain untouched.
export function clearPlayerSession(native: SessionPlayer, player: PlayerSnapshot) {
  native.command('stop');
  native.command('playlist-clear');
  player.playing = false;
  player.position = 0;
  player.duration = 0;
  player.currentIndex = -1;
  player.queue = [];
}
