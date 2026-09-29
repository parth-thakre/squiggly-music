import { describe, expect, it } from 'vitest';
import { Cause, Deferred, Effect, Either, Exit, Fiber, Option, Schema } from 'effect';
import { CommandSchema, ConnectionSchema } from '../packages/core/validation';
import { emptyAudio, emptyPlayer } from '../packages/core/contracts';
import { Metrics } from '../packages/core/metrics';
import { buildM3u, m3uEntry, m3uFileName, NO_PATH_NOTE, relativePath } from '../packages/core/m3u';
import { SaveM3uSchema } from '../packages/core/validation';
import type { M3uEntry, Track } from '../packages/core/contracts';

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
    expect(() => decode({ type: 'seek', seconds: 0, queueIndex: 0, trackId: 'x'.repeat(257) })).toThrow();
    expect(() => decode({ type: 'device', id: '' })).toThrow();
  });
  it('requires credentials without accepting unlimited payloads', () => {
    const connection = Schema.decodeUnknownSync(ConnectionSchema);
    expect(() => connection({ url: 'https://example.com', username: '', password: 'a' })).toThrow();
    expect(() => connection({ url: '', username: 'u', password: 'a' })).toThrow();
    expect(() => connection({ url: 'https://example.com', username: 'u', password: 'x'.repeat(4097) })).toThrow();
  });
});

describe('honest initial state', () => {
  it('does not infer an audio format, device, or throughput', () => {
    expect(emptyAudio().outputRate).toBeNull();
    expect(emptyAudio().streamBytesPerSecond).toBeNull();
    expect(emptyAudio().replayGain).toBeNull();
    expect(emptyPlayer().queue).toEqual([]);
    expect(emptyPlayer()).toMatchObject({ entryIds: [], playId: '', radio: null });
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

describe('M3U playlist files', () => {
  const entry = (extra: Partial<M3uEntry> = {}): M3uEntry => ({
    id: 's1', local: false, title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue', duration: 337.4, path: 'Miles Davis/Kind of Blue/03 - Blue in Green.flac', suffix: 'flac', ...extra,
  });
  const track = (extra: Partial<Track> = {}): Track => ({
    id: 's1', title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', duration: 562, source: 'navidrome', sourceFormat: 'flac',
    sourceSampleRate: 44100, sourceBitDepth: 16, path: 'Miles Davis/Kind of Blue/01 - So What.flac', ...extra,
  });

  it('writes an extended M3U with lengths, credits, and the paths the server reported', () => {
    expect(buildM3u([entry(), entry({ id: 's2', title: 'So What', duration: 562, path: '/music/Miles Davis/Kind of Blue/01 - So What.flac' })], 'Late Night')).toBe([
      '#EXTM3U', '#PLAYLIST:Late Night',
      '#EXTINF:337,Miles Davis - Blue in Green', 'Miles Davis/Kind of Blue/03 - Blue in Green.flac',
      '#EXTINF:562,Miles Davis - So What', '/music/Miles Davis/Kind of Blue/01 - So What.flac',
    ].join('\n') + '\n');
    expect(buildM3u([])).toBe('#EXTM3U\n');
  });

  it('writes an unknown length as -1, and a song without an artist by its title alone', () => {
    const text = buildM3u([entry({ duration: null }), entry({ duration: Number.NaN }), entry({ artist: '  ', duration: 0 })]);
    expect(text.split('\n').filter(line => line.startsWith('#EXTINF'))).toEqual([
      '#EXTINF:-1,Miles Davis - Blue in Green', '#EXTINF:-1,Miles Davis - Blue in Green', '#EXTINF:0,Blue in Green',
    ]);
  });

  it('keeps every entry on its own lines whatever the tags hold', () => {
    const text = buildM3u([entry({ title: 'Line\nbreak\r\n#EXTINF:1,Injected', artist: 'Tab\there', path: 'Folder/Two  spaces\n#EXTM3U.flac' }), entry({ path: '#hash/at start.flac' })], 'Name\nwith #PLAYLIST');
    const lines = text.trimEnd().split('\n');
    expect(lines).toEqual([
      '#EXTM3U', '#PLAYLIST:Name with #PLAYLIST',
      '#EXTINF:337,Tab here - Line break #EXTINF:1,Injected', 'Folder/Two  spaces #EXTM3U.flac',
      // A path starting with # would read as a comment.
      '#EXTINF:337,Miles Davis - Blue in Green', './#hash/at start.flac',
    ]);
    // Commas after the first one belong to the title.
    expect(buildM3u([entry({ artist: 'Crosby, Stills & Nash', title: 'Wooden Ships' })])).toContain('#EXTINF:337,Crosby, Stills & Nash - Wooden Ships\n');
  });

  it('writes songs without a path as artist/album/title.suffix, and says so at the top', () => {
    const text = buildM3u([entry(), entry({ path: null, artist: 'AC/DC', album: 'Back in Black', title: 'Hells Bells?', suffix: 'MP3' }), entry({ path: '  ', title: '..', album: '', artist: '', suffix: null })]);
    expect(text.split('\n')).toEqual([
      '#EXTM3U', NO_PATH_NOTE,
      '#EXTINF:337,Miles Davis - Blue in Green', 'Miles Davis/Kind of Blue/03 - Blue in Green.flac',
      '#EXTINF:337,AC/DC - Hells Bells?', 'AC-DC/Back in Black/Hells Bells_.mp3',
      '#EXTINF:337,..', 'Unknown artist/Unknown album/Untitled', '',
    ]);
    expect(buildM3u([entry()])).not.toContain(NO_PATH_NOTE);
    expect(relativePath({ artist: 'A\\B', album: 'C:D', title: 'E', suffix: 'fl/ac' })).toBe('A-B/C_D/E.flac');
  });

  it('takes songs from tracks without stream addresses, leaving local paths to the desktop', () => {
    expect(m3uEntry(track())).toEqual({ id: 's1', local: false, title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', duration: 562, path: 'Miles Davis/Kind of Blue/01 - So What.flac', suffix: 'flac' });
    expect(m3uEntry(track({ path: undefined })).path).toBeNull();
    // A local file's path never comes from the renderer: the main process fills it in.
    const local = m3uEntry(track({ source: 'local', path: '/home/me/Music/so-what.flac' }));
    expect(local).toMatchObject({ local: true, path: null });
    expect(buildM3u([{ ...local, path: '/home/me/Music/So What.flac' }, entry({ id: 'x', local: true, path: 'C:\\Music\\Blue.flac' })])).toBe(
      '#EXTM3U\n#EXTINF:562,Miles Davis - So What\n/home/me/Music/So What.flac\n#EXTINF:337,Miles Davis - Blue in Green\nC:\\Music\\Blue.flac\n');
  });

  it('names the file after the playlist, without characters file systems refuse', () => {
    expect(m3uFileName('Road Mix')).toBe('Road Mix.m3u8');
    expect(m3uFileName('Rock/Pop: "Best" of?')).toBe('Rock_Pop_ _Best_ of_.m3u8');
    expect(m3uFileName('  ..  ')).toBe('Playlist.m3u8');
    expect(m3uFileName('x'.repeat(300))).toBe(`${'x'.repeat(120)}.m3u8`);
  });

  it('bounds what the desktop accepts to save', () => {
    const decode = Schema.decodeUnknownEither(SaveM3uSchema);
    expect(Either.isRight(decode(['Road Mix', [entry()]]))).toBe(true);
    expect(Either.isRight(decode(['', [entry()]]))).toBe(false);
    expect(Either.isRight(decode(['Road Mix', [entry({ duration: -1 })]]))).toBe(false);
    expect(Either.isRight(decode(['Road Mix', [entry({ path: 'x'.repeat(4097) })]]))).toBe(false);
    expect(Either.isRight(decode(['Road Mix', Array.from({ length: 5001 }, () => entry())]))).toBe(false);
  });
});
