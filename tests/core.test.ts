import { describe, expect, it } from 'vitest';
import { Effect, Schema } from 'effect';
import { CommandSchema, ConnectionSchema } from '../packages/core/validation';
import { emptyAudio, emptyPlayer } from '../packages/core/contracts';
import { Metrics } from '../packages/core/metrics';

describe('command boundary', () => {
  const decode = Schema.decodeUnknownSync(CommandSchema);
  it.each([NaN, Infinity, -1, 101])('rejects unsafe volume %s', percent => {
    expect(() => decode({ type: 'volume', percent })).toThrow();
  });
  it.each([NaN, Infinity, -1, '10'])('rejects unsafe seek %s', seconds => {
    expect(() => decode({ type: 'seek', seconds })).toThrow();
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
    expect(emptyPlayer().playing).toBe(false);
  });
});

describe('bounded operation metrics', () => {
  it('retains only 256 timings but lifetime counts', () => {
    const metrics = new Metrics();
    for (let i = 0; i < 1000; i++) metrics.record('test', i, i % 10 === 0);
    expect(metrics.snapshot()).toEqual([{ name: 'test', count: 1000, errors: 100, p50Ms: 871, p95Ms: 987 }]);
  });
  it('preserves Effect success and failure and records both', async () => {
    const metrics = new Metrics();
    expect(await Effect.runPromise(metrics.measure('load', Effect.succeed(42)))).toBe(42);
    await Effect.runPromise(metrics.measure('load', Effect.fail('failed')).pipe(Effect.either));
    expect(metrics.snapshot()[0]).toMatchObject({ count: 2, errors: 1 });
  });
});
