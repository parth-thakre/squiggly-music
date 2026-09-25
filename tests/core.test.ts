import { describe, expect, it } from 'vitest';
import { Cause, Deferred, Effect, Either, Exit, Fiber, Option, Schema } from 'effect';
import { CommandSchema, ConnectionSchema } from '../packages/core/validation';
import { emptyAudio, emptyPlayer } from '../packages/core/contracts';
import { Metrics } from '../packages/core/metrics';

describe('command boundary', () => {
  const decode = Schema.decodeUnknownSync(CommandSchema);
  it.each([NaN, Infinity, -1, 101])('rejects unsafe volume %s', percent => {
    expect(() => decode({ type: 'volume', percent })).toThrow();
  });
  it.each([NaN, Infinity, -1, '10'])('rejects unsafe seek %s', seconds => {
    expect(() => decode({ type: 'seek', seconds, queueIndex: 0, trackId: 'track' })).toThrow();
  });
  it('requires a bounded queue identity for seeks', () => {
    expect(() => decode({ type: 'seek', seconds: 10, queueIndex: -1, trackId: 'track' })).toThrow();
    expect(() => decode({ type: 'seek', seconds: 10, queueIndex: 1000, trackId: 'track' })).toThrow();
    expect(() => decode({ type: 'seek', seconds: 10, queueIndex: 0, trackId: '' })).toThrow();
    expect(decode({ type: 'seek', seconds: 10, queueIndex: 0, trackId: 'track' }))
      .toEqual({ type: 'seek', seconds: 10, queueIndex: 0, trackId: 'track' });
  });
  it('accepts the queue entry a seek began on, bounded like other ids', () => {
    expect(decode({ type: 'seek', seconds: 1, queueIndex: 999, trackId: 'track', entryId: 'abc.1' }))
      .toEqual({ type: 'seek', seconds: 1, queueIndex: 999, trackId: 'track', entryId: 'abc.1' });
    expect(() => decode({ type: 'seek', seconds: 1, queueIndex: 0, trackId: 'track', entryId: '' })).toThrow();
    expect(() => decode({ type: 'seek', seconds: 1, queueIndex: 0, trackId: 'track', entryId: 'x'.repeat(257) })).toThrow();
  });
  it('allows unity and attenuation, not amplification', () => {
    expect(decode({ type: 'volume', percent: 100 })).toEqual({ type: 'volume', percent: 100 });
    expect(decode({ type: 'volume', percent: 0 })).toEqual({ type: 'volume', percent: 0 });
  });
  it('does not expose arbitrary native commands', () => {
    expect(() => decode({ type: 'run', args: ['exec', 'something'] })).toThrow();
    expect(() => decode({ type: 'loadfile', path: '/secret' })).toThrow();
  });
  it('bounds string payloads', () => {
    expect(() => decode({ type: 'select', id: 'x'.repeat(257) })).toThrow();
    expect(() => decode({ type: 'device', id: '' })).toThrow();
  });
  it('requires credentials without accepting unlimited payloads', () => {
    const connection = Schema.decodeUnknownSync(ConnectionSchema);
    expect(() => connection({ url: 'https://example.com', username: '', password: 'a' })).toThrow();
    expect(() => connection({ url: 'https://example.com', username: 'u', password: 'x'.repeat(4097) })).toThrow();
  });
});

describe('honest initial state', () => {
  it('does not infer an audio format, device, or throughput', () => {
    expect(emptyAudio().outputRate).toBeNull();
    expect(emptyAudio().streamBytesPerSecond).toBeNull();
    expect(emptyAudio().replayGain).toBeNull();
    expect(emptyPlayer().queue).toEqual([]);
    expect(emptyPlayer()).toMatchObject({ entryIds: [], radio: null });
    expect(emptyPlayer().playing).toBe(false);
  });
});

describe('bounded operation metrics', () => {
  it('retains only 256 timings but lifetime counts', () => {
    const metrics = new Metrics();
    for (let i = 0; i < 1000; i++) metrics.record('test', i, i % 10 === 0);
    expect(metrics.snapshot()).toEqual([{ name: 'test', count: 1000, errors: 100, cancelled: 0, p50Ms: 871, p95Ms: 987 }]);
  });
  it('preserves Effect success and failure and records both', async () => {
    const metrics = new Metrics();
    expect(await Effect.runPromise(metrics.measure('load', Effect.succeed(42)))).toBe(42);
    const result = await Effect.runPromise(metrics.measure('load', Effect.fail('failed')).pipe(Effect.either));
    expect(result).toEqual(Either.left('failed'));
    expect(metrics.snapshot()[0]).toMatchObject({ count: 2, errors: 1, cancelled: 0 });
  });
  it('preserves defects and records an error and latency sample', async () => {
    const metrics = new Metrics();
    const defect = 'defect';
    const exit = await Effect.runPromiseExit(metrics.measure('defect', Effect.die(defect)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Option.getOrThrow(Cause.dieOption(exit.cause))).toBe(defect);
    expect(metrics.snapshot()[0]).toMatchObject({ name: 'defect', count: 1, errors: 1, cancelled: 0 });
    expect(metrics.snapshot()[0].p50Ms).toBeGreaterThanOrEqual(0);
    expect(metrics.snapshot()[0].p95Ms).toBe(metrics.snapshot()[0].p50Ms);
  });
  it('preserves interruption and records a cancellation and latency sample', async () => {
    const metrics = new Metrics();
    const exit = await Effect.runPromise(Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const fiber = yield* Effect.fork(metrics.measure('cancelled', Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never))));
      yield* Deferred.await(started);
      return yield* Fiber.interrupt(fiber);
    }));
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true);
    expect(metrics.snapshot()[0]).toMatchObject({ name: 'cancelled', count: 1, errors: 0, cancelled: 1 });
    expect(metrics.snapshot()[0].p50Ms).toBeGreaterThanOrEqual(0);
    expect(metrics.snapshot()[0].p95Ms).toBe(metrics.snapshot()[0].p50Ms);
  });
});
