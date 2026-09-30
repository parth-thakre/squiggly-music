import { ONLINE, type Reachability } from './contracts';

// Whether the server answers. One machine for every host: the desktop's main process, the browser
// build's page, and the Android page. No Node or DOM imports.
//
// A call that got no answer (Result.unreachable) does not by itself mean the server is gone: one
// slow request times out while the rest are fine. So a failure starts one confirming probe, and
// only a probe that gets no answer puts the app away. While away, the host answers library calls
// at once without asking the server, so the only way back is a probe that is answered: the timer
// every 30 seconds, Retry, or a passive check when the page regains focus or the network.
export type ProbeOutcome = { kind: 'answered'; name?: string } | { kind: 'unreachable' } | { kind: 'refused'; error: string };
export const PROBE_EVERY = 30_000, PROBE_TIMEOUT = 8_000, PASSIVE_GAP = 5_000, LAUNCH_WAIT = 4_000;
export const OUT_OF_REACH = 'Your server is out of reach. Try again when it is back.';

export interface ReachDeps {
  // The host enforces PROBE_TIMEOUT; a timeout is 'unreachable'.
  probe(): Promise<ProbeOutcome>;
  // Only on a real change of a field.
  changed(state: Reachability): void;
  // Away to online.
  returned?(outcome: ProbeOutcome): void;
  // A probe while away was answered, but refused (the account no longer signs in, say).
  refused?(error: string): void;
  now?(): number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
}

const realTimers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export class Reach {
  #state: Reachability = ONLINE;
  #probing: Promise<ProbeOutcome> | null = null;
  #timer: unknown = null;
  #generation = 0;
  #disposed = false;
  private readonly now: () => number;
  private readonly timers: NonNullable<ReachDeps['timers']>;

  constructor(private readonly deps: ReachDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
  }

  get state(): Reachability { return this.#state; }

  // A call got no answer. Online with no probe running: confirm with one probe.
  failed() {
    if (this.#disposed || this.#state.away || this.#probing) return;
    void this.probe(false);
  }

  // Away at once, with no confirming probe: at launch, when the saved server didn't answer in time.
  enter({ probeNow = false }: { probeNow?: boolean } = {}) {
    if (this.#disposed) return;
    const now = this.now();
    this.#generation++;
    this.#probing = null;
    this.set({ away: true, since: this.#state.since ?? now, checking: false, checkedAt: this.#state.checkedAt });
    this.clearTimer();
    if (probeNow) void this.probe(true);
    else this.schedule();
  }

  // Asks now. Null when online, or for a passive check made too soon after the last answer.
  async retry(passive = false): Promise<ProbeOutcome | null> {
    if (this.#disposed || !this.#state.away) return null;
    if (this.#probing) return this.#probing;
    if (passive && this.#state.checkedAt !== null && this.now() - this.#state.checkedAt < PASSIVE_GAP) return null;
    this.clearTimer();
    return this.probe(true);
  }

  // Online, whatever is in flight (a new sign-in, a disconnect).
  leave() {
    this.#generation++;
    this.#probing = null;
    this.clearTimer();
    this.set(ONLINE);
  }

  dispose() { this.leave(); this.#disposed = true; }

  private probe(away: boolean): Promise<ProbeOutcome> {
    const generation = this.#generation;
    this.set({ ...this.#state, checking: true });
    const running = this.deps.probe().catch((): ProbeOutcome => ({ kind: 'unreachable' })).then(outcome => {
      if (generation !== this.#generation || this.#disposed) return outcome;
      this.#probing = null;
      const now = this.now();
      if (!away) {
        // A confirming probe: only no answer at all puts the app away.
        if (outcome.kind === 'unreachable') { this.set({ away: true, since: now, checking: false, checkedAt: now }); this.schedule(); }
        else this.set({ ...this.#state, checking: false });
        return outcome;
      }
      if (outcome.kind === 'answered') {
        this.clearTimer();
        this.set({ away: false, since: null, checking: false, checkedAt: now });
        this.deps.returned?.(outcome);
        return outcome;
      }
      this.set({ ...this.#state, checking: false, checkedAt: now });
      this.schedule();
      if (outcome.kind === 'refused') this.deps.refused?.(outcome.error);
      return outcome;
    });
    this.#probing = running;
    return running;
  }
  private schedule() {
    this.clearTimer();
    if (this.#disposed || !this.#state.away) return;
    this.#timer = this.timers.set(() => { this.#timer = null; if (this.#state.away && !this.#probing) void this.probe(true); }, PROBE_EVERY);
  }
  private clearTimer() { if (this.#timer !== null) this.timers.clear(this.#timer); this.#timer = null; }
  private set(next: Reachability) {
    const was = this.#state;
    if (was.away === next.away && was.since === next.since && was.checking === next.checking && was.checkedAt === next.checkedAt) return;
    this.#state = next;
    this.deps.changed(next);
  }
}
