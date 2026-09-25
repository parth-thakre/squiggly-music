import type { PlayerSnapshot } from '../../../packages/core/contracts';

export interface SavedState { trackIds: string[]; currentIndex: number; positionSeconds: number }
// Only a queue made entirely of server tracks is saved. Local files have no server identity,
// and saving the server tracks alone would misplace the current index.
export function savedState(player: PlayerSnapshot): SavedState | null {
  if (player.engine !== 'ready' || !player.queue.length || player.queue.some(track => track.source !== 'navidrome')) return null;
  const current = player.currentIndex;
  return { trackIds: player.queue.map(track => track.id), currentIndex: Math.max(0, current), positionSeconds: current >= 0 ? Math.floor(player.position) : 0 };
}
const identity = (state: SavedState) => `${state.currentIndex}:${state.trackIds.join('\n')}`;

// Saves the play queue to the server: shortly after track changes, pauses, and queue edits,
// every 30 seconds while playing, and on demand at quit. Saves run one at a time, coalesce to the
// latest state, and skip the saved state (position within two seconds). Failures are silent; the next trigger retries.
export class QueueSync {
  private latest: { state: SavedState | null; generation: number } | null = null;
  private previous: { ids: string; index: number; playing: boolean } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wanted: { state: SavedState; generation: number } | null = null;
  private running: Promise<void> | null = null;
  private saved: { identity: string; position: number } | null = null;
  // A restored queue reads position 0 until the host's pending seek lands (up to about ten seconds).
  // Saving it then would overwrite the server's position, so its own state is held back briefly.
  private hold: { identity: string; until: number } | null = null;
  private lastAttempt: number | null = null;
  // Bumped by markSaved and reset. A save that started under an older epoch settles without
  // touching the saved marker, which then describes the newer restore (or nothing).
  private epoch = 0;

  constructor(private save: (state: SavedState, generation: number) => Promise<void>, private debounceMs = 3000, private intervalMs = 30_000) {}

  // `generation` is the server session the snapshot belongs to; the save callback rejects stale ones.
  observe(player: PlayerSnapshot, generation: number, enabled: boolean) {
    if (!enabled) { this.cancel(); this.previous = null; this.latest = null; return; }
    const now = Date.now();
    this.lastAttempt ??= now;
    const ids = player.queue.map(track => track.id).join('\n');
    const previous = this.previous;
    this.previous = { ids, index: player.currentIndex, playing: player.playing };
    this.latest = { state: savedState(player), generation };
    if (previous && (previous.ids !== ids || previous.index !== player.currentIndex || (previous.playing && !player.playing))) this.schedule();
    else if (player.playing && !this.timer && now - this.lastAttempt >= this.intervalMs) void this.saveLatest();
  }
  // After loading a saved queue, its own state need not be written back.
  markSaved(state: SavedState, holdMs = 12_000) {
    this.epoch++;
    this.saved = { identity: identity(state), position: state.positionSeconds };
    this.hold = { identity: identity(state), until: Date.now() + holdMs };
  }
  // Saves the latest state now. Resolves when that save settles; callers bound the wait.
  flush(): Promise<void> { this.cancel(); return this.saveLatest(); }
  reset() { this.epoch++; this.cancel(); this.previous = null; this.latest = null; this.wanted = null; this.saved = null; this.hold = null; }

  private skip(state: SavedState) {
    const id = identity(state);
    if (this.hold && (this.hold.identity !== id || Date.now() >= this.hold.until)) this.hold = null;
    return this.hold !== null || (this.saved?.identity === id && Math.abs(this.saved.position - state.positionSeconds) < 2);
  }
  private cancel() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private schedule(delay = this.debounceMs) {
    this.cancel();
    this.timer = setTimeout(() => { this.timer = null; void this.saveLatest(); }, delay);
  }
  private saveLatest(): Promise<void> {
    const latest = this.latest;
    if (!latest?.state || this.skip(latest.state)) return this.running ?? Promise.resolve();
    this.lastAttempt = Date.now();
    this.wanted = { state: latest.state, generation: latest.generation };
    // A run that already passed its last check hands over to a new run; wait for that one too.
    return this.kick().then(() => this.running ?? undefined);
  }
  private kick(): Promise<void> {
    return this.running ??= this.drain().finally(() => {
      this.running = null;
      if (this.wanted) void this.kick();
    });
  }
  private async drain() {
    while (this.wanted) {
      const { state, generation } = this.wanted; this.wanted = null;
      if (this.skip(state)) continue;
      const epoch = this.epoch;
      try {
        await this.save(state, generation);
        if (epoch === this.epoch) this.saved = { identity: identity(state), position: state.positionSeconds };
        else if (this.saved && this.latest) {
          // A restore was marked while this older save was in flight, so the server may now hold
          // the older queue. Forget the marker and save the restored queue once its hold ends.
          this.saved = null;
          this.schedule(Math.max(this.debounceMs, (this.hold?.until ?? 0) - Date.now()));
        }
      } catch { /* Counted in operation metrics by the caller. */ }
    }
  }
}
