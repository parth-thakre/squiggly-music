import type { Result } from '../../../../packages/core/contracts';

type Sender = (percent: number) => Promise<Result>;
type Listener = () => void;

export class VolumeCommandCoalescer {
  private pending: number | null = null;
  private inFlight: number | null = null;
  private committed: number | null = null;
  private optimistic: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private confirmationTimer: ReturnType<typeof setTimeout> | null = null;
  private urgent = false;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly send: Sender,
    private readonly onError: (message: string) => void,
    private readonly delayMs = 80,
    private readonly confirmationTimeoutMs = 1000,
  ) {}

  get value() { return this.optimistic; }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  enqueue(percent: number) {
    this.clearConfirmationTimer();
    this.committed = null;
    this.optimistic = percent;
    this.pending = percent;
    this.emit();
    if (this.inFlight === null && this.timer === null) this.schedule(this.delayMs);
  }

  finish() {
    this.urgent = true;
    this.clearTimer();
    if (this.inFlight === null) void this.flush();
  }

  confirm(volume: number) {
    if (this.pending !== null || this.inFlight !== null || this.committed === null) return;
    if (Math.round(volume) !== this.committed) return;
    this.clearOptimistic();
  }

  cancel() {
    this.clearTimer();
    this.clearConfirmationTimer();
    this.pending = null;
    this.committed = null;
    this.optimistic = null;
    this.urgent = false;
    this.emit();
  }

  private schedule(delay: number) {
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delay);
  }

  private async flush() {
    this.clearTimer();
    if (this.inFlight !== null || this.pending === null) return;
    const percent = this.pending;
    this.pending = null;
    this.inFlight = percent;
    try {
      const result = await this.send(percent);
      if (!result.ok) throw new Error(result.error);
      if (this.pending === null && this.optimistic === percent) {
        this.committed = percent;
        this.armConfirmationTimeout(percent);
      }
    } catch (error) {
      this.onError(error instanceof Error ? error.message : 'Could not reach the desktop process.');
      if (this.pending === null && this.optimistic === percent) this.clearOptimistic();
    } finally {
      this.inFlight = null;
      if (this.pending !== null) {
        const delay = this.urgent ? 0 : this.delayMs;
        this.urgent = false;
        this.schedule(delay);
      } else {
        this.urgent = false;
        this.emit();
      }
    }
  }

  private armConfirmationTimeout(percent: number) {
    this.clearConfirmationTimer();
    this.confirmationTimer = setTimeout(() => {
      this.confirmationTimer = null;
      if (this.pending === null && this.inFlight === null && this.committed === percent) this.clearOptimistic();
    }, this.confirmationTimeoutMs);
  }

  private clearOptimistic() {
    this.clearConfirmationTimer();
    this.committed = null;
    this.optimistic = null;
    this.emit();
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private clearConfirmationTimer() {
    if (this.confirmationTimer !== null) clearTimeout(this.confirmationTimer);
    this.confirmationTimer = null;
  }

  private emit() { this.listeners.forEach(listener => listener()); }
}
