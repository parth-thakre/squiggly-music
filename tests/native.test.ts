import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import type { HostMessage, HostRequest } from '../packages/player-mpv/protocol';
import type { PlayerSnapshot } from '../packages/core/contracts';

let worker: ChildProcess | undefined;
let fixtureDirectory: string | undefined;
afterEach(async () => {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const child = worker;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); });
  }
  worker = undefined;
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true });
  fixtureDirectory = undefined;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  vi.doUnmock('../packages/player-mpv/native'); vi.doUnmock('koffi'); vi.resetModules();
});

function start(libraryPath: string) {
  const snapshots: PlayerSnapshot[] = [];
  const replies = new Map<number, string | null>();
  worker = fork(resolve('out/main/player.js'), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, SQUIGGLY_LIBMPV_PATH: libraryPath, SQUIGGLY_TEST_NULL_AUDIO: '1' },
  });
  worker.on('message', (message: HostMessage) => {
    if (message.type === 'snapshot') snapshots.push(message.player);
    else replies.set(message.id, message.error);
  });
  worker.stderr?.on('data', data => process.stderr.write(data));
  return { snapshots, replies, send: (request: HostRequest) => worker!.send(request) };
}

describe('isolated audio host', () => {
  it('reports unavailable libraries and rejects playback without pretending to play', async () => {
    const { snapshots, send, replies } = start('/nonexistent/squiggly/libmpv.so');
    await expect.poll(() => snapshots.at(-1)?.engine).toBe('unavailable');
    send({ id: 1, action: { type: 'play' } });
    await expect.poll(() => replies.has(1)).toBe(true);
    expect(replies.get(1)).toContain('libmpv');
    expect(snapshots.at(-1)?.playing).toBe(false);
  });

  it.skipIf(!process.env.SQUIGGLY_LIBMPV_PATH)('decodes real PCM through libmpv, reports format, and handles transport commands', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'squiggly-native-'));
    const file = join(fixtureDirectory, 'test.wav');
    const rate = 48000; const bytes = rate * 4 * 2;
    const wav = Buffer.alloc(44 + bytes);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
    for (let i = 0; i < bytes / 2; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 2000), 44 + i * 2);
    await writeFile(file, wav);
    const { snapshots, replies, send } = start(process.env.SQUIGGLY_LIBMPV_PATH!);
    await expect.poll(() => snapshots.at(-1)?.engine).toBe('ready');
    send({ id: 1, action: { type: 'queue', tracks: ['test', 'second'].map(id => ({ location: file, track: {
      id, title: 'Generated PCM', artist: 'Test', album: '', duration: 4, source: 'local',
      sourceFormat: 'wav', sourceSampleRate: null, sourceBitDepth: null,
    } })) } });
    await expect.poll(() => snapshots.at(-1)?.playing).toBe(true);
    expect(replies.get(1)).toBeNull();
    expect(snapshots.at(-1)?.audio.decoderRate).toBe(48000);
    expect(snapshots.at(-1)?.audio.outputBackend).toBe('null');
    expect(snapshots.at(-1)?.audio.replayGain).toBe('no');
    expect(JSON.stringify(snapshots)).not.toContain(fixtureDirectory);
    send({ id: 2, action: { type: 'pause' } });
    await expect.poll(() => snapshots.at(-1)?.playing).toBe(false);
    send({ id: 3, action: { type: 'seek', seconds: 1, queueIndex: 0, trackId: 'test' } });
    await expect.poll(() => replies.has(3)).toBe(true);
    expect(replies.get(3)).toBeNull();
    await expect.poll(() => snapshots.at(-1)?.position).toBeCloseTo(1, 1);
    send({ id: 4, action: { type: 'volume', percent: 50 } });
    await expect.poll(() => snapshots.at(-1)?.volume).toBe(50);
    send({ id: 5, action: { type: 'stop' } });
    await expect.poll(() => snapshots.at(-1)?.currentIndex).toBe(-1);
    expect(replies.get(5)).toBeNull();
    expect(snapshots.at(-1)?.queue).toHaveLength(2);
    send({ id: 6, action: { type: 'play' } });
    await expect.poll(() => snapshots.at(-1)?.playing).toBe(true);
    expect(replies.get(6)).toBeNull();
    expect(snapshots.at(-1)?.currentIndex).toBe(0);
    send({ id: 7, action: { type: 'stop' } });
    await expect.poll(() => snapshots.at(-1)?.currentIndex).toBe(-1);
    send({ id: 8, action: { type: 'select', id: 'second' } });
    await expect.poll(() => snapshots.at(-1)?.playing).toBe(true);
    expect(replies.get(7)).toBeNull();
    expect(replies.get(8)).toBeNull();
    expect(snapshots.at(-1)?.currentIndex).toBe(1);
  });
});

async function mockHost(supportsStopKeepPlaylist = false) {
  vi.useFakeTimers();
  const { emptyAudio } = await import('../packages/core/contracts');
  const native = {
    clientApiVersion: supportsStopKeepPlaylist ? '1.109' : '1.107', supportsStopKeepPlaylist,
    devices: vi.fn(() => []), close: vi.fn(),
    command: vi.fn(), set: vi.fn(),
    property: vi.fn(() => 'no'),
    number: vi.fn((name: string) => ({ 'playlist-pos': 2, 'time-pos': 12, duration: 90, volume: 100 })[name] ?? null),
    audio: vi.fn(() => ({ ...emptyAudio(), codec: 'pcm', decoderRate: 48000, outputRate: 48000 })),
    drainEvents: vi.fn(() => ({ error: null as string | null, shutdown: false })),
  };
  vi.doMock('../packages/player-mpv/native', () => ({ NativePlayer: vi.fn(function () { return native; }) }));
  const sends: { message: HostMessage; callback: (error: Error | null) => void }[] = [];
  const listeners = new Map<string, (data: HostRequest) => void>();
  const exit = vi.fn();
  vi.stubGlobal('process', { ...process, connected: true, exit,
    send: vi.fn((message: HostMessage, callback: (error: Error | null) => void) => {
      sends.push({ message, callback }); return false;
    }),
    on: vi.fn((event: string, callback: (data: HostRequest) => void) => listeners.set(event, callback)),
  });
  await import('../packages/player-mpv/host');
  const snapshots = () => sends.map(send => send.message).filter(message => message.type === 'snapshot');
  return { native, sends, snapshots, exit, command: (request: HostRequest) => listeners.get('message')!(request) };
}

describe('host snapshot lifecycle', () => {
  it('coalesces blocked snapshots to the latest and sends replies separately', async () => {
    const { sends, snapshots, command, native } = await mockHost();
    vi.advanceTimersByTime(250);
    native.number.mockImplementation(name => name === 'time-pos' ? 25 : null);
    vi.advanceTimersByTime(2500);
    expect(snapshots()).toHaveLength(1);
    command({ id: 1, action: { type: 'pause' } });
    expect(sends[1].message).toEqual({ type: 'reply', id: 1, error: null });
    sends[0].callback(null);
    expect(snapshots()).toHaveLength(2);
    expect(snapshots()[1].player.position).toBe(25);
    sends[2].callback(null);
    expect(snapshots()).toHaveLength(2);
    expect(snapshots()[0].clientApiVersion).toBe('1.107');
  });

  it('releases the native handle and exits on an IPC callback error', async () => {
    const { sends, native, exit } = await mockHost();
    sends[0].callback(new Error('IPC channel closed'));
    expect(native.close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    const polls = native.drainEvents.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(native.drainEvents).toHaveBeenCalledTimes(polls);
  });

  it('clears old track measurements before publishing a replacement queue', async () => {
    const { sends, snapshots, command } = await mockHost();
    sends[0].callback(null);
    vi.advanceTimersByTime(250);
    expect(snapshots()[1].player.audio.decoderRate).toBe(48000);
    sends[1].callback(null);
    command({ id: 1, action: { type: 'queue', tracks: [{ location: '/new.wav', track: {
      id: 'new', title: 'New', artist: '', album: '', duration: null, source: 'local',
      sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null,
    } }] } });
    const snapshot = snapshots().at(-1)!.player;
    expect(snapshot.queue[0].id).toBe('new');
    expect(snapshot).toMatchObject({ currentIndex: -1, playing: false, position: 0, duration: 0 });
    expect(snapshot.audio).toMatchObject({ codec: null, decoderRate: null, outputRate: null, bufferSeconds: null });
  });

  it('uses legacy stop without arguments and reloads its private playlist on play', async () => {
    const { sends, command, native } = await mockHost();
    sends[0].callback(null);
    const track = { id: 'old', title: 'Old', artist: '', album: '', duration: null, source: 'local' as const,
      sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null };
    command({ id: 1, action: { type: 'queue', tracks: [{ location: '/old.wav', track }] } });
    command({ id: 2, action: { type: 'stop' } });
    expect(native.command).toHaveBeenCalledWith('stop');
    expect(native.command).not.toHaveBeenCalledWith('stop', 'keep-playlist');
    native.command.mockClear();
    command({ id: 3, action: { type: 'play' } });
    expect(native.command).toHaveBeenCalledWith('loadfile', '/old.wav', 'replace');
  });

  it('uses playlist-preserving stop when the client API supports it', async () => {
    const { command, native } = await mockHost(true);
    command({ id: 1, action: { type: 'stop' } });
    expect(native.command).toHaveBeenCalledWith('stop', 'keep-playlist');
  });

  it('rejects a seek after native playback advances to another track', async () => {
    const { sends, command, native } = await mockHost();
    sends[0].callback(null);
    const tracks = ['first', 'second'].map(id => ({ location: `/${id}.wav`, track: {
      id, title: id, artist: '', album: '', duration: null, source: 'local' as const,
      sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null,
    } }));
    command({ id: 1, action: { type: 'queue', tracks } });
    native.number.mockImplementation(name => name === 'playlist-pos' ? 1 : null);
    command({ id: 2, action: { type: 'seek', seconds: 10, queueIndex: 0, trackId: 'first' } });
    const reply = sends.map(send => send.message).find(message => message.type === 'reply' && message.id === 2);
    expect(reply).toEqual({ type: 'reply', id: 2, error: expect.stringContaining('track changed') });
    expect(native.command).not.toHaveBeenCalledWith('seek', '10', 'absolute+exact');
  });

  it('stops polling on core shutdown, publishes failure, and exits nonzero', async () => {
    const { sends, snapshots, native, exit } = await mockHost();
    sends[0].callback(null);
    native.drainEvents.mockReturnValue({ error: null, shutdown: true });
    vi.advanceTimersByTime(250);
    expect(native.close).not.toHaveBeenCalled();
    expect(snapshots().at(-1)!.player).toMatchObject({ engine: 'crashed', playing: false });
    expect(snapshots().at(-1)!.player.error).toContain('shut down');
    expect(native.audio).not.toHaveBeenCalled();
    sends[1].callback(null);
    expect(native.close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    vi.advanceTimersByTime(500);
    expect(native.drainEvents).toHaveBeenCalledOnce();
  });

  it('still exits when a shutdown snapshot cannot flush', async () => {
    const { native, exit } = await mockHost();
    native.drainEvents.mockReturnValue({ error: null, shutdown: true });
    vi.advanceTimersByTime(1250);
    expect(native.close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('native client API compatibility', () => {
  it('decodes only the old end-file prefix and reports shutdown separately', async () => {
    let apiVersion = (1 << 16) | 107;
    const events = [
      { event_id: 7, data: { reason: 4, error: -13 } },
      { event_id: 1, data: null },
    ];
    const struct = vi.fn((_name: string, fields: Record<string, string>) => fields);
    vi.doMock('koffi', () => ({ default: {
      struct, decode: vi.fn(value => value),
      load: () => ({ func: (signature: string) => {
        if (signature.includes('mpv_client_api_version')) return () => apiVersion;
        if (signature.includes('mpv_create')) return () => ({});
        if (signature.includes('mpv_wait_event')) return () => events.shift();
        return () => 0;
      } }),
    } }));
    const { NativePlayer } = await import('../packages/player-mpv/native');
    const native = new NativePlayer();
    expect(native.clientApiVersion).toBe('1.107');
    expect(native.supportsStopKeepPlaylist).toBe(false);
    expect(struct).toHaveBeenCalledWith('squiggly_mpv_end_file', { reason: 'int', error: 'int' });
    expect(native.drainEvents()).toEqual({ error: expect.stringContaining('code -13'), shutdown: true });
    expect(native.drainEvents()).toEqual({ error: null, shutdown: false });
    native.close();
    apiVersion = (1 << 16) | 109;
    const newer = new NativePlayer();
    expect(newer.clientApiVersion).toBe('1.109');
    expect(newer.supportsStopKeepPlaylist).toBe(true);
    newer.close();
  });
});
