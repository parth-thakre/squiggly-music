import { Cause, Effect, Exit } from 'effect';
import type { OperationMetric } from './contracts';

// Aggregate by fixed operation names, never URLs, credentials, or track identifiers.
// The ring is bounded even in a session that stays open for weeks.
export class Metrics {
  private rows = new Map<string, { count: number; errors: number; cancelled: number; samples: number[] }>();

  record(name: string, duration: number, failed: boolean, cancelled = false) {
    const row = this.rows.get(name) ?? { count: 0, errors: 0, cancelled: 0, samples: [] };
    row.count++;
    if (failed) row.errors++;
    if (cancelled) row.cancelled++;
    if (row.samples.length === 256) row.samples.shift();
    row.samples.push(duration);
    this.rows.set(name, row);
  }

  measure<A, E>(name: string, task: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      const start = performance.now();
      return task.pipe(Effect.onExit(exit => Effect.sync(() => {
        const failed = Exit.isFailure(exit);
        this.record(name, performance.now() - start,
          failed && !Cause.isInterruptedOnly(exit.cause),
          failed && Cause.isInterrupted(exit.cause));
      })), Effect.withSpan(name));
    });
  }

  snapshot(): OperationMetric[] {
    return Array.from(this.rows, ([name, row]) => {
      const sorted = [...row.samples].sort((a, b) => a - b);
      const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
      return { name, count: row.count, errors: row.errors, cancelled: row.cancelled, p50Ms: percentile(.5), p95Ms: percentile(.95) };
    });
  }
}
