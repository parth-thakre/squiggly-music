import type { SavedQueue } from '../../../packages/core/contracts';

// The queue saved on the server, as read lately. Launch reads it for the deck's Resume offer (and,
// on Windows and macOS, for the system media controls' saved song), so Resume soon after can play
// that copy rather than ask the server again. A copy serves only the session that read it, for 30
// seconds, and once. It's dropped when this app saves a queue of its own, and a read that started
// before that save doesn't bring it back. So a queue changed on the server since (another device
// playing on) wins again within 30 seconds.
export class SavedQueueCopy<Session> {
  private copy: { session: Session; value: SavedQueue; at: number } | null = null;
  // Bumped by clear(), so a read still on its way when the queue changed isn't kept.
  private epoch = 0;

  constructor(private maxAgeMs = 30_000, private now = () => performance.now()) {}

  // Call before asking the server; give what it answers to the returned function. An answer of
  // no saved queue replaces an older copy too.
  reading(session: Session) {
    const epoch = this.epoch;
    return (value: SavedQueue | null) => {
      if (epoch !== this.epoch) return;
      this.copy = value?.tracks.length ? { session, value, at: this.now() } : null;
    };
  }
  // The copy, if this session read it under 30 seconds ago. Taken once: a later Resume asks the server.
  take(session: Session): SavedQueue | null {
    const copy = this.copy;
    this.copy = null;
    return copy && copy.session === session && this.now() - copy.at < this.maxAgeMs ? copy.value : null;
  }
  clear() { this.copy = null; this.epoch++; }
}
