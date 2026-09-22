import { Effect } from 'effect';
import type { OperationMetric } from './contracts';

// Aggregate by fixed operation names, never URLs, credentials, or track identifiers.
// The ring is bounded even in a session that stays open for weeks.
export class Metrics {
  private rows = new Map<string, { count: number; errors: number; samples: number[] }>();

  record(name: string, duration: number, failed: boolean) {
    const row = this.rows.get(name) ?? { count: 0, errors: 0, samples: [] };
    row.count++;
    if (failed) row.errors++;
    if (row.samples.length === 256) row.samples.shift();
    row.samples.push(duration);
    this.rows.set(name, row);
  }

  measure<A, E>(name: string, task: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      const start = performance.now();
      return task.pipe(Effect.tapBoth({
        onFailure: () => Effect.sync(() => this.record(name, performance.now() - start, true)),
        onSuccess: () => Effect.sync(() => this.record(name, performance.now() - start, false)),
      }), Effect.withSpan(name));
    });
  }

  snapshot(): OperationMetric[] {
    return Array.from(this.rows, ([name, row]) => {
      const sorted = [...row.samples].sort((a, b) => a - b);
      const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
      return { name, count: row.count, errors: row.errors, p50Ms: percentile(.5), p95Ms: percentile(.95) };
    });
  }
}
