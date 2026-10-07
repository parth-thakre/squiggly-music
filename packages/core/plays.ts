// Last.fm's scrobble rule, shared by the desktop main process and the browser build:
// a song longer than 30 seconds counts once half of it, or four minutes, has played.
export const finishThreshold = (duration: number) => duration > 30 ? Math.min(duration / 2, 240) : null;

// Finished plays that couldn't be reported because the server was out of reach, sent in order
// once it answers again. Now playing ('started') is never kept: it means nothing later.
export interface QueuedPlay { trackId: string; at: number }   // at: when the play finished, epoch ms
export const MAX_QUEUED_PLAYS = 500;
export type SendOutcome = 'sent' | 'unreachable' | 'refused';
export interface QueuedPlays { account: string | null; plays: readonly QueuedPlay[] }

// Appends, skipping an exact duplicate, and drops the oldest past the bound.
export function queuePlay(queue: readonly QueuedPlay[], play: QueuedPlay): QueuedPlay[] {
  if (queue.some(item => item.trackId === play.trackId && item.at === play.at)) return [...queue];
  const next = [...queue, play];
  return next.length > MAX_QUEUED_PLAYS ? next.slice(next.length - MAX_QUEUED_PLAYS) : next;
}

// Play reports with a queue for the time the server is away. The host decides how to send one
// and where the queue is stored (the desktop's plays.json, the Android page's localStorage).
export class PlayReports {
  #queue: QueuedPlay[];
  #account: string | null;
  #flushing: Promise<void> | null = null;
  // Bumped by bind (another account) and clear. A send that began before either is stale: its
  // play belongs to the account it was sent for, so it is never queued for the one bound now.
  #generation = 0;
  private readonly now: () => number;
  constructor(private readonly d: {
    send(trackId: string, event: 'started' | 'finished', at?: number): Promise<SendOutcome>;
    away(): boolean;
    failed(): void;
    load(): QueuedPlays;
    save(value: QueuedPlays): void;
    changed(count: number): void;
    now?(): number;
  }) {
    const stored = d.load();
    this.#queue = [...stored.plays];
    this.#account = stored.account;
    this.now = d.now ?? Date.now;
  }
  get size() { return this.#queue.length; }

  async report(trackId: string, event: 'started' | 'finished'): Promise<void> {
    const generation = this.#generation;
    if (event === 'started') {
      if (this.d.away()) return;
      const outcome = await this.d.send(trackId, 'started');
      if (outcome === 'unreachable' && generation === this.#generation) this.d.failed();
      return;
    }
    const play = { trackId, at: this.now() };
    if (this.d.away()) { this.push(play); return; }
    const outcome = await this.d.send(trackId, 'finished', play.at);
    if (generation !== this.#generation) return;
    if (outcome === 'unreachable') { this.push(play); this.d.failed(); }
    else if (outcome === 'sent' && this.#queue.length) void this.flush();
  }

  // Oldest first, one at a time. A refused play (a song deleted from the server) is dropped; no
  // answer stops the flush until the next one. A flush for an account no longer bound stops.
  flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    if (this.d.away() || !this.#queue.length) return Promise.resolve();
    const generation = this.#generation;
    let running: Promise<void> | undefined;
    let settled = false;
    running = (async () => {
      try {
        while (this.#queue.length && !this.d.away() && generation === this.#generation) {
          const play = this.#queue[0];
          const outcome = await this.d.send(play.trackId, 'finished', play.at);
          if (generation !== this.#generation) return;
          if (outcome === 'unreachable') { this.d.failed(); return; }
          if (this.#queue[0] === play) this.#queue = this.#queue.slice(1);
          this.store();
        }
      } finally {
        settled = true;
        if (running && this.#flushing === running) this.#flushing = null;
      }
    })();
    if (!settled) this.#flushing = running;
    return running;
  }

  // Plays belong to one account: another one starts with none.
  bind(account: string) {
    if (this.#account === account) return;
    this.#generation++;
    this.#flushing = null;
    this.#account = account;
    this.#queue = [];
    this.store();
  }
  // Disconnect, or play reporting turned off: nothing waits, and nothing already sent comes back.
  clear() {
    this.#generation++;
    this.#flushing = null;
    if (!this.#queue.length) return;
    this.#queue = [];
    this.store();
  }

  private push(play: QueuedPlay) {
    this.#queue = queuePlay(this.#queue, play);
    this.store();
  }
  private store() {
    this.d.save({ account: this.#account, plays: this.#queue });
    this.d.changed(this.#queue.length);
  }
}
