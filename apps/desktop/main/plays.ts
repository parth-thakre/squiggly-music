import type { PlayerSnapshot } from '../../../packages/core/contracts';
import { finishThreshold } from '../../../packages/core/plays';

export interface PlayEvent { trackId: string; event: 'started' | 'finished' }
export { finishThreshold };

// Derives play reports from native snapshots (about 4 Hz). Only server tracks are reported.
// Listening time counts continuous progress, so seeking forward never completes a play.
export class PlayTracker {
  private play: { id: string; playId: string; position: number; at: number; played: number; started: boolean; finished: boolean } | null = null;

  reset() { this.play = null; }

  // `now` is a monotonic time in milliseconds.
  update(player: PlayerSnapshot, now: number): PlayEvent[] {
    const track = player.engine === 'ready' ? player.queue[player.currentIndex] : undefined;
    // Stopping, an engine restart, a local file, or an internet radio station ends the current play.
    // A station is live, not a song the server can count.
    if (!track || track.source !== 'navidrome') { this.play = null; return []; }
    let play = this.play;
    // A new play is whatever the audio host says started from the top (playId): another song,
    // the same song at another entry or again under repeat one. A queue edit that only moves the
    // current entry, or a seek, keeps the play.
    if (!play || play.id !== track.id || play.playId !== player.playId) {
      play = this.play = { id: track.id, playId: player.playId, position: player.position, at: now, played: 0, started: false, finished: false };
    } else {
      // Progress beyond the elapsed wall-clock time (plus polling slack) is a seek, not listening.
      const progress = player.position - play.position;
      if (player.playing && progress > 0 && progress <= (now - play.at) / 1000 + 1) play.played += progress;
      play.position = player.position; play.at = now;
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
