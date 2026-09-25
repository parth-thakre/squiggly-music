import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import type { HostMessage, HostRequest } from '../packages/player-mpv/protocol';
import { emptyPlayer, type PlayerSnapshot } from '../packages/core/contracts';
import { clearPlayerSession } from '../packages/player-mpv/session';

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
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
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
    send({ id: 8, action: { type: 'queue-jump', index: 1, entryId: snapshots.at(-1)!.entryIds[1] } });
    await expect.poll(() => snapshots.at(-1)?.playing).toBe(true);
    expect(replies.get(7)).toBeNull();
    expect(replies.get(8)).toBeNull();
    expect(snapshots.at(-1)?.currentIndex).toBe(1);
  });
});

async function wavFixture(seconds = 4) {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'squiggly-native-'));
  const file = join(fixtureDirectory, 'test.wav');
  const rate = 48000; const bytes = rate * seconds * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < bytes / 2; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 2000), 44 + i * 2);
  await writeFile(file, wav);
  return file;
}

describe.skipIf(!process.env.SQUIGGLY_LIBMPV_PATH)('queue editing in real libmpv', () => {
  it('keeps the snapshot queue and index matched to mpv through edits, then restores a paused position', async () => {
    const file = await wavFixture(8);
    const { snapshots, replies, send } = start(process.env.SQUIGGLY_LIBMPV_PATH!);
    await expect.poll(() => snapshots.at(-1)?.engine).toBe('ready');
    const item = (id: string) => ({ location: file, track: { id, title: id, artist: '', album: '', duration: 8, source: 'local' as const,
      sourceFormat: 'wav', sourceSampleRate: null, sourceBitDepth: null } });
    let id = 0;
    const run = async (action: HostRequest['action']) => {
      const request = ++id; send({ id: request, action });
      await expect.poll(() => replies.has(request)).toBe(true);
      return replies.get(request);
    };
    const order = () => snapshots.at(-1)!.queue.map(track => track.id);
    expect(await run({ type: 'queue', tracks: ['a', 'b', 'c', 'd', 'e'].map(item), startIndex: 2 })).toBeNull();
    await expect.poll(() => snapshots.at(-1)?.playing).toBe(true);
    expect(await run({ type: 'queue-move', from: 0, to: 3 })).toBeNull();
    expect(order()).toEqual(['b', 'c', 'd', 'a', 'e']);
    // The host re-reads playlist-pos after each edit; mpv kept the current entry.
    expect(snapshots.at(-1)!.currentIndex).toBe(1);
    expect(await run({ type: 'queue-move', from: 1, to: 4 })).toBeNull();
    expect(order()).toEqual(['b', 'd', 'a', 'e', 'c']);
    expect(snapshots.at(-1)!.currentIndex).toBe(4);
    expect(await run({ type: 'queue-move', from: 4, to: 0 })).toBeNull();
    expect(order()).toEqual(['c', 'b', 'd', 'a', 'e']);
    expect(snapshots.at(-1)!.currentIndex).toBe(0);
    expect(await run({ type: 'queue-add', tracks: [item('x'), item('y')], where: 'next' })).toBeNull();
    expect(order()).toEqual(['c', 'x', 'y', 'b', 'd', 'a', 'e']);
    expect(await run({ type: 'queue-remove', indexes: [0] })).toContain('current song');
    expect(await run({ type: 'queue-remove', indexes: [6, 1] })).toBeNull();
    expect(order()).toEqual(['c', 'y', 'b', 'd', 'a']);
    // mpv's own playlist-count check inside the host would have failed any mismatch above.
    expect(await run({ type: 'next' })).toBeNull();
    await expect.poll(() => snapshots.at(-1)?.currentIndex).toBe(1);
    expect(await run({ type: 'queue-clear' })).toBeNull();
    expect(order()).toEqual(['y']);
    expect(snapshots.at(-1)!.currentIndex).toBe(0);
    // Entry ids pick one copy of a repeated song; a stale id is refused.
    expect(await run({ type: 'queue-add', tracks: [item('y'), item('z')], where: 'end' })).toBeNull();
    const entries = snapshots.at(-1)!.entryIds;
    expect(new Set(entries).size).toBe(3);
    expect(await run({ type: 'queue-jump', index: 1, entryId: entries[0] })).toContain('queue changed');
    expect(await run({ type: 'queue-jump', index: 1, entryId: entries[1] })).toBeNull();
    await expect.poll(() => snapshots.at(-1)?.currentIndex).toBe(1);
    expect(snapshots.at(-1)!.entryIds).toEqual(entries);
    expect(await run({ type: 'queue', tracks: ['p', 'q'].map(item), startIndex: 1, startPosition: 5, paused: true })).toBeNull();
    await expect.poll(() => snapshots.at(-1)?.position ?? 0).toBeGreaterThan(4.9);
    expect(snapshots.at(-1)).toMatchObject({ playing: false, currentIndex: 1 });
    expect(snapshots.at(-1)!.position).toBeLessThan(5.2);
    expect(await run({ type: 'exclusive', on: true })).toBeNull();
    await expect.poll(() => snapshots.at(-1)?.audio.exclusiveRequested).toBe(true);
    expect(await run({ type: 'exclusive', on: false })).toBeNull();
    await expect.poll(() => snapshots.at(-1)?.audio.exclusiveRequested).toBe(false);
  });
});

async function mockHost(supportsStopKeepPlaylist = false, configure?: (native: { set: ReturnType<typeof vi.fn>; property: ReturnType<typeof vi.fn> }) => void) {
  vi.useFakeTimers();
  const { emptyAudio } = await import('../packages/core/contracts');
  const native = {
    clientApiVersion: supportsStopKeepPlaylist ? '1.109' : '1.107', supportsStopKeepPlaylist,
    devices: vi.fn(() => []), close: vi.fn(),
    command: vi.fn(), set: vi.fn(),
    property: vi.fn((_name: string): string | null => 'no'),
    number: vi.fn((name: string) => ({ 'playlist-pos': 2, 'time-pos': 12, duration: 90, volume: 100 })[name] ?? null),
    audio: vi.fn(() => ({ ...emptyAudio(), codec: 'pcm', decoderRate: 48000, outputRate: 48000 })),
    drainEvents: vi.fn(() => ({ error: null as string | null, shutdown: false })),
  };
  configure?.(native);
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
  // Acknowledges every message sent so far, including snapshots released by earlier acknowledgements.
  let delivered = 0;
  const deliver = () => { while (delivered < sends.length) sends[delivered++].callback(null); };
  return { native, sends, snapshots, exit, deliver, command: (request: HostRequest) => listeners.get('message')!(request) };
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

  it('starts a replacement queue at the requested entry and rejects an out-of-range start', async () => {
    const { sends, command, native } = await mockHost();
    sends[0].callback(null);
    const track = (id: string) => ({ location: `/${id}.wav`, track: { id, title: id, artist: '', album: '', duration: null, source: 'local' as const,
      sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null } });
    command({ id: 1, action: { type: 'queue', tracks: [track('a'), track('b'), track('a')], startIndex: 2 } });
    expect(native.command.mock.calls.filter(([name]) => name === 'loadfile')).toHaveLength(3);
    expect(native.set).toHaveBeenCalledWith('playlist-pos', '2');
    native.command.mockClear(); native.set.mockClear();
    command({ id: 2, action: { type: 'queue', tracks: [track('c')] } });
    expect(native.set).not.toHaveBeenCalledWith('playlist-pos', expect.anything());
    native.command.mockClear();
    command({ id: 3, action: { type: 'queue', tracks: [track('d')], startIndex: 1 } });
    expect(native.command).not.toHaveBeenCalled();
    const reply = sends.map(send => send.message).find(message => message.type === 'reply' && message.id === 3);
    expect(reply).toEqual({ type: 'reply', id: 3, error: expect.stringContaining('queue') });
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

  it('clears the private legacy playlist when replacing a server session', async () => {
    const { sends, command, native } = await mockHost();
    sends[0].callback(null);
    const track = { id: 'remote', title: 'Remote', artist: '', album: '', duration: null, source: 'navidrome' as const,
      sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null };
    command({ id: 1, action: { type: 'queue', tracks: [{ location: 'https://server/rest/stream.view?t=secret', track }] } });
    command({ id: 2, action: { type: 'stop' } });
    command({ id: 3, action: { type: 'clear-session' } });
    native.command.mockClear();
    command({ id: 4, action: { type: 'play' } });
    expect(native.command).not.toHaveBeenCalledWith('loadfile', expect.anything(), expect.anything());
    const reply = sends.map(send => send.message).find(message => message.type === 'reply' && message.id === 4);
    expect(reply).toEqual({ type: 'reply', id: 4, error: expect.stringContaining('queue') });
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

describe('player session cleanup', () => {
  it('drops authenticated playlist entries without resetting volume or output device', () => {
    const commands: string[][] = [];
    const player = emptyPlayer();
    player.volume = 37;
    player.audio.requestedDevice = 'alsa/external-dac';
    player.playing = true;
    player.position = 12;
    player.duration = 180;
    player.currentIndex = 0;
    player.queue = [{
      id: 'remote', title: 'Remote track', artist: 'Test', album: '', duration: 180,
      source: 'navidrome', sourceFormat: 'flac', sourceSampleRate: 96000, sourceBitDepth: 24,
    }];

    clearPlayerSession({ command: (...args) => commands.push(args) }, player);

    expect(commands).toEqual([['stop'], ['playlist-clear']]);
    expect(player).toMatchObject({
      playing: false, position: 0, duration: 0, currentIndex: -1, queue: [], volume: 37,
      audio: { requestedDevice: 'alsa/external-dac' },
    });
  });
});

// A model of mpv's playlist commands, as documented and implemented in mpv's command.c:
// playlist-move puts entry index1 in front of entry index2 (the end when index2 is the count),
// playlist-remove drops one entry, and loadfile append adds to the end without starting playback.
function mpvPlaylist(native: Awaited<ReturnType<typeof mockHost>>['native']) {
  const entries: { location: string }[] = [];
  let current: { location: string } | null = null;
  const at = (value: string) => { const index = Number(value); if (!Number.isInteger(index)) throw new Error('bad index'); return index; };
  native.command.mockImplementation((...args: string[]) => {
    const [name, a, b] = args;
    if (name === 'loadfile') {
      const entry = { location: a };
      if (b === 'replace') { entries.splice(0, entries.length, entry); current = entry; } else entries.push(entry);
    } else if (name === 'playlist-move') {
      const entry = entries[at(a)]; if (!entry) throw new Error('Audio engine rejected playlist-move.');
      const target = entries[at(b)] ?? null;
      if (entry === target) return;
      entries.splice(entries.indexOf(entry), 1);
      entries.splice(target ? entries.indexOf(target) : entries.length, 0, entry);
    } else if (name === 'playlist-remove') {
      const index = at(a); if (!entries[index]) throw new Error('Audio engine rejected playlist-remove.');
      if (entries[index] === current) current = null;
      entries.splice(index, 1);
    } else if (name === 'playlist-clear') entries.splice(0, entries.length, ...(current ? [current] : []));
    // Without keep-playlist (client API before 1.108), stop also empties the playlist.
    else if (name === 'stop') { current = null; if (a !== 'keep-playlist') entries.splice(0); }
  });
  native.set.mockImplementation((name: string, value: string) => { if (name === 'playlist-pos') current = entries[at(value)] ?? null; });
  native.number.mockImplementation((name: string) => name === 'playlist-pos' ? (current ? entries.indexOf(current) : -1) : name === 'playlist-count' ? entries.length : null);
  return { locations: () => entries.map(entry => entry.location), current: () => current ? entries.indexOf(current) : -1, select: (index: number) => { current = entries[index]; } };
}
const playable = (id: string) => ({ location: `/${id}.flac`, track: { id, title: id, artist: '', album: '', duration: 200, source: 'navidrome' as const,
  sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null } });

async function editableHost(ids = ['a', 'b', 'c', 'd'], current = 1, supportsStopKeepPlaylist = true) {
  const host = await mockHost(supportsStopKeepPlaylist);
  const mpv = mpvPlaylist(host.native);
  let id = 0;
  const run = (action: HostRequest['action']) => { const requestId = ++id; host.command({ id: requestId, action }); host.deliver(); return requestId; };
  const reply = (requestId: number) => host.sends.map(send => send.message).find(message => message.type === 'reply' && message.id === requestId);
  const snapshot = () => host.snapshots().at(-1)!.player;
  // The snapshot's queue order and index must always describe mpv's own playlist.
  const consistent = () => {
    expect(snapshot().queue.map(track => `/${track.id}.flac`)).toEqual(mpv.locations());
    expect(snapshot().currentIndex).toBe(mpv.current());
    // One distinct entry id per queue entry.
    expect(snapshot().entryIds).toHaveLength(snapshot().queue.length);
    expect(new Set(snapshot().entryIds).size).toBe(snapshot().queue.length);
  };
  host.deliver();
  run({ type: 'queue', tracks: ids.map(playable), startIndex: current });
  return { ...host, mpv, run, reply, snapshot, consistent, order: () => snapshot().queue.map(track => track.id) };
}
const ok = { type: 'reply', error: null };

describe('queue editing', () => {
  it('adds after the current song or at the end, without moving playback', async () => {
    const { run, reply, order, snapshot, consistent, native } = await editableHost();
    expect(reply(run({ type: 'queue-add', tracks: [playable('x'), playable('y')], where: 'next' }))).toMatchObject(ok);
    expect(order()).toEqual(['a', 'b', 'x', 'y', 'c', 'd']);
    expect(snapshot().currentIndex).toBe(1);
    consistent();
    run({ type: 'queue-add', tracks: [playable('z')], where: 'end' });
    expect(order()).toEqual(['a', 'b', 'x', 'y', 'c', 'd', 'z']);
    consistent();
    // Appending at the end needs no move, and adding never pauses or restarts playback.
    expect(native.command.mock.calls.at(-1)).toEqual(['loadfile', '/z.flac', 'append']);
    expect(native.set).not.toHaveBeenCalledWith('pause', 'yes');
    expect(native.set.mock.calls.filter(([name]) => name === 'playlist-pos')).toEqual([['playlist-pos', '1']]);
  });

  it('adds "next" to the front when nothing is current', async () => {
    const { run, order, consistent } = await editableHost(['a', 'b'], 0);
    run({ type: 'stop' });
    run({ type: 'queue-add', tracks: [playable('x')], where: 'next' });
    expect(order()).toEqual(['x', 'a', 'b']);
    consistent();
  });

  it('translates moves to mpv playlist-move semantics in both directions', async () => {
    const { run, order, consistent, native, snapshot } = await editableHost(['a', 'b', 'c', 'd', 'e'], 2);
    native.command.mockClear();
    run({ type: 'queue-move', from: 0, to: 3 });
    // Moving down names the entry after the destination.
    expect(native.command).toHaveBeenCalledWith('playlist-move', '0', '4');
    expect(order()).toEqual(['b', 'c', 'd', 'a', 'e']);
    consistent();
    run({ type: 'queue-move', from: 3, to: 4 });
    // After the last entry, that is the playlist count.
    expect(native.command).toHaveBeenLastCalledWith('playlist-move', '3', '5');
    expect(order()).toEqual(['b', 'c', 'd', 'e', 'a']);
    run({ type: 'queue-move', from: 4, to: 0 });
    expect(native.command).toHaveBeenLastCalledWith('playlist-move', '4', '0');
    expect(order()).toEqual(['a', 'b', 'c', 'd', 'e']);
    // Moving the current song keeps it current at its new index.
    run({ type: 'queue-move', from: 2, to: 0 });
    expect(order()).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(snapshot().currentIndex).toBe(0);
    consistent();
    native.command.mockClear();
    run({ type: 'queue-move', from: 1, to: 1 });
    expect(native.command).not.toHaveBeenCalled();
  });

  it('keeps mpv and the snapshot identical across many random moves', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `t${index}`);
    const { run, order, consistent, snapshot } = await editableHost(ids, 5);
    const expected = [...ids];
    // Entry ids travel with their songs.
    const entryOf = new Map(ids.map((id, index) => [id, snapshot().entryIds[index]]));
    let seed = 7;
    const random = (limit: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
    for (let i = 0; i < 200; i++) {
      const from = random(ids.length); const to = random(ids.length);
      expected.splice(to, 0, ...expected.splice(from, 1));
      run({ type: 'queue-move', from, to });
      expect(order()).toEqual(expected);
      expect(snapshot().entryIds).toEqual(expected.map(id => entryOf.get(id)));
      consistent();
    }
  });

  it('rejects stale positions', async () => {
    const { run, reply, order } = await editableHost(['a', 'b'], 0);
    expect(reply(run({ type: 'queue-move', from: 0, to: 2 }))).toMatchObject({ error: expect.stringContaining('no longer in the queue') });
    expect(reply(run({ type: 'queue-remove', indexes: [5] }))).toMatchObject({ error: expect.stringContaining('no longer in the queue') });
    expect(order()).toEqual(['a', 'b']);
  });

  it('removes other songs but refuses the current one', async () => {
    const { run, reply, order, consistent, native } = await editableHost(['a', 'b', 'c', 'd', 'e'], 2);
    native.command.mockClear();
    expect(reply(run({ type: 'queue-remove', indexes: [2, 4] }))).toMatchObject({ error: expect.stringContaining('current song') });
    expect(native.command).not.toHaveBeenCalled();
    expect(order()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(reply(run({ type: 'queue-remove', indexes: [0, 4, 0, 3] }))).toMatchObject(ok);
    // Highest index first, duplicates once.
    expect(native.command.mock.calls).toEqual([['playlist-remove', '4'], ['playlist-remove', '3'], ['playlist-remove', '0']]);
    expect(order()).toEqual(['b', 'c']);
    consistent();
  });

  it('clears everything except the current song, or everything when stopped', async () => {
    const { run, order, consistent } = await editableHost(['a', 'b', 'c', 'd'], 2);
    run({ type: 'queue-clear' });
    expect(order()).toEqual(['c']);
    consistent();
    run({ type: 'queue-add', tracks: [playable('x')], where: 'end' });
    run({ type: 'stop' });
    run({ type: 'queue-clear' });
    expect(order()).toEqual([]);
    consistent();
  });

  it('bounds the queue at 1000 songs before touching mpv', async () => {
    const { run, reply, native, order } = await editableHost(Array.from({ length: 999 }, (_, index) => `t${index}`), 0);
    native.command.mockClear();
    expect(reply(run({ type: 'queue-add', tracks: [playable('x'), playable('y')], where: 'end' }))).toMatchObject({ error: expect.stringContaining('1,000') });
    expect(native.command).not.toHaveBeenCalled();
    expect(order()).toHaveLength(999);
    expect(reply(run({ type: 'queue-add', tracks: [playable('x')], where: 'end' }))).toMatchObject(ok);
    const oversized = Array.from({ length: 1001 }, (_, index) => playable(`n${index}`));
    expect(reply(run({ type: 'queue', tracks: oversized }))).toMatchObject({ error: expect.stringContaining('1,000') });
  });

  it('keeps both lists aligned when mpv rejects a move part-way', async () => {
    const { run, reply, native, order, consistent, mpv } = await editableHost(['a', 'b', 'c'], 0);
    const original = native.command.getMockImplementation()!;
    native.command.mockImplementation((...args: string[]) => {
      if (args[0] === 'playlist-move') throw new Error('Audio engine rejected playlist-move.');
      return original(...args);
    });
    expect(reply(run({ type: 'queue-add', tracks: [playable('x'), playable('y')], where: 'next' }))).toMatchObject({ error: expect.stringContaining('playlist-move') });
    // The appended entry stays at the end in both lists; the second was never added.
    expect(mpv.locations()).toEqual(['/a.flac', '/b.flac', '/c.flac', '/x.flac']);
    expect(order()).toEqual(['a', 'b', 'c', 'x']);
    consistent();
  });

  it('edits only the private copy after a legacy stop, then plays the edited queue', async () => {
    const { run, order, native, snapshot } = await editableHost(['a', 'b', 'c'], 1, false);
    run({ type: 'stop' });
    native.command.mockClear();
    run({ type: 'queue-move', from: 2, to: 0 });
    run({ type: 'queue-remove', indexes: [1] });
    run({ type: 'queue-add', tracks: [playable('x')], where: 'end' });
    expect(native.command).not.toHaveBeenCalled();
    expect(order()).toEqual(['c', 'b', 'x']);
    expect(snapshot().currentIndex).toBe(-1);
    run({ type: 'play' });
    expect(native.command.mock.calls.filter(([name]) => name === 'loadfile').map(([, location]) => location)).toEqual(['/c.flac', '/b.flac', '/x.flac']);
  });
});

describe('queue entry identity', () => {
  it('gives every entry its own id, kept through moves, adds, removes, and clear', async () => {
    const { run, snapshot, order, consistent } = await editableHost(['a', 'b', 'a', 'c'], 0);
    const [a1, b, a2, c] = snapshot().entryIds;
    expect(new Set([a1, b, a2, c]).size).toBe(4);
    run({ type: 'queue-move', from: 0, to: 3 });
    expect(order()).toEqual(['b', 'a', 'c', 'a']);
    expect(snapshot().entryIds).toEqual([b, a2, c, a1]);
    run({ type: 'queue-add', tracks: [playable('a'), playable('d')], where: 'next' });
    const added = snapshot().entryIds.slice(4, 6);
    expect(order()).toEqual(['b', 'a', 'c', 'a', 'a', 'd']);
    expect(added.some(id => [a1, b, a2, c].includes(id))).toBe(false);
    consistent();
    run({ type: 'queue-remove', indexes: [1] });
    expect(snapshot().entryIds).toEqual([b, c, a1, ...added]);
    run({ type: 'queue-clear' });
    expect(snapshot().entryIds).toEqual([a1]);
    consistent();
    // A replacement queue never reuses an id, even for the same songs.
    run({ type: 'queue', tracks: ['a', 'b'].map(playable) });
    expect(snapshot().entryIds.some(id => [a1, b, a2, c, ...added].includes(id))).toBe(false);
    run({ type: 'clear-session' });
    expect(snapshot()).toMatchObject({ queue: [], entryIds: [] });
  });

  it('jumps to the entry clicked, not the first copy of its song', async () => {
    const { run, reply, snapshot, native, mpv, deliver } = await editableHost(['a', 'b', 'a'], 0);
    const second = snapshot().entryIds[2];
    native.set.mockClear();
    expect(reply(run({ type: 'queue-jump', index: 2, entryId: second }))).toMatchObject(ok);
    expect(native.set.mock.calls).toEqual([['playlist-pos', '2'], ['pause', 'no']]);
    expect(mpv.current()).toBe(2);
    vi.advanceTimersByTime(250); deliver();
    expect(snapshot()).toMatchObject({ currentIndex: 2, entryIds: expect.arrayContaining([second]) });
  });

  it('refuses a jump whose entry moved or left, without touching playback', async () => {
    const { run, reply, snapshot, native } = await editableHost(['a', 'b', 'c'], 0);
    const [, b] = snapshot().entryIds;
    run({ type: 'queue-move', from: 1, to: 2 });
    native.set.mockClear();
    for (const [index, entryId] of [[1, b], [5, b], [2, 'another-host.1']] as const) {
      expect(reply(run({ type: 'queue-jump', index, entryId }))).toMatchObject({ error: expect.stringContaining('queue changed') });
    }
    expect(native.set).not.toHaveBeenCalled();
    expect(reply(run({ type: 'queue-jump', index: 2, entryId: b }))).toMatchObject(ok);
  });

  it('reloads the private playlist for a jump after a legacy stop', async () => {
    const { run, reply, snapshot, native } = await editableHost(['a', 'b'], 0, false);
    const [, b] = snapshot().entryIds;
    run({ type: 'stop' });
    native.command.mockClear();
    expect(reply(run({ type: 'queue-jump', index: 1, entryId: b }))).toMatchObject(ok);
    expect(native.command.mock.calls.filter(([name]) => name === 'loadfile').map(([, location]) => location)).toEqual(['/a.flac', '/b.flac']);
    expect(native.set).toHaveBeenLastCalledWith('pause', 'no');
  });

  it('refuses a seek whose entry is no longer current', async () => {
    const { run, reply, snapshot, native } = await editableHost(['a', 'a'], 0);
    const [first, second] = snapshot().entryIds;
    // Same index and song id, but the gesture began on the other copy.
    run({ type: 'queue-move', from: 1, to: 0 });
    expect(snapshot().entryIds).toEqual([second, first]);
    native.command.mockClear();
    expect(reply(run({ type: 'seek', seconds: 10, queueIndex: 1, trackId: 'a', entryId: second }))).toMatchObject({ error: expect.stringContaining('track changed') });
    expect(native.command).not.toHaveBeenCalled();
    expect(reply(run({ type: 'seek', seconds: 10, queueIndex: 1, trackId: 'a', entryId: first }))).toMatchObject(ok);
    expect(native.command).toHaveBeenCalledWith('seek', '10', 'absolute+exact');
  });
});

describe('restoring a saved queue', () => {
  it('loads paused at the saved song and seeks once it is seekable', async () => {
    const { command, native, deliver } = await mockHost(true);
    deliver();
    const mpv = mpvPlaylist(native);
    let seekable = false;
    native.property.mockImplementation((name: string) => name === 'seekable' ? (seekable ? 'yes' : 'no') : 'no');
    command({ id: 1, action: { type: 'queue', tracks: ['a', 'b', 'c'].map(playable), startIndex: 1, startPosition: 83.5, paused: true } });
    expect(native.set.mock.calls.filter(([name]) => name === 'pause')).toEqual([['pause', 'yes']]);
    // Paused before the first load, so no audio plays from the start of the song.
    const pauseOrder = native.set.mock.invocationCallOrder[native.set.mock.calls.findIndex(([name]) => name === 'pause')];
    expect(pauseOrder).toBeLessThan(native.command.mock.invocationCallOrder[native.command.mock.calls.findIndex(([name]) => name === 'loadfile')]);
    expect(mpv.current()).toBe(1);
    vi.advanceTimersByTime(500);
    expect(native.command).not.toHaveBeenCalledWith('seek', expect.anything(), expect.anything());
    // Pressing play before the stream opens keeps the pending position.
    command({ id: 2, action: { type: 'play' } });
    seekable = true;
    vi.advanceTimersByTime(250);
    expect(native.command).toHaveBeenCalledWith('seek', '83.5', 'absolute+exact');
    native.command.mockClear();
    vi.advanceTimersByTime(1000);
    expect(native.command).not.toHaveBeenCalledWith('seek', expect.anything(), expect.anything());
  });

  it('gives up with a plain error when the saved song never becomes seekable', async () => {
    const { snapshots, command, native, deliver } = await mockHost(true);
    mpvPlaylist(native);
    command({ id: 1, action: { type: 'queue', tracks: [playable('a')], startPosition: 30, paused: true } });
    for (let i = 0; i < 45; i++) { vi.advanceTimersByTime(250); deliver(); }
    expect(snapshots().at(-1)!.player.error).toContain('saved position');
    expect(native.command).not.toHaveBeenCalledWith('seek', expect.anything(), expect.anything());
  });

  it('cancels the pending position when the user changes song', async () => {
    const { command, native } = await mockHost(true);
    const mpv = mpvPlaylist(native);
    native.property.mockImplementation((name: string) => name === 'seekable' ? 'yes' : 'no');
    command({ id: 1, action: { type: 'queue', tracks: ['a', 'b'].map(playable), startPosition: 30, paused: true } });
    command({ id: 2, action: { type: 'next' } });
    mpv.select(1);
    vi.advanceTimersByTime(250);
    expect(native.command).not.toHaveBeenCalledWith('seek', expect.anything(), expect.anything());
  });
});

describe('exclusive output', () => {
  const idle = (native: { property: ReturnType<typeof vi.fn> }) => native.property.mockImplementation((name: string) => name === 'idle-active' ? 'yes' : 'no');

  it('requests exclusive access at startup without claiming it was granted', async () => {
    vi.stubEnv('SQUIGGLY_AUDIO_EXCLUSIVE', '1');
    const { native, snapshots } = await mockHost(true, idle);
    expect(native.set).toHaveBeenCalledWith('audio-exclusive', 'yes');
    // Nothing is loaded yet, so there is no output to reopen.
    expect(native.command).not.toHaveBeenCalledWith('ao-reload');
    expect(snapshots()[0].player.error).toBeNull();
  });

  it('does not touch the option when exclusive output is off', async () => {
    const { native } = await mockHost(true, idle);
    expect(native.set).not.toHaveBeenCalledWith('audio-exclusive', expect.anything());
  });

  it('reports a startup rejection as shared output', async () => {
    vi.stubEnv('SQUIGGLY_AUDIO_EXCLUSIVE', '1');
    const { snapshots, native } = await mockHost(true, native => {
      idle(native);
      native.set.mockImplementation((name: string, value: string) => { if (name === 'audio-exclusive' && value === 'yes') throw new Error('rejected'); });
    });
    expect(snapshots()[0].player.error).toContain('shared with the system mixer');
    expect(native.set).toHaveBeenLastCalledWith('audio-exclusive', 'no');
  });

  it('reopens a loaded output and reverts with a plain error when that fails', async () => {
    const { sends, command, native, deliver } = await mockHost(true);
    deliver();
    command({ id: 1, action: { type: 'exclusive', on: true } });
    expect(native.set).toHaveBeenCalledWith('audio-exclusive', 'yes');
    expect(native.command).toHaveBeenCalledWith('ao-reload');
    native.set.mockClear(); native.command.mockClear();
    native.command.mockImplementation((name: string) => { if (name === 'ao-reload') throw new Error('Audio engine rejected ao-reload.'); });
    command({ id: 2, action: { type: 'exclusive', on: false } });
    const reply = sends.map(send => send.message).find(message => message.type === 'reply' && message.id === 2);
    expect(reply).toEqual({ type: 'reply', id: 2, error: expect.stringContaining('exclusive mode') });
    // Reverted to the last accepted request.
    expect(native.set.mock.calls).toEqual([['audio-exclusive', 'no'], ['audio-exclusive', 'yes']]);
  });
});
