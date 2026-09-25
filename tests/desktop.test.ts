import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Either, Schema } from 'effect';
import { emptyPlayer, type PlayerSnapshot, type Track } from '../packages/core/contracts';
import {
  defaultSettings, QUEUE_LIMIT, QueueAddSchema, QueueJumpSchema, QueueMoveSchema, QueueRemoveSchema, RadioSeedSchema,
  SettingsFileSchema, SettingsPatchSchema, WindowStateSchema,
} from '../packages/core/desktopValidation';
import { LibraryRequestSchemas, PlayTracksSchema, QUEUE_LIMIT as CORE_QUEUE_LIMIT } from '../packages/core/validation';
import { Radio, type RadioClient } from '../apps/desktop/main/radio';
import { QUEUE_LIMIT as HOST_QUEUE_LIMIT } from '../packages/player-mpv/queue';
import { JsonStore } from '../apps/desktop/main/store';
import { finishThreshold, PlayTracker } from '../apps/desktop/main/plays';
import { QueueSync, savedState, type SavedState } from '../apps/desktop/main/queueSync';

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  vi.useRealTimers(); vi.doUnmock('@jellybrick/mpris-service'); vi.resetModules();
});

const track = (id: string, source: Track['source'] = 'navidrome', duration: number | null = 200): Track => ({
  id, title: id, artist: 'Artist', album: 'Album', duration, source, sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null,
});
const snapshot = (changes: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
  ...emptyPlayer(), engine: 'ready', queue: [track('a'), track('b')], currentIndex: 0, duration: 200, ...changes,
});

describe('desktop request schemas', () => {
  it('bounds queue edits to the host queue limit', () => {
    expect(QUEUE_LIMIT).toBe(HOST_QUEUE_LIMIT);
    const add = Schema.decodeUnknownSync(QueueAddSchema);
    expect(add([['a'], 'next'])).toEqual([['a'], 'next']);
    expect(() => add([[], 'end'])).toThrow();
    expect(() => add([['a'], 'first'])).toThrow();
    expect(() => add([Array(1001).fill('a'), 'end'])).toThrow();
    const move = Schema.decodeUnknownSync(QueueMoveSchema);
    expect(move([0, 999])).toEqual([0, 999]);
    for (const bad of [[-1, 0], [0, 1000], [0.5, 1], ['1', 2]]) expect(() => move(bad)).toThrow();
    expect(() => Schema.decodeUnknownSync(QueueRemoveSchema)([[]])).toThrow();
    const jump = Schema.decodeUnknownSync(QueueJumpSchema);
    expect(jump([999, 'e.1'])).toEqual([999, 'e.1']);
    for (const bad of [[1000, 'e.1'], [-1, 'e.1'], [0, ''], [0, 'x'.repeat(257)], [0], ['0', 'e.1']]) expect(() => jump(bad)).toThrow();
  });

  it('shares one queue limit between play requests, edits, saves, and the host', () => {
    expect(CORE_QUEUE_LIMIT).toBe(QUEUE_LIMIT);
    const play = Schema.decodeUnknownEither(PlayTracksSchema);
    expect(Either.isRight(play([Array(1000).fill('a'), 999]))).toBe(true);
    expect(Either.isRight(play([Array(1001).fill('a'), 0]))).toBe(false);
    expect(Either.isRight(play([['a'], 1000]))).toBe(false);
    expect(Either.isRight(Schema.decodeUnknownEither(LibraryRequestSchemas.createPlaylist)(['Queue', Array(1000).fill('a')]))).toBe(true);
    expect(Either.isRight(Schema.decodeUnknownEither(LibraryRequestSchemas.saveQueue)([Array(1001).fill('a'), 0, 0]))).toBe(false);
  });

  it('accepts song, album, and artist radio seeds only', () => {
    const seed = Schema.decodeUnknownSync(RadioSeedSchema);
    expect(seed({ kind: 'song', trackId: 's1', label: 'Song' })).toEqual({ kind: 'song', trackId: 's1', label: 'Song' });
    expect(seed({ kind: 'artist', id: 'ar1', label: 'Artist' })).toEqual({ kind: 'artist', id: 'ar1', label: 'Artist' });
    for (const bad of [{ kind: 'song', id: 's1', label: 'x' }, { kind: 'album', id: 'a1', label: '' }, { kind: 'genre', id: 'g', label: 'x' },
      { kind: 'album', id: 'a1', label: 'x'.repeat(257) }, { kind: 'song', trackId: 's1', label: 'x', track: { id: 's1' } }]) {
      expect(Either.isRight(Schema.decodeUnknownEither(RadioSeedSchema)(bad, { onExcessProperty: 'error' }))).toBe(false);
    }
  });

  it('fills missing settings with defaults and rejects wrong types', () => {
    expect(defaultSettings()).toEqual({ lyricsLookup: false, exclusiveOutput: false, closeToTray: process.platform !== 'linux', syncQueue: true, reportPlays: true, miniOnTop: true });
    expect(Schema.decodeUnknownSync(SettingsFileSchema)({ lyricsLookup: true, unknown: 1 })).toEqual({ ...defaultSettings(), lyricsLookup: true });
    // A file written before the mini player's pin became a setting keeps it pinned.
    expect(Schema.decodeUnknownSync(SettingsFileSchema)({ syncQueue: false }).miniOnTop).toBe(true);
    expect(Schema.decodeUnknownSync(SettingsFileSchema)({ miniOnTop: false }).miniOnTop).toBe(false);
    expect(() => Schema.decodeUnknownSync(SettingsFileSchema)({ closeToTray: 'yes' })).toThrow();
    expect(() => Schema.decodeUnknownSync(SettingsFileSchema)({ miniOnTop: 'no' })).toThrow();
  });

  it('accepts only known, defined setting changes', () => {
    const patch = (value: unknown) => Schema.decodeUnknownSync(SettingsPatchSchema)(value, { onExcessProperty: 'error' });
    expect(patch({ exclusiveOutput: true })).toEqual({ exclusiveOutput: true });
    expect(patch({ miniOnTop: false })).toEqual({ miniOnTop: false });
    expect(() => patch({ miniOnTop: undefined })).toThrow();
    expect(patch({})).toEqual({});
    expect(() => patch({ lyricsLookup: undefined })).toThrow();
    expect(() => patch({ lyricsLookup: 1 })).toThrow();
    expect(() => patch({ password: 'x' })).toThrow();
    expect(() => patch(null)).toThrow();
  });
});

describe('validated JSON files', () => {
  it('reads defaults for missing, invalid, mistyped, and oversized files', async () => {
    directory = await mkdtemp(join(tmpdir(), 'squiggly-store-'));
    const path = join(directory, 'settings.json');
    const load = () => new JsonStore(path, SettingsFileSchema, defaultSettings()).load();
    expect(await load()).toEqual(defaultSettings());
    await writeFile(path, '{not json');
    expect(await load()).toEqual(defaultSettings());
    await writeFile(path, JSON.stringify({ lyricsLookup: 'true' }));
    expect(await load()).toEqual(defaultSettings());
    await writeFile(path, JSON.stringify({ lyricsLookup: true, padding: 'x'.repeat(70_000) }));
    expect(await load()).toEqual(defaultSettings());
  });

  it('writes atomically with private permissions and reads back what it wrote', async () => {
    directory = await mkdtemp(join(tmpdir(), 'squiggly-store-'));
    const path = join(directory, 'nested', 'window-state.json');
    const store = new JsonStore(path, WindowStateSchema, {});
    await Promise.all([
      store.save({ mini: { x: 0, y: 0, width: 400, height: 100 } }),
      store.save({ mini: { x: 10, y: -20, width: 420, height: 112 } }),
    ]);
    expect(store.value).toEqual({ mini: { x: 10, y: -20, width: 420, height: 112 } });
    expect(await new JsonStore(path, WindowStateSchema, {}).load()).toEqual(store.value);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(store.value);
  });

  it('refuses to write an invalid value', async () => {
    directory = await mkdtemp(join(tmpdir(), 'squiggly-store-'));
    const store = new JsonStore(join(directory, 'w.json'), WindowStateSchema, {});
    expect(() => store.save({ mini: { x: 0.5, y: 0, width: 1, height: 1 } })).toThrow();
    expect(store.value).toEqual({});
  });

  it('reads older window files whose pin preference now lives in settings', async () => {
    directory = await mkdtemp(join(tmpdir(), 'squiggly-store-'));
    const path = join(directory, 'window-state.json');
    await writeFile(path, JSON.stringify({ alwaysOnTop: false, mini: { x: 1, y: 2, width: 420, height: 112 } }));
    expect(await new JsonStore(path, WindowStateSchema, {}).load()).toEqual({ mini: { x: 1, y: 2, width: 420, height: 112 } });
  });
});

describe('play reporting', () => {
  // Plays a snapshot sequence at 4 Hz from `from` seconds, returning the events.
  function play(tracker: PlayTracker, seconds: number, from = 0, changes: Partial<PlayerSnapshot> = {}, start = 0) {
    const events = [];
    for (let tick = 0; tick <= seconds * 4; tick++) {
      events.push(...tracker.update(snapshot({ playing: true, position: from + tick / 4, ...changes }), start + tick * 250));
    }
    return events;
  }

  it('reports the start once and the finish after half the song has actually played', () => {
    const tracker = new PlayTracker();
    expect(play(tracker, 99)).toEqual([{ trackId: 'a', event: 'started' }]);
    expect(play(tracker, 2, 99, {}, 99_000)).toEqual([{ trackId: 'a', event: 'finished' }]);
    expect(play(tracker, 50, 101, {}, 101_000)).toEqual([]);
  });

  it('uses four minutes for long songs and never finishes songs of 30 seconds or less', () => {
    expect(finishThreshold(1200)).toBe(240);
    expect(finishThreshold(31)).toBe(15.5);
    expect(finishThreshold(30)).toBeNull();
    const tracker = new PlayTracker();
    expect(play(tracker, 30, 0, { duration: 30 }).map(event => event.event)).toEqual(['started']);
  });

  it('does not count seeks or paused time', () => {
    const tracker = new PlayTracker();
    play(tracker, 10);
    // A seek to 150 s of a 200 s song, then 20 s of playback: 30 s listened, not 170.
    expect(play(tracker, 20, 150, {}, 10_250)).toEqual([]);
    // Paused snapshots advance neither time nor events.
    for (let tick = 0; tick < 400; tick++) expect(tracker.update(snapshot({ playing: false, position: 170 }), 31_000 + tick * 250)).toEqual([]);
    expect(play(tracker, 71, 170, {}, 131_000).map(event => event.event)).toEqual(['finished']);
  });

  it('never reports local files and waits for playback to start', () => {
    const tracker = new PlayTracker();
    expect(play(tracker, 150, 0, { queue: [track('local', 'local')] })).toEqual([]);
    expect(tracker.update(snapshot({ playing: false }), 0)).toEqual([]);
    expect(tracker.update(snapshot({ playing: true }), 250)).toEqual([{ trackId: 'a', event: 'started' }]);
  });

  it('starts a new play for another entry but not for a queue edit that shifts the current one', () => {
    const tracker = new PlayTracker();
    play(tracker, 20);
    // The current song moved from index 0 to 1 while playing on.
    expect(tracker.update(snapshot({ playing: true, position: 20.25, queue: [track('b'), track('a')], currentIndex: 1 }), 20_250)).toEqual([]);
    // The same song again at another entry restarts from zero.
    const repeated = snapshot({ playing: true, position: 0, queue: [track('a'), track('a')], currentIndex: 0 });
    expect(tracker.update(repeated, 21_000)).toEqual([{ trackId: 'a', event: 'started' }]);
    expect(tracker.update(snapshot({ playing: true, position: 1, currentIndex: 1 }), 22_000)).toEqual([{ trackId: 'b', event: 'started' }]);
    // Stopping ends the play; playing the song again reports a new start.
    expect(tracker.update(snapshot({ currentIndex: -1 }), 23_000)).toEqual([]);
    expect(tracker.update(snapshot({ playing: true, currentIndex: 1 }), 24_000)).toEqual([{ trackId: 'b', event: 'started' }]);
  });

  it('follows queue entry ids when the snapshot has them', () => {
    const tracker = new PlayTracker();
    const queue = [track('a'), track('b'), track('a')];
    const at = (currentIndex: number, position: number, entryIds = ['e1', 'e2', 'e3']) => snapshot({ playing: true, queue, entryIds, currentIndex, position });
    expect(tracker.update(at(0, 5), 0)).toEqual([{ trackId: 'a', event: 'started' }]);
    // The same entry moved to the end while playing on: the same play, whatever the position does.
    expect(tracker.update(at(2, 5.25, ['e2', 'e3', 'e1']), 250)).toEqual([]);
    // The other copy of A, even at a later position than the first reached, is a new play.
    expect(tracker.update(at(2, 9, ['e2', 'e1', 'e3']), 500)).toEqual([{ trackId: 'a', event: 'started' }]);
  });
});

describe('queue sync', () => {
  function sync() {
    const saves: { state: unknown; generation: number }[] = [];
    let fail = false;
    const queue = new QueueSync(async (state, generation) => {
      saves.push({ state, generation });
      if (fail) throw new Error('offline');
    });
    return { queue, saves, failNext: (value: boolean) => { fail = value; } };
  }

  it('saves only complete server queues', () => {
    expect(savedState(snapshot({ position: 12.7 }))).toEqual({ trackIds: ['a', 'b'], currentIndex: 0, positionSeconds: 12 });
    expect(savedState(snapshot({ queue: [track('a'), track('l', 'local')] }))).toBeNull();
    expect(savedState(snapshot({ queue: [] }))).toBeNull();
    expect(savedState(snapshot({ currentIndex: -1, position: 50 }))).toEqual({ trackIds: ['a', 'b'], currentIndex: 0, positionSeconds: 0 });
  });

  it('debounces track changes, pauses, and queue edits into one save', async () => {
    vi.useFakeTimers();
    const { queue, saves } = sync();
    queue.observe(snapshot({ playing: true }), 3, true);
    queue.observe(snapshot({ playing: true, currentIndex: 1, position: 1 }), 3, true);
    await vi.advanceTimersByTimeAsync(2000);
    queue.observe(snapshot({ playing: false, currentIndex: 1, position: 2 }), 3, true);
    queue.observe(snapshot({ playing: false, currentIndex: 1, position: 2, queue: [track('a'), track('b'), track('c')] }), 3, true);
    await vi.advanceTimersByTimeAsync(2999);
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toEqual([{ state: { trackIds: ['a', 'b', 'c'], currentIndex: 1, positionSeconds: 2 }, generation: 3 }]);
    // Nothing changed: no second write.
    queue.observe(snapshot({ playing: true, currentIndex: 0, position: 2, queue: [track('a'), track('b'), track('c')] }), 3, true);
    queue.observe(snapshot({ playing: false, currentIndex: 1, position: 2, queue: [track('a'), track('b'), track('c')] }), 3, true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(saves).toHaveLength(1);
  });

  it('saves every 30 seconds while playing and retries after a silent failure', async () => {
    vi.useFakeTimers();
    const { queue, saves, failNext } = sync();
    failNext(true);
    for (let second = 0; second <= 61; second++) {
      queue.observe(snapshot({ playing: true, position: second }), 1, true);
      await vi.advanceTimersByTimeAsync(1000);
      if (second === 45) failNext(false);
    }
    expect(saves.map(save => (save.state as { positionSeconds: number }).positionSeconds)).toEqual([30, 60]);
  });

  it('stops when disabled or reset, and flushes the latest state on demand', async () => {
    vi.useFakeTimers();
    const { queue, saves } = sync();
    queue.observe(snapshot({ playing: true }), 1, true);
    queue.observe(snapshot({ playing: false, position: 5 }), 1, true);
    queue.observe(snapshot({ playing: false, position: 5 }), 1, false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(saves).toEqual([]);
    queue.observe(snapshot({ playing: true, position: 5 }), 2, true);
    queue.observe(snapshot({ playing: true, position: 6, currentIndex: 1 }), 2, true);
    queue.reset();
    await vi.advanceTimersByTimeAsync(5000);
    expect(saves).toEqual([]);
    queue.observe(snapshot({ playing: true, position: 7 }), 2, true);
    await queue.flush();
    expect(saves).toEqual([{ state: { trackIds: ['a', 'b'], currentIndex: 0, positionSeconds: 7 }, generation: 2 }]);
  });

  it('coalesces saves requested while one is in flight', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const saves: number[] = [];
    const queue = new QueueSync(state => { saves.push(state.positionSeconds); return saves.length === 1 ? new Promise(done => { release = done; }) : Promise.resolve(); });
    queue.observe(snapshot({ position: 50 }), 1, true);
    const first = queue.flush();
    queue.observe(snapshot({ position: 60 }), 1, true);
    void queue.flush();
    queue.observe(snapshot({ position: 70 }), 1, true);
    const last = queue.flush();
    release(); await first; await last;
    expect(saves).toEqual([50, 70]);
    // Within two seconds of the saved position is the same state.
    queue.observe(snapshot({ position: 71 }), 1, true);
    await queue.flush();
    expect(saves).toEqual([50, 70]);
  });

  it('does not overwrite a restored position before the restore seek lands', async () => {
    vi.useFakeTimers();
    const { queue, saves } = sync();
    queue.observe(snapshot({ queue: [] }), 1, true);
    queue.markSaved({ trackIds: ['a', 'b'], currentIndex: 1, positionSeconds: 83 });
    // The host reports the restored entry at 0 s while its stream opens.
    queue.observe(snapshot({ currentIndex: 1, position: 0 }), 1, true);
    await vi.advanceTimersByTimeAsync(3000);
    await queue.flush();
    expect(saves).toEqual([]);
    queue.observe(snapshot({ currentIndex: 1, position: 83, playing: true }), 1, true);
    await vi.advanceTimersByTimeAsync(10_000);
    queue.observe(snapshot({ currentIndex: 1, position: 90, playing: false }), 1, true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(saves.map(save => save.state)).toEqual([{ trackIds: ['a', 'b'], currentIndex: 1, positionSeconds: 90 }]);
  });

  // Deferred saves: the first save stays in flight until released.
  function delayed() {
    const saves: { state: SavedState; generation: number }[] = [];
    let release!: () => void;
    const queue = new QueueSync((state, generation) => {
      saves.push({ state, generation });
      return saves.length === 1 ? new Promise<void>(done => { release = done; }) : Promise.resolve();
    });
    return { queue, saves, release: () => release() };
  }

  it('does not let a save that settles after a restore mark the restored queue saved', async () => {
    vi.useFakeTimers();
    const { queue, saves, release } = delayed();
    queue.observe(snapshot({ position: 50 }), 1, true);
    const first = queue.flush();
    // Resume loads another queue while the old one's save is still on its way to the server.
    const restored = [track('c'), track('d')];
    queue.markSaved({ trackIds: ['c', 'd'], currentIndex: 1, positionSeconds: 83 });
    queue.observe(snapshot({ queue: restored, currentIndex: 1, position: 0 }), 1, true);
    release(); await first;
    await vi.advanceTimersByTimeAsync(3000);
    // Held: the restore seek has not landed yet.
    expect(saves).toHaveLength(1);
    queue.observe(snapshot({ queue: restored, currentIndex: 1, position: 83 }), 1, true);
    await vi.advanceTimersByTimeAsync(9000);
    // The older save may have overwritten the server's queue, so the restored one is written back.
    expect(saves.map(save => save.state)).toEqual([
      { trackIds: ['a', 'b'], currentIndex: 0, positionSeconds: 50 },
      { trackIds: ['c', 'd'], currentIndex: 1, positionSeconds: 83 },
    ]);
  });

  it('does not let a save that settles after a reset count for the next session', async () => {
    vi.useFakeTimers();
    const { queue, saves, release } = delayed();
    queue.observe(snapshot({ position: 50 }), 1, true);
    const first = queue.flush();
    queue.reset();
    release(); await first;
    // The same queue and position in the new session has not been saved there yet.
    queue.observe(snapshot({ position: 50 }), 2, true);
    await queue.flush();
    expect(saves.map(save => save.generation)).toEqual([1, 2]);
  });

  it('runs the final save queued behind one in flight, under the session it was taken in', async () => {
    vi.useFakeTimers();
    const { queue, saves, release } = delayed();
    queue.observe(snapshot({ position: 50 }), 4, true);
    void queue.flush();
    queue.observe(snapshot({ position: 70 }), 4, true);
    const final = queue.flush();
    // Quit then ends the session: later snapshots arrive disabled, under a newer generation.
    queue.observe(snapshot({ position: 71 }), 5, false);
    release(); await final;
    expect(saves.map(save => [save.state.positionSeconds, save.generation])).toEqual([[50, 4], [70, 4]]);
  });

  it('releases the hold as soon as the user moves to another song', async () => {
    vi.useFakeTimers();
    const { queue, saves } = sync();
    queue.markSaved({ trackIds: ['a', 'b'], currentIndex: 0, positionSeconds: 83 });
    queue.observe(snapshot({ currentIndex: 0, position: 0 }), 1, true);
    queue.observe(snapshot({ currentIndex: 1, position: 0, playing: true }), 1, true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(saves.map(save => save.state)).toEqual([{ trackIds: ['a', 'b'], currentIndex: 1, positionSeconds: 0 }]);
  });
});

describe('MPRIS media controls', () => {
  async function mpris() {
    class FakePlayer extends EventEmitter {
      static instance: FakePlayer;
      metadata: Record<string, unknown> = {};
      playbackStatus = 'Stopped'; volume = 0; canPlay = true; canPause = true; canSeek = true; canGoNext = true; canGoPrevious = true;
      getPosition = () => 0;
      seeked = vi.fn();
      constructor(readonly options: unknown) { super(); FakePlayer.instance = this; }
      objectPath(subpath: string) { return `/org/node/mediaplayer/squiggly/${subpath}`; }
    }
    vi.doMock('@jellybrick/mpris-service', () => ({ default: FakePlayer }));
    const { startMpris } = await import('../apps/desktop/main/mpris');
    const controls = { command: vi.fn(), seek: vi.fn(), volume: vi.fn(), raise: vi.fn(), quit: vi.fn() };
    const onError = vi.fn();
    const session = (await startMpris(controls, onError))!;
    return { session, service: FakePlayer.instance, controls, onError };
  }

  it('publishes display metadata without server URLs and maps transport', async () => {
    const { session, service, controls } = await mpris();
    session.update(snapshot({ playing: true, position: 12, queue: [{ ...track('secret-id'), coverArt: 'al-1' }] }), 'file:///tmp/squiggly-art-x/cover-1.jpeg');
    expect(service.metadata).toEqual({
      'mpris:trackid': '/org/node/mediaplayer/squiggly/track/1', 'mpris:length': 200_000_000,
      'xesam:title': 'secret-id', 'xesam:artist': ['Artist'], 'xesam:album': 'Album', 'mpris:artUrl': 'file:///tmp/squiggly-art-x/cover-1.jpeg',
    });
    expect(JSON.stringify(service.metadata)).not.toMatch(/https?:/);
    expect(service.playbackStatus).toBe('Playing');
    expect(service).toMatchObject({ canGoNext: false, canGoPrevious: false, canSeek: true, volume: 1 });
    service.emit('playpause');
    expect(controls.command).toHaveBeenCalledWith('pause');
    service.emit('next'); service.emit('raise');
    expect(controls.command).toHaveBeenCalledWith('next');
    expect(controls.raise).toHaveBeenCalled();
    service.emit('volume', 1.7);
    expect(controls.volume).toHaveBeenCalledWith(100);
  });

  it('maps Seek and SetPosition to the current track only, and signals jumps', async () => {
    const { session, service, controls } = await mpris();
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    session.update(snapshot({ playing: false, position: 50 }), null);
    expect(service.getPosition()).toBe(50_000_000);
    service.emit('seek', 10_000_000);
    expect(controls.seek).toHaveBeenLastCalledWith(60);
    service.emit('seek', -90_000_000);
    expect(controls.seek).toHaveBeenLastCalledWith(0);
    service.emit('seek', 500_000_000);
    expect(controls.command).toHaveBeenLastCalledWith('next');
    const trackId = service.metadata['mpris:trackid'];
    service.emit('position', { trackId: '/org/node/mediaplayer/squiggly/track/999', position: 5_000_000 });
    service.emit('position', { trackId, position: 900_000_000 });
    expect(controls.seek).toHaveBeenCalledTimes(2);
    service.emit('position', { trackId, position: 5_000_000 });
    expect(controls.seek).toHaveBeenLastCalledWith(5);
    session.update(snapshot({ playing: false, position: 120 }), null);
    expect(service.seeked).toHaveBeenCalledWith(120_000_000);
    session.update(snapshot({ currentIndex: -1 }), null);
    expect(service.playbackStatus).toBe('Stopped');
    expect(service.metadata).toEqual({});
  });

  it('keeps the track id when the current entry moves, and changes it for another copy of the song', async () => {
    const { session, service } = await mpris();
    session.update(snapshot({ playing: true, queue: [track('a'), track('b'), track('a')], entryIds: ['e1', 'e2', 'e3'], currentIndex: 0 }), null);
    const first = service.metadata['mpris:trackid'];
    const moved = [track('b'), track('a'), track('a')];
    session.update(snapshot({ playing: true, queue: moved, entryIds: ['e2', 'e1', 'e3'], currentIndex: 1 }), null);
    expect(service.metadata['mpris:trackid']).toBe(first);
    session.update(snapshot({ playing: true, queue: moved, entryIds: ['e2', 'e1', 'e3'], currentIndex: 2 }), null);
    expect(service.metadata['mpris:trackid']).not.toBe(first);
  });

  it('stops publishing after a bus error', async () => {
    const { session, service, onError } = await mpris();
    service.emit('error', new Error('no session bus'));
    service.emit('error', new Error('again'));
    expect(onError).toHaveBeenCalledOnce();
    session.update(snapshot({ playing: true }), null);
    expect(service.playbackStatus).toBe('Stopped');
  });
});

describe('main-process radio', () => {
  const album = { id: 'al', name: 'Record', artist: 'Artist', songCount: 2, artistId: null, year: null, genre: null, duration: null, coverArt: null, starred: false };
  const songs = (...ids: string[]) => ids.map(id => track(id));
  function fixture() {
    let entries = 0;
    let player = snapshot({ queue: [], currentIndex: -1 });
    const known = new Map<string, Track>();
    // Pending similar-song requests by seed, resolved by the test.
    const pending = new Map<string, (tracks: Track[]) => void>();
    let similar: (id: string) => Track[] | null = () => null;
    const client = {
      topSongs: vi.fn((_id: string, _count: number) => Effect.succeed(songs('top1', 'top2'))),
      album: vi.fn((_id: string) => Effect.succeed({ album, tracks: songs('al1', 'al2') })),
      similarSongs: vi.fn((id: string, _count: number) => {
        const ready = similar(id);
        return ready ? Effect.succeed(ready) : Effect.promise(() => new Promise<Track[]>(done => pending.set(id, done)));
      }),
    } satisfies RadioClient;
    let session: typeof client | null = client;
    const log: string[] = [];
    const radio: Radio<typeof client> = new Radio({
      client: () => session, player: () => player, known: id => known.get(id), remember: tracks => { for (const item of tracks) known.set(item.id, item); },
      replace: (_client, tracks) => Effect.sync(() => {
        log.push(`replace ${tracks.map(item => item.id).join(' ')}`);
        player = snapshot({ queue: tracks, entryIds: tracks.map(() => `e${++entries}`), currentIndex: 0, playing: true });
      }),
      append: (_client, tracks) => Effect.sync(() => {
        log.push(`append ${tracks.map(item => item.id).join(' ')}`);
        player = { ...player, queue: [...player.queue, ...tracks], entryIds: [...player.entryIds, ...tracks.map(() => `e${++entries}`)] };
      }),
      background: task => Effect.runPromise(Effect.either(task)),
      changed: () => log.push(`radio ${radio.view?.label ?? 'off'}`),
    });
    return {
      radio, client, known, log, pending,
      respond: (id: string, tracks: Track[]) => { pending.get(id)!(tracks); pending.delete(id); },
      setSimilar: (next: (id: string) => Track[] | null) => { similar = next; },
      player: () => player, play: (currentIndex: number) => { player = { ...player, currentIndex }; },
      disconnect: () => { session = null; },
    };
  }
  const run = (effect: Effect.Effect<void, Error>) => Effect.runPromise(Effect.either(effect));
  const flushAsync = () => new Promise(resolve => setTimeout(resolve, 0));

  it('starts artist radio from a top song and never asks for songs like the artist id', async () => {
    const { radio, client, known, log, setSimilar } = fixture();
    setSimilar(() => songs('top1', 's1', 's2', 's1'));
    expect(await run(radio.start({ kind: 'artist', id: 'ar1', label: 'Artist' }))).toEqual(Either.right(undefined));
    expect(client.topSongs).toHaveBeenCalledWith('ar1', 5);
    expect(client.similarSongs.mock.calls).toEqual([['top1', 40]]);
    // The start song first, then similar songs once each.
    expect(log).toEqual(['replace top1 s1 s2', 'radio Artist']);
    expect(radio.view).toEqual({ label: 'Artist' });
    // Radio tracks enter the known-track map, so the renderer can queue or play them by id.
    expect([...known.keys()]).toEqual(['top1', 's1', 's2']);
  });

  it('starts record radio from its first track and song radio from a known song', async () => {
    const { radio, client, known, log, setSimilar } = fixture();
    setSimilar(id => songs(`${id}-like`));
    await run(radio.start({ kind: 'album', id: 'al', label: 'Record' }));
    expect(client.album).toHaveBeenCalledWith('al');
    expect(log[0]).toBe('replace al1 al1-like');
    expect(await run(radio.start({ kind: 'song', trackId: 'unknown', label: 'Song' }))).toEqual(Either.left(new Error('That song is no longer loaded. Refresh the library and try again.')));
    known.set('x', track('x'));
    await run(radio.start({ kind: 'song', trackId: 'x', label: 'X' }));
    expect(log.slice(-3)).toEqual(['radio off', 'replace x x-like', 'radio X']);
  });

  it('reports a plain error when there is nothing to start from or nothing similar', async () => {
    const { radio, client, log, setSimilar } = fixture();
    client.topSongs.mockReturnValueOnce(Effect.succeed([]));
    expect(await run(radio.start({ kind: 'artist', id: 'ar1', label: 'A' }))).toEqual(Either.left(new Error('Radio needs a song to start from, and none was found.')));
    setSimilar(() => songs('top1'));
    const result = await run(radio.start({ kind: 'artist', id: 'ar1', label: 'A' }));
    expect(Either.isLeft(result) && result.left.message).toContain('nothing similar');
    expect(log).toEqual([]);
    expect(radio.view).toBeNull();
  });

  it('tops up once three or fewer songs follow the current one, with new songs only, one request at a time', async () => {
    const { radio, client, log, respond, play, player, setSimilar } = fixture();
    setSimilar(id => id === 'top1' ? songs('top1', 's1', 's2', 's3', 's4', 's5') : null);
    await run(radio.start({ kind: 'artist', id: 'ar1', label: 'A' }));
    client.topSongs.mockClear();
    play(1);
    // Four follow the current song: nothing yet.
    expect(radio.topUp()).toBeNull();
    play(2);
    const request = radio.topUp()!;
    expect(request).not.toBeNull();
    expect(client.similarSongs).toHaveBeenLastCalledWith('s5', 30);
    // Snapshots keep arriving while the request is out; no second request.
    expect(radio.topUp()).toBeNull();
    respond('s5', [...songs('s1', 's5'), ...Array.from({ length: 30 }, (_, index) => track(`n${index}`))]);
    await request;
    expect(log.at(-1)).toBe(`append ${Array.from({ length: 20 }, (_, index) => `n${index}`).join(' ')}`);
    expect(player().queue).toHaveLength(26);
    expect(new Set(player().entryIds).size).toBe(26);
  });

  it('does not ask again for the same last song within a minute after it added nothing', async () => {
    const { radio, client, setSimilar, play } = fixture();
    setSimilar(id => id === 'top1' ? songs('top1', 's1') : songs('top1', 's1'));
    await run(radio.start({ kind: 'artist', id: 'ar1', label: 'A' }));
    play(1);
    await radio.topUp(1000);
    expect(client.similarSongs).toHaveBeenCalledTimes(2);
    expect(radio.topUp(30_000)).toBeNull();
    await radio.topUp(61_000);
    expect(client.similarSongs).toHaveBeenCalledTimes(3);
  });

  it('never appends a late top-up to a newer station, a stopped station, or another session', async () => {
    for (const change of ['restart', 'stop', 'disconnect'] as const) {
      const { radio, log, respond, play, setSimilar, disconnect } = fixture();
      setSimilar(id => ['top1', 'top2'].includes(id) ? songs(id, `${id}-a`) : null);
      await run(radio.start({ kind: 'artist', id: 'ar1', label: 'Old' }));
      play(1);
      const late = radio.topUp()!;
      if (change === 'restart') await run(radio.start({ kind: 'artist', id: 'ar2', label: 'New' }));
      else if (change === 'stop') radio.end();
      else disconnect();
      respond('top1-a', songs('late1', 'late2'));
      await late;
      expect(log.filter(entry => entry.startsWith('append'))).toEqual([]);
      expect(radio.view).toEqual(change === 'restart' ? { label: 'New' } : change === 'stop' ? null : { label: 'Old' });
    }
  });

  it('refuses a start that finishes after other playback began, and keeps the queue when stopped', async () => {
    const { radio, log, respond, setSimilar } = fixture();
    const slow = run(radio.start({ kind: 'artist', id: 'ar1', label: 'Slow' }));
    await flushAsync();
    // Other playback (play tracks, open files, resume, clear) ends radio before replacing the queue.
    radio.end();
    respond('top1', songs('s1'));
    expect(await slow).toEqual(Either.left(new Error('Playback changed before the radio could start.')));
    expect(log).toEqual([]);
    // The latest of two overlapping starts wins.
    const first = run(radio.start({ kind: 'artist', id: 'ar1', label: 'First' }));
    await flushAsync();
    setSimilar(() => songs('top1', 's2'));
    await run(radio.start({ kind: 'artist', id: 'ar2', label: 'Second' }));
    respond('top1', songs('s1'));
    expect(Either.isLeft(await first)).toBe(true);
    expect(radio.view).toEqual({ label: 'Second' });
    radio.end();
    expect(log).toEqual(['replace top1 s2', 'radio Second', 'radio off']);
  });
});
