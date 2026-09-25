import type { PlayerSnapshot } from '../../../packages/core/contracts';
import { finishThreshold } from '../../../packages/core/plays';

export interface PlayEvent { trackId: string; event: 'started' | 'finished' }
export { finishThreshold };

// Derives play reports from native snapshots (about 4 Hz). Only server tracks are reported.
// Listening time counts continuous progress, so seeking forward never completes a play.
export class PlayTracker {
  private play: { id: string; entry: string | undefined; index: number; position: number; at: number; played: number; started: boolean; finished: boolean } | null = null;

  reset() { this.play = null; }

  // `now` is a monotonic time in milliseconds.
  update(player: PlayerSnapshot, now: number): PlayEvent[] {
    const track = player.engine === 'ready' ? player.queue[player.currentIndex] : undefined;
    // Stopping, an engine restart, or a local file ends the current play.
    if (!track || track.source !== 'navidrome') { this.play = null; return []; }
    let play = this.play;
    const entry = player.entryIds[player.currentIndex];
    // A new play is another song, or the same song again at another queue entry. Queue entry ids
    // say which entry is current; a queue edit that only shifts it keeps the play. Without ids,
    // another index with the position going back means another entry.
    const another = entry !== undefined && play?.entry !== undefined ? play.entry !== entry
      : play !== null && play.index !== player.currentIndex && player.position < play.position;
    if (!play || play.id !== track.id || another) {
      play = this.play = { id: track.id, entry, index: player.currentIndex, position: player.position, at: now, played: 0, started: false, finished: false };
    } else {
      // Progress beyond the elapsed wall-clock time (plus polling slack) is a seek, not listening.
      const progress = player.position - play.position;
      if (player.playing && progress > 0 && progress <= (now - play.at) / 1000 + 1) play.played += progress;
      play.position = player.position; play.at = now; play.index = player.currentIndex; play.entry = entry;
    }
    const events: PlayEvent[] = [];
    if (!player.playing) return events;
    if (!play.started) { play.started = true; events.push({ trackId: track.id, event: 'started' }); }
    const threshold = finishThreshold(player.duration > 0 ? player.duration : track.duration ?? 0);
    if (!play.finished && threshold !== null && play.played >= threshold) {
      play.finished = true; events.push({ trackId: track.id, event: 'finished' });
    }
    return events;
  }
}
