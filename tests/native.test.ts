import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import type { HostMessage, HostRequest } from '../packages/player-mpv/protocol';
import { emptyPlayer, type AudioDevice, type PlayerSnapshot } from '../packages/core/contracts';
import { clearPlayerSession } from '../packages/player-mpv/session';
import { libmpvMissing } from '../packages/player-mpv/libraries';

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

function start(libraryPath: string, env: Record<string, string> = {}) {
  const snapshots: PlayerSnapshot[] = [];
  const replies = new Map<number, string | null>();
  worker = fork(resolve('out/main/player.js'), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, SQUIGGLY_LIBMPV_PATH: libraryPath, SQUIGGLY_TEST_NULL_AUDIO: '1', ...env },
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

  // The AppImage message is Linux's; elsewhere the host reports the generic one, which the next case covers.
  it.skipIf(process.platform !== 'linux')('tells AppImage users which package to install when libmpv is missing', async () => {
    const { snapshots } = start('/nonexistent/squiggly/libmpv.so', { APPIMAGE: '/tmp/Squiggly-Music.AppImage' });
    await expect.poll(() => snapshots.at(-1)?.engine).toBe('unavailable');
    expect(snapshots.at(-1)?.error).toContain('This AppImage doesn\'t include it');
    expect(snapshots.at(-1)?.error).toContain('libmpv2');
  });

  it('names the packages only for an AppImage on Linux', () => {
    const appImage = libmpvMissing('linux', undefined, { APPIMAGE: '/home/me/Squiggly-Music-0.2.0-x86_64.AppImage' });
    expect(appImage).toContain('This AppImage doesn\'t include it');
    expect(appImage).toContain('libmpv2 on Debian and Ubuntu, mpv-libs on Fedora');
    for (const message of [libmpvMissing('linux', undefined, {}), libmpvMissing('win32', undefined, { APPIMAGE: 'x' })]) {
      expect(message).toBe('libmpv could not be loaded. Install the libmpv runtime or set SQUIGGLY_LIBMPV_PATH, then restart the audio engine.');
    }
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
    // The audio host never asks the sound server; the main process fills the sink in.
    expect(snapshots.at(-1)?.audio.sink).toBeNull();
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

describe.skipIf(!process.env.SQUIGGLY_LIBMPV_PATH)('kept songs in real libmpv', () => {
  it('says a kept song plays from the device only while mpv has its file open, and never shows the path', async () => {
    const file = await wavFixture(8);
    const { snapshots, replies, send } = start(process.env.SQUIGGLY_LIBMPV_PATH!);
    await expect.poll(() => snapshots.at(-1)?.engine).toBe('ready');
    const track = (id: string) => ({ id, title: id, artist: '', album: '', duration: 8, source: 'navidrome' as const, sourceFormat: 'wav', sourceSampleRate: null, sourceBitDepth: null });
    send({ id: 1, action: { type: 'queue', tracks: [{ track: track('kept'), location: file, kept: true }, { track: track('stream'), location: file }] } });
    await expect.poll(() => replies.has(1)).toBe(true);
    await expect.poll(() => snapshots.at(-1)?.fromDevice).toBe(true);
    send({ id: 2, action: { type: 'next' } });
    await expect.poll(() => snapshots.at(-1)?.currentIndex).toBe(1);
    await expect.poll(() => snapshots.at(-1)?.fromDevice).toBe(false);
    expect(JSON.stringify(snapshots)).not.toContain(fixtureDirectory!);
  });
  it('doesn\'t follow a playlist in a kept file to another file on the device', async () => {
    const file = await wavFixture(8);
    const playlist = join(fixtureDirectory!, 's-kept.m3u');
    await writeFile(playlist, `#EXTM3U\n${file}\n`);
    const { snapshots, replies, send } = start(process.env.SQUIGGLY_LIBMPV_PATH!);
    await expect.poll(() => snapshots.at(-1)?.engine).toBe('ready');
    const track = { id: 'kept', title: 'kept', artist: '', album: '', duration: 8, source: 'navidrome' as const, sourceFormat: 'm3u', sourceSampleRate: null, sourceBitDepth: null };
    send({ id: 1, action: { type: 'queue', tracks: [{ track, location: playlist, kept: true }] } });
    await expect.poll(() => replies.has(1)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(snapshots.some(snapshot => snapshot.audio.codec !== null || snapshot.position > 0)).toBe(false);
  });
});

async function mockHost(supportsStopKeepPlaylist = false, configure?: (native: { set: ReturnType<typeof vi.fn>; property: ReturnType<typeof vi.fn>; devices: ReturnType<typeof vi.fn> }) => void) {
  vi.useFakeTimers();
  const { emptyAudio } = await import('../packages/core/contracts');
  const native = {
    clientApiVersion: supportsStopKeepPlaylist ? '1.109' : '1.107', supportsStopKeepPlaylist,
    devices: vi.fn((): AudioDevice[] => []), close: vi.fn(),
    command: vi.fn(), set: vi.fn(),
    property: vi.fn((_name: string): string | null => 'no'),
    number: vi.fn((name: string) => ({ 'playlist-pos': 2, 'time-pos': 12, duration: 90, volume: 100 })[name] ?? null),
    audio: vi.fn(() => ({ ...emptyAudio(), codec: 'pcm', decoderRate: 48000, outputRate: 48000 })),
    drainEvents: vi.fn(() => ({ error: null as string | null, shutdown: false, starts: 0, seeks: 0 })),
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

  it('switches output only to the system default or a device mpv lists now', async () => {
    const { sends, command, native } = await mockHost();
    const dac = { name: 'alsa/plughw:CARD=DAC', description: 'USB DAC' };
    const reply = (id: number) => sends.map(send => send.message).find(message => message.type === 'reply' && message.id === id);
    // An ALSA string naming the file plugin, which runs a command.
    command({ id: 1, action: { type: 'device', id: 'alsa/file:\'|sh -c id\'' } });
    expect(reply(1)).toEqual({ type: 'reply', id: 1, error: expect.stringContaining('not connected') });
    // Plugged in after the last poll: the list is read again before refusing.
    native.devices.mockReturnValue([dac]);
    command({ id: 2, action: { type: 'device', id: dac.name } });
    expect(reply(2)).toEqual({ type: 'reply', id: 2, error: null });
    native.devices.mockReturnValue([]);
    command({ id: 3, action: { type: 'device', id: dac.name } });
    expect(reply(3)).toEqual({ type: 'reply', id: 3, error: expect.stringContaining('not connected') });
    command({ id: 4, action: { type: 'device', id: 'auto' } });
    expect(reply(4)).toEqual({ type: 'reply', id: 4, error: null });
    expect(native.set.mock.calls.filter(([name]) => name === 'audio-device')).toEqual([['audio-device', dac.name], ['audio-device', 'auto']]);
  });

  it('opens a saved output while it is listed and the system default once it is gone', async () => {
    const dac = { name: 'alsa/plughw:CARD=DAC', description: 'USB DAC' };
    vi.stubEnv('SQUIGGLY_AUDIO_DEVICE', dac.name);
    const listed = await mockHost(false, native => native.devices.mockReturnValue([dac]));
    expect(listed.native.set).toHaveBeenCalledWith('audio-device', dac.name);
    vi.resetModules();
    const gone = await mockHost();
    expect(gone.native.set).not.toHaveBeenCalledWith('audio-device', expect.anything());
  });

  it('stops polling on core shutdown, publishes failure, and exits nonzero', async () => {
    const { sends, snapshots, native, exit } = await mockHost();
    sends[0].callback(null);
    native.drainEvents.mockReturnValue({ error: null, shutdown: true, starts: 0, seeks: 0 });
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
    native.drainEvents.mockReturnValue({ error: null, shutdown: true, starts: 0, seeks: 0 });
    vi.advanceTimersByTime(1250);
    expect(native.close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('native client API compatibility', () => {
  it('decodes only the old end-file prefix and reports shutdown separately', async () => {
    let apiVersion = (1 << 16) | 107;
    const events = [
      { event_id: 6, data: null }, { event_id: 20, data: null }, { event_id: 21, data: null },
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
    expect(native.drainEvents()).toEqual({ error: expect.stringContaining('code -13'), shutdown: true, starts: 1, seeks: 1 });
    expect(native.drainEvents()).toEqual({ error: null, shutdown: false, starts: 0, seeks: 0 });
    native.close();
    apiVersion = (1 << 16) | 109;
    const newer = new NativePlayer();
    expect(newer.clientApiVersion).toBe('1.109');
    expect(newer.supportsStopKeepPlaylist).toBe(true);
    newer.close();
  });
});

describe('native player options', () => {
  it('verifies TLS, follows no references, and asks for ytdl off where the build has it', async () => {
    const options: [string, string][] = [];
    vi.doMock('koffi', () => ({ default: {
      struct: vi.fn(), decode: vi.fn(),
      load: () => ({ func: (signature: string) => {
        if (signature.includes('mpv_create')) return () => ({});
        // A build without Lua (the Windows one) has no ytdl option.
        if (signature.includes('mpv_set_option_string')) return (_ctx: unknown, name: string, value: string) => { options.push([name, value]); return name === 'ytdl' ? -5 : 0; };
        return () => 0;
      } }),
    } }));
    const { NativePlayer } = await import('../packages/player-mpv/native');
    const native = new NativePlayer();
    expect(options).toEqual(expect.arrayContaining([['tls-verify', 'yes'], ['access-references', 'no'], ['ytdl', 'no']]));
    native.close();
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

  it('inserts before an entry for a drop onto the queue, and the playing song keeps playing', async () => {
    const { run, reply, order, snapshot, consistent } = await editableHost();
    expect(reply(run({ type: 'queue-add', tracks: [playable('x'), playable('y')], where: 3 }))).toMatchObject(ok);
    expect(order()).toEqual(['a', 'b', 'c', 'x', 'y', 'd']);
    expect(snapshot().currentIndex).toBe(1);
    consistent();
    // Before the playing song: it moves down and stays current.
    run({ type: 'queue-add', tracks: [playable('z')], where: 0 });
    expect(order()).toEqual(['z', 'a', 'b', 'c', 'x', 'y', 'd']);
    expect(snapshot().currentIndex).toBe(2);
    consistent();
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

describe('repeat and shuffle', () => {
  const loops = (native: { set: ReturnType<typeof vi.fn> }) => native.set.mock.calls.filter(([name]) => name === 'loop-file' || name === 'loop-playlist');

  it('repeats with mpv\'s own looping and reports the mode', async () => {
    const { run, reply, snapshot, native } = await editableHost();
    expect(snapshot().repeat).toBe('off');
    native.set.mockClear();
    expect(reply(run({ type: 'repeat', mode: 'all' }))).toMatchObject(ok);
    expect(loops(native)).toEqual([['loop-file', 'no'], ['loop-playlist', 'inf']]);
    expect(snapshot().repeat).toBe('all');
    native.set.mockClear();
    run({ type: 'repeat', mode: 'one' });
    expect(loops(native)).toEqual([['loop-file', 'inf'], ['loop-playlist', 'no']]);
    expect(snapshot().repeat).toBe('one');
    // Next under repeat one is still mpv's playlist-next, which moves on past a looping file.
    native.command.mockClear();
    run({ type: 'next' });
    expect(native.command).toHaveBeenCalledWith('playlist-next', 'weak');
    native.set.mockClear();
    run({ type: 'repeat', mode: 'off' });
    expect(loops(native)).toEqual([['loop-file', 'no'], ['loop-playlist', 'no']]);
    // Nothing else about playback is touched.
    expect(native.set.mock.calls.filter(([name]) => !['loop-file', 'loop-playlist'].includes(name))).toEqual([]);
  });

  it('keeps the old mode when mpv refuses a new one', async () => {
    const { run, reply, snapshot, native } = await editableHost();
    run({ type: 'repeat', mode: 'all' });
    native.set.mockImplementation((name: string, value: string) => { if (name === 'loop-file' && value === 'inf') throw new Error('Audio engine rejected loop-file.'); });
    expect(reply(run({ type: 'repeat', mode: 'one' }))).toMatchObject({ error: expect.stringContaining('repeat') });
    expect(snapshot().repeat).toBe('all');
    expect(native.set).toHaveBeenLastCalledWith('loop-playlist', 'inf');
  });

  it('shuffles the songs after the current one and leaves the rest in place', async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `t${index}`);
    const { run, reply, snapshot, order, consistent, native } = await editableHost(ids, 4);
    const entries = snapshot().entryIds;
    native.set.mockClear();
    expect(reply(run({ type: 'shuffle', on: true }))).toMatchObject(ok);
    expect(snapshot().shuffle).toBe(true);
    // The current song and the ones already played keep their places; nothing starts over.
    expect(order().slice(0, 5)).toEqual(ids.slice(0, 5));
    expect(snapshot().currentIndex).toBe(4);
    expect(snapshot().entryIds[4]).toBe(entries[4]);
    expect(native.set).not.toHaveBeenCalledWith('playlist-pos', expect.anything());
    // The same songs after it, with their entry ids, in another order.
    expect([...order().slice(5)].sort()).toEqual([...ids.slice(5)].sort());
    expect(order().slice(5)).not.toEqual(ids.slice(5));
    expect(snapshot().entryIds.map(entry => ids[entries.indexOf(entry)])).toEqual(order());
    consistent();
    // Off leaves the shuffled order as it is; on again while on does nothing.
    const shuffled = order();
    run({ type: 'shuffle', on: false });
    expect(snapshot().shuffle).toBe(false);
    expect(order()).toEqual(shuffled);
    run({ type: 'shuffle', on: true });
    const again = order();
    run({ type: 'shuffle', on: true });
    expect(order()).toEqual(again);
    consistent();
  });

  it('shuffles the whole queue when nothing is current', async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `t${index}`);
    const { run, order, consistent, snapshot } = await editableHost(ids, 0);
    run({ type: 'stop' });
    run({ type: 'shuffle', on: true });
    expect([...order()].sort()).toEqual([...ids].sort());
    expect(order()).not.toEqual(ids);
    expect(snapshot().currentIndex).toBe(-1);
    consistent();
  });

  // mpv moves on to the next song at one read or another of playlist-pos during the moves. With
  // random() at 0 the plan for A is [A, C, D, E, B]: moving on to B before the first move used to
  // leave B last and playing, with C, D, and E skipped.
  it.each([2, 3, 4, 6, 9])('keeps the songs after the one mpv moves on to while the shuffle runs (read %i)', async at => {
    const { run, snapshot, order, consistent, native, mpv } = await editableHost(['a', 'b', 'c', 'd', 'e'], 0);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const read = native.number.getMockImplementation()!;
    let reads = 0;
    native.number.mockImplementation((name: string) => {
      if (name === 'playlist-pos' && ++reads === at) mpv.select(mpv.current() + 1);
      return read(name);
    });
    run({ type: 'shuffle', on: true });
    expect(reads).toBeGreaterThanOrEqual(at);
    // A played, the song after it is playing, and the other three still follow it.
    expect(order()[0]).toBe('a');
    expect(snapshot().currentIndex).toBe(1);
    expect([...order()].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    consistent();
  });

  it('shuffles a new queue after the chosen song, but not radio or a restored queue', async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `t${index}`);
    const { run, order, consistent, snapshot, deliver } = await editableHost(ids, 0);
    run({ type: 'shuffle', on: true });
    run({ type: 'queue', tracks: ids.map(playable), startIndex: 3 });
    vi.advanceTimersByTime(250); deliver();
    expect(order().slice(0, 4)).toEqual(ids.slice(0, 4));
    expect(order().slice(4)).not.toEqual(ids.slice(4));
    expect([...order()].sort()).toEqual([...ids].sort());
    expect(snapshot().currentIndex).toBe(3);
    consistent();
    run({ type: 'queue', tracks: ids.map(playable), startIndex: 3, ordered: true });
    vi.advanceTimersByTime(250); deliver();
    expect(order()).toEqual(ids);
    consistent();
  });

  it('starts with the modes the desktop saved', async () => {
    vi.stubEnv('SQUIGGLY_REPEAT', 'one');
    vi.stubEnv('SQUIGGLY_SHUFFLE', '1');
    const { native, snapshots } = await mockHost();
    expect(native.set).toHaveBeenCalledWith('loop-file', 'inf');
    expect(snapshots()[0].player).toMatchObject({ repeat: 'one', shuffle: true });
  });
});

describe('play identity', () => {
  // One 4 Hz poll, draining these mpv events, then the playId the snapshot carries.
  async function playHost(ids = ['a', 'b']) {
    const host = await editableHost(ids, 0);
    const tick = (events: { starts?: number; seeks?: number } = {}) => {
      host.native.drainEvents.mockReturnValueOnce({ error: null, shutdown: false, starts: 0, seeks: 0, ...events });
      vi.advanceTimersByTime(250); host.deliver();
      return host.snapshot().playId;
    };
    return { ...host, tick };
  }

  it('changes when an entry starts from the top, never on a seek', async () => {
    const { run, tick, mpv } = await playHost();
    const first = tick();
    expect(first).not.toBe('');
    // The entry's own start-file, arriving a poll later, is the same play.
    expect(tick({ starts: 1 })).toBe(first);
    expect(tick()).toBe(first);
    // A seek, even back to the start, keeps the play; so does a queue edit.
    run({ type: 'seek', seconds: 0, queueIndex: 0, trackId: 'a' });
    expect(tick({ seeks: 1 })).toBe(first);
    run({ type: 'queue-add', tracks: [playable('c')], where: 'next' });
    expect(tick()).toBe(first);
    // Another entry is another play.
    mpv.select(1);
    const second = tick({ starts: 1 });
    expect(second).not.toBe(first);
    // The same entry loaded again (repeat all over one song) is another play.
    const third = tick({ starts: 1 });
    expect(third).not.toBe(second);
  });

  it('changes when repeat one starts the song over, which mpv does by seeking', async () => {
    const { run, tick } = await playHost();
    const first = tick({ starts: 1 });
    // Under repeat off, a seek the host didn't ask for is not a loop.
    expect(tick({ seeks: 1 })).toBe(first);
    run({ type: 'repeat', mode: 'one' });
    const second = tick({ seeks: 1 });
    expect(second).not.toBe(first);
    // A seek of the host's own, even to the start, is not.
    run({ type: 'seek', seconds: 0, queueIndex: 0, trackId: 'a' });
    expect(tick({ seeks: 1 })).toBe(second);
    for (let poll = 0; poll < 4; poll++) tick();
    expect(tick({ seeks: 1 })).not.toBe(second);
  });

  it('starts the entry playing over when it is jumped to', async () => {
    const { run, tick, native, snapshot } = await playHost();
    const first = tick({ starts: 1 });
    native.command.mockClear(); native.set.mockClear();
    run({ type: 'queue-jump', index: 0, entryId: snapshot().entryIds[0] });
    expect(native.command).toHaveBeenCalledWith('seek', '0', 'absolute+exact');
    expect(native.set).not.toHaveBeenCalledWith('playlist-pos', expect.anything());
    const second = snapshot().playId;
    expect(second).not.toBe(first);
    expect(tick({ seeks: 1 })).toBe(second);
  });

  it('gives the play tracker one play per listen under repeat one', async () => {
    const { PlayTracker } = await import('../apps/desktop/main/plays');
    const { run, tick, snapshot, native } = await playHost();
    run({ type: 'repeat', mode: 'one' });
    const tracker = new PlayTracker();
    const events: string[] = [];
    // Two full listens of a 200-second song, position read from mpv at each poll.
    let position = 0;
    const read = native.number.getMockImplementation()!;
    native.number.mockImplementation((name: string) => name === 'time-pos' ? position : name === 'duration' ? 200 : read(name));
    for (let poll = 0; poll < 1600; poll++) {
      position = (poll % 800) / 4;
      tick(poll === 0 ? { starts: 1 } : poll % 800 === 0 ? { seeks: 1 } : {});
      events.push(...tracker.update(snapshot(), poll * 250).map(event => event.event));
    }
    expect(events).toEqual(['started', 'finished', 'started', 'finished']);
  });
});

describe('restoring a saved queue', () => {
  // The values the host set for mpv's pause, in order, with mpv's pause following them.
  function pauses(native: Awaited<ReturnType<typeof mockHost>>['native']) {
    let paused = 'no';
    const inner = native.set.getMockImplementation();
    native.set.mockImplementation((name: string, value: string) => { if (name === 'pause') paused = value; inner?.(name, value); });
    const property = native.property.getMockImplementation();
    native.property.mockImplementation((name: string) => name === 'pause' ? paused : property?.(name) ?? null);
    return () => native.set.mock.calls.filter(([name]) => name === 'pause').map(([, value]) => value);
  }
  // The next poll finds mpv's seek event: the seek it was sent has been carried out.
  const landed = (native: Awaited<ReturnType<typeof mockHost>>['native']) =>
    native.drainEvents.mockReturnValueOnce({ error: null, shutdown: false, starts: 0, seeks: 1 });

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
    // Pressing play before the stream opens keeps the pending position, and plays once it lands.
    command({ id: 2, action: { type: 'play' } });
    expect(native.set.mock.calls.filter(([name]) => name === 'pause')).toEqual([['pause', 'yes']]);
    seekable = true;
    vi.advanceTimersByTime(250);
    expect(native.command).toHaveBeenCalledWith('seek', '83.5', 'absolute+exact');
    expect(native.set.mock.calls.filter(([name]) => name === 'pause')).toEqual([['pause', 'yes']]);
    landed(native);
    vi.advanceTimersByTime(250);
    expect(native.set.mock.calls.filter(([name]) => name === 'pause')).toEqual([['pause', 'yes'], ['pause', 'no']]);
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

  it('resumes playing from the saved position, paused until the seek lands', async () => {
    const { snapshots, command, native, deliver } = await mockHost(true);
    deliver();
    const mpv = mpvPlaylist(native);
    let seekable = false;
    native.property.mockImplementation((name: string) => name === 'seekable' ? (seekable ? 'yes' : 'no') : 'no');
    const paused = pauses(native);
    command({ id: 1, action: { type: 'queue', tracks: ['a', 'b', 'c'].map(playable), startIndex: 1, startPosition: 83.5, paused: false } });
    // Paused before the first load, so 0:00 never plays on the way to the saved position.
    expect(paused()).toEqual(['yes']);
    const pauseOrder = native.set.mock.invocationCallOrder[native.set.mock.calls.findIndex(([name]) => name === 'pause')];
    expect(pauseOrder).toBeLessThan(native.command.mock.invocationCallOrder[native.command.mock.calls.findIndex(([name]) => name === 'loadfile')]);
    expect(mpv.current()).toBe(1);
    vi.advanceTimersByTime(500); deliver();
    // Loading shows as starting at the saved position, not paused at 0:00.
    expect(snapshots().at(-1)!.player).toMatchObject({ playing: true, position: 83.5, audio: { buffering: true } });
    seekable = true;
    vi.advanceTimersByTime(250); deliver();
    expect(native.command).toHaveBeenLastCalledWith('seek', '83.5', 'absolute+exact');
    // mpv would play what it buffered at 0:00 before carrying out the seek, so it stays paused,
    // and shown as starting, until mpv reports the seek.
    expect(paused()).toEqual(['yes']);
    expect(snapshots().at(-1)!.player).toMatchObject({ playing: true, position: 83.5 });
    landed(native);
    vi.advanceTimersByTime(250); deliver();
    expect(paused()).toEqual(['yes', 'no']);
    vi.advanceTimersByTime(250); deliver();
    expect(snapshots().at(-1)!.player).toMatchObject({ playing: true, audio: { buffering: false } });
  });

  it('plays from the start with a plain error when a resumed song never becomes seekable', async () => {
    const { snapshots, command, native, deliver } = await mockHost(true);
    mpvPlaylist(native);
    const paused = pauses(native);
    command({ id: 1, action: { type: 'queue', tracks: [playable('a')], startPosition: 30, paused: false } });
    for (let i = 0; i < 40; i++) { vi.advanceTimersByTime(250); deliver(); }
    expect(paused()).toEqual(['yes']);
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(250); deliver(); }
    expect(snapshots().at(-1)!.player.error).toContain('saved position');
    expect(paused()).toEqual(['yes', 'no']);
    expect(native.command).not.toHaveBeenCalledWith('seek', expect.anything(), expect.anything());
  });

  it('follows what the user does while a resume loads', async () => {
    const { snapshots, command, native, deliver } = await mockHost(true);
    deliver();
    const mpv = mpvPlaylist(native);
    let seekable = false;
    native.property.mockImplementation((name: string) => name === 'seekable' ? (seekable ? 'yes' : 'no') : 'no');
    const paused = pauses(native);
    let id = 0;
    const resume = () => {
      seekable = false; native.set.mockClear(); native.command.mockClear();
      command({ id: ++id, action: { type: 'queue', tracks: ['a', 'b'].map(playable), startPosition: 30, paused: false } });
      expect(paused()).toEqual(['yes']);
    };
    const seeks = () => native.command.mock.calls.filter(([name]) => name === 'seek');
    // Pause stays paused: the seek still lands, and nothing plays.
    resume();
    command({ id: ++id, action: { type: 'pause' } });
    vi.advanceTimersByTime(250); deliver();
    expect(snapshots().at(-1)!.player.playing).toBe(false);
    seekable = true;
    vi.advanceTimersByTime(500); deliver();
    expect(seeks()).toEqual([['seek', '30', 'absolute+exact']]);
    expect(paused()).toEqual(['yes', 'yes']);
    expect(snapshots().at(-1)!.player.playing).toBe(false);
    // Next and a seek of its own drop the saved position and play.
    resume();
    command({ id: ++id, action: { type: 'next' } });
    mpv.select(1); seekable = true;
    vi.advanceTimersByTime(500);
    expect(paused()).toEqual(['yes', 'no']);
    expect(seeks()).toEqual([]);
    resume();
    mpv.select(0);
    command({ id: ++id, action: { type: 'seek', seconds: 12, queueIndex: 0, trackId: 'a' } });
    expect(seeks()).toEqual([['seek', '12', 'absolute+exact']]);
    expect(paused()).toEqual(['yes']);
    seekable = true; landed(native);
    vi.advanceTimersByTime(250); deliver();
    expect(seeks()).toEqual([['seek', '12', 'absolute+exact']]);
    expect(paused()).toEqual(['yes', 'no']);
    // A refused seek changes nothing: the saved position still lands, then plays, a second on
    // when mpv never reports the seek.
    resume();
    command({ id: ++id, action: { type: 'seek', seconds: 12, queueIndex: 1, trackId: 'b' } });
    expect(paused()).toEqual(['yes']);
    seekable = true;
    vi.advanceTimersByTime(250);
    expect(seeks()).toEqual([['seek', '30', 'absolute+exact']]);
    vi.advanceTimersByTime(1000);
    expect(paused()).toEqual(['yes']);
    vi.advanceTimersByTime(250);
    expect(paused()).toEqual(['yes', 'no']);
    // Stop stays stopped.
    resume();
    command({ id: ++id, action: { type: 'stop' } });
    seekable = true;
    vi.advanceTimersByTime(12_000);
    expect(paused()).toEqual(['yes']);
    expect(seeks()).toEqual([]);
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

// A mono 16-bit WAV of a 440 Hz tone, from sample `from` of one continuous tone, at `rate`.
function tone(rate: number, seconds: number, from = 0) {
  const samples = Math.round(rate * seconds), bytes = samples * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin((from + i) * 2 * Math.PI * 440 / rate) * 8000), 44 + i * 2);
  return wav;
}
// Serves files the way a music server does, over HTTP; `/slow/…` answers after a delay.
async function serve(files: Record<string, Buffer>) {
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => {
    const path = request.url!.replace(/^\/slow/, '');
    const body = files[path];
    if (!body) { response.writeHead(404).end(); return; }
    setTimeout(() => response.writeHead(200, { 'content-type': 'audio/wav', 'content-length': body.length }).end(body), request.url!.startsWith('/slow') ? 400 : 0);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  return { url: (path: string) => `http://127.0.0.1:${port}${path}`, close: () => server.close() };
}
const streamed = (location: string, id: string, rate: number) => ({ location, track: {
  id, title: id, artist: '', album: '', duration: 2, source: 'navidrome' as const, sourceFormat: 'wav', sourceSampleRate: rate, sourceBitDepth: 16,
} });

describe.skipIf(!process.env.SQUIGGLY_LIBMPV_PATH)('repeat in real libmpv', () => {
  it('wraps from the last song to the first with repeat all, and replays one song with repeat one', async () => {
    const file = await wavFixture(1);
    const { snapshots, replies, send } = start(process.env.SQUIGGLY_LIBMPV_PATH!);
    await expect.poll(() => snapshots.at(-1)?.engine).toBe('ready');
    const item = (id: string) => ({ location: file, track: { id, title: id, artist: '', album: '', duration: 1, source: 'local' as const,
      sourceFormat: 'wav', sourceSampleRate: null, sourceBitDepth: null } });
    send({ id: 1, action: { type: 'repeat', mode: 'all' } });
    await expect.poll(() => replies.get(1)).toBeNull();
    send({ id: 2, action: { type: 'queue', tracks: ['a', 'b'].map(item), startIndex: 1 } });
    await expect.poll(() => snapshots.at(-1)?.playing).toBe(true);
    // The last song ends and the first plays, rather than the queue stopping.
    await expect.poll(() => snapshots.at(-1)?.currentIndex, { timeout: 5000 }).toBe(0);
    expect(snapshots.at(-1)).toMatchObject({ playing: true, repeat: 'all' });
    send({ id: 3, action: { type: 'repeat', mode: 'one' } });
    await expect.poll(() => replies.get(3)).toBeNull();
    // Played past its one second, the song is still current and has started over.
    await new Promise(resolve => setTimeout(resolve, 2500));
    expect(snapshots.at(-1)).toMatchObject({ currentIndex: 0, playing: true, repeat: 'one' });
    send({ id: 4, action: { type: 'next' } });
    await expect.poll(() => snapshots.at(-1)?.currentIndex).toBe(1);
  });
});

describe.skipIf(!process.env.SQUIGGLY_LIBMPV_PATH)('gapless playback in real libmpv', () => {
  it('plays two halves of one tone as one tone, even when the second stream is slow to start', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'squiggly-gapless-'));
    const output = join(fixtureDirectory, 'output.wav');
    const rate = 48000, half = rate * 2;
    const server = await serve({ '/one.wav': tone(rate, 2), '/two.wav': tone(rate, 2, half) });
    try {
      const { snapshots, send } = start(process.env.SQUIGGLY_LIBMPV_PATH!, { SQUIGGLY_TEST_PCM_FILE: output });
      await expect.poll(() => snapshots.at(-1)?.engine).toBe('ready');
      send({ id: 1, action: { type: 'queue', tracks: [streamed(server.url('/one.wav'), 'one', rate), streamed(server.url('/slow/two.wav'), 'two', rate)] } });
      await expect.poll(() => snapshots.some(s => s.currentIndex === 1), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => snapshots.at(-1)?.currentIndex, { timeout: 15_000 }).toBe(-1);
    } finally { server.close(); }
    const { readFile } = await import('node:fs/promises');
    const wav = await readFile(output);
    // The output stayed open across the join: one file, both halves, at the songs' own rate.
    expect(wav.readUInt32LE(24)).toBe(rate);
    const channels = wav.readUInt16LE(22), bits = wav.readUInt16LE(34);
    const data = wav.subarray(wav.indexOf('data') + 8);
    const frame = channels * bits / 8;
    const read = (i: number) => bits === 16 ? data.readInt16LE(i * frame) / 32768 : bits === 32 && wav.readUInt16LE(20) === 3 ? data.readFloatLE(i * frame) : data.readInt32LE(i * frame) / 2 ** 31;
    const frames = Math.floor(data.length / frame);
    expect(Math.abs(frames - 2 * half)).toBeLessThan(rate / 100);
    // No silence and no click anywhere: a 440 Hz tone at this level never changes by more than
    // about 0.014 between samples, and never stays near zero for more than a sample or two.
    let jump = 0, quiet = 0, longestQuiet = 0;
    for (let i = 1; i < frames; i++) {
      jump = Math.max(jump, Math.abs(read(i) - read(i - 1)));
      quiet = Math.abs(read(i)) < 0.001 ? quiet + 1 : 0; longestQuiet = Math.max(longestQuiet, quiet);
    }
    expect(jump).toBeLessThan(0.02);
    expect(longestQuiet).toBeLessThan(4);
  });

  it('switches the output to a new sample rate instead of resampling to the first song\'s', async () => {
    const server = await serve({ '/48.wav': tone(48000, 1), '/44.wav': tone(44100, 1) });
    try {
      const { snapshots, send } = start(process.env.SQUIGGLY_LIBMPV_PATH!);
      await expect.poll(() => snapshots.at(-1)?.engine).toBe('ready');
      send({ id: 1, action: { type: 'queue', tracks: [streamed(server.url('/48.wav'), 'a', 48000), streamed(server.url('/44.wav'), 'b', 44100)] } });
      await expect.poll(() => snapshots.at(-1)?.audio.outputRate, { timeout: 10_000 }).toBe(48000);
      await expect.poll(() => snapshots.find(s => s.currentIndex === 1 && s.audio.outputRate === 44100)?.audio.outputRate, { timeout: 10_000 }).toBe(44100);
    } finally { server.close(); }
  });
});

describe('internet radio stations', () => {
  const station = (id: string) => ({ location: `https://radio.example/${id}.mp3?listener=private`, track: {
    id, title: `Station ${id}`, artist: '', album: '', duration: null, source: 'station' as const,
    sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null,
  } });
  async function radioHost() {
    const host = await mockHost(true);
    const mpv = mpvPlaylist(host.native);
    let id = 0;
    const run = (action: HostRequest['action']) => { const requestId = ++id; host.command({ id: requestId, action }); host.deliver(); return requestId; };
    const reply = (requestId: number) => host.sends.map(send => send.message).find(message => message.type === 'reply' && message.id === requestId);
    const snapshot = () => host.snapshots().at(-1)!.player;
    const tick = () => { vi.advanceTimersByTime(250); host.deliver(); return snapshot(); };
    host.deliver();
    return { ...host, mpv, run, reply, snapshot, tick };
  }

  it('loads a station entry by its stream address and reports what it says is on, or nothing', async () => {
    const { run, reply, native, mpv, tick } = await radioHost();
    let announced: string | null = '  Ada Brass -   Harbour Lights ';
    native.property.mockImplementation((name: string) => name === 'metadata/by-key/icy-title' ? announced : 'no');
    expect(reply(run({ type: 'queue', tracks: [playable('a'), station('jazz')], startIndex: 1 }))).toMatchObject(ok);
    expect(native.command).toHaveBeenCalledWith('loadfile', 'https://radio.example/jazz.mp3?listener=private', 'append');
    expect(mpv.locations()).toEqual(['/a.flac', 'https://radio.example/jazz.mp3?listener=private']);
    const polled = tick();
    expect(polled).toMatchObject({ currentIndex: 1, playing: true, duration: 0, stationTitle: 'Ada Brass - Harbour Lights' });
    expect(polled.queue[1].source).toBe('station');
    // The stream address stays in the host.
    expect(JSON.stringify(polled)).not.toContain('radio.example');
    // A song has no station title, whatever mpv's metadata holds.
    mpv.select(0);
    expect(tick().stationTitle).toBeNull();
    // A station that announces nothing: unknown, not an empty title.
    announced = null; mpv.select(1);
    expect(tick().stationTitle).toBeNull();
    announced = '   ';
    expect(tick().stationTitle).toBeNull();
  });

  it('makes a seek on a station a no-op, and a jump to the station playing leaves it playing', async () => {
    const { run, reply, native, mpv, snapshot, tick } = await radioHost();
    run({ type: 'queue', tracks: [station('jazz'), playable('a')] });
    tick();
    const [entryId] = snapshot().entryIds;
    native.command.mockClear(); native.set.mockClear();
    expect(reply(run({ type: 'seek', seconds: 30, queueIndex: 0, trackId: 'jazz', entryId }))).toMatchObject(ok);
    expect(reply(run({ type: 'seek', seconds: 0, queueIndex: 0, trackId: 'jazz' }))).toMatchObject(ok);
    expect(native.command).not.toHaveBeenCalled();
    const play = snapshot().playId;
    expect(reply(run({ type: 'queue-jump', index: 0, entryId }))).toMatchObject(ok);
    expect(native.command).not.toHaveBeenCalled();
    expect(native.set).toHaveBeenCalledWith('pause', 'no');
    expect(snapshot().playId).toBe(play);
    // A seek that names the station after the queue moved on is still refused as stale.
    mpv.select(1); tick();
    expect(reply(run({ type: 'seek', seconds: 30, queueIndex: 0, trackId: 'jazz', entryId }))).toMatchObject({ error: expect.stringContaining('track changed') });
    // Songs still seek.
    expect(reply(run({ type: 'seek', seconds: 10, queueIndex: 1, trackId: 'a' }))).toMatchObject(ok);
    expect(native.command).toHaveBeenCalledWith('seek', '10', 'absolute+exact');
  });

  it('opens nothing early while a station is queued, so a station joins live when its turn comes', async () => {
    const { run, reply, native, mpv, tick } = await radioHost();
    const prefetch = () => native.set.mock.calls.filter(([name]) => name === 'prefetch-playlist').map(([, value]) => value);
    // When each call happened, to check prefetch is off before mpv holds a station's address.
    const order = (mock: typeof native.set, match: (args: string[]) => boolean) => mock.mock.invocationCallOrder[mock.mock.calls.findIndex(args => match(args as string[]))];
    const prefetchOff = () => order(native.set, ([name, value]) => name === 'prefetch-playlist' && value === 'no');
    const loaded = (id: string) => order(native.command, ([name, location]) => name === 'loadfile' && location.includes(`/${id}.mp3`));
    // Songs only: prefetch stays on (native.ts), for gapless playback over the network.
    run({ type: 'queue', tracks: [playable('a'), playable('b')] });
    tick();
    expect(prefetch()).toEqual([]);
    expect(reply(run({ type: 'queue-add', tracks: [station('jazz')], where: 'end' }))).toMatchObject(ok);
    expect(prefetch()).toEqual(['no']);
    expect(prefetchOff()).toBeLessThan(loaded('jazz'));
    // Removing the station turns it back on.
    expect(reply(run({ type: 'queue-remove', indexes: [2] }))).toMatchObject(ok);
    expect(mpv.locations()).toEqual(['/a.flac', '/b.flac']);
    expect(prefetch()).toEqual(['no', 'yes']);
    // A new queue holding a station: off before any of it is loaded.
    native.set.mockClear(); native.command.mockClear();
    expect(reply(run({ type: 'queue', tracks: [playable('c'), station('talk')] }))).toMatchObject(ok);
    expect(prefetch()).toEqual(['no']);
    expect(prefetchOff()).toBeLessThan(loaded('talk'));
    run({ type: 'clear-session' });
    expect(prefetch()).toEqual(['no', 'yes']);
    // If mpv won't turn it off, the station isn't added.
    native.set.mockImplementation((name: string) => { if (name === 'prefetch-playlist') throw new Error('rejected'); });
    expect(reply(run({ type: 'queue-add', tracks: [station('jazz')], where: 'end' }))).toMatchObject({ error: expect.any(String) });
    expect(mpv.locations().some(location => location.includes('jazz'))).toBe(false);
  });

  it('keeps repeat one off while a station plays, and on again after it', async () => {
    const { run, native, mpv, snapshot, tick } = await radioHost();
    const loopFile = () => native.set.mock.calls.filter(([name]) => name === 'loop-file').map(([, value]) => value);
    run({ type: 'queue', tracks: [playable('a'), station('jazz'), playable('b')] });
    tick();
    run({ type: 'repeat', mode: 'one' });
    expect(loopFile()).toEqual(['inf']);
    mpv.select(1); tick();
    expect(loopFile()).toEqual(['inf', 'no']);
    tick();
    expect(loopFile()).toEqual(['inf', 'no']);
    // The mode itself stays as chosen.
    expect(snapshot().repeat).toBe('one');
    mpv.select(2); tick();
    expect(loopFile()).toEqual(['inf', 'no', 'inf']);
    // Choosing repeat one while the station plays leaves loop-file off.
    run({ type: 'repeat', mode: 'off' }); mpv.select(1); tick();
    run({ type: 'repeat', mode: 'one' });
    expect(loopFile().at(-1)).toBe('no');
  });
});

describe.skipIf(!process.env.SQUIGGLY_LIBMPV_PATH)('internet radio in real libmpv', () => {
  it('connects to a station only when its turn comes, not while the song before it plays', async () => {
    const { createServer } = await import('node:http');
    const rate = 48000, seconds = 3;
    const song = await serve({ '/song.wav': tone(rate, seconds) });
    // A live station: an endless WAV, a tenth of a second at a time, as a broadcast sends it.
    // Each connection is noted, from when the queue was sent.
    let sent = 0;
    const connections: number[] = [];
    const chunk = tone(rate, 0.1).subarray(44);
    const station = createServer((_request, response) => {
      connections.push(performance.now() - sent);
      const header = tone(rate, 0).subarray(0, 44);
      header.writeUInt32LE(0x7fffffff, 4); header.writeUInt32LE(0x7fffffff - 36, 40);
      response.writeHead(200, { 'content-type': 'audio/wav' });
      response.write(header);
      const timer = setInterval(() => response.write(chunk), 100);
      response.on('close', () => clearInterval(timer));
    });
    await new Promise<void>(done => station.listen(0, '127.0.0.1', done));
    const live = `http://127.0.0.1:${(station.address() as { port: number }).port}/live`;
    try {
      const { snapshots, send } = start(process.env.SQUIGGLY_LIBMPV_PATH!);
      await expect.poll(() => snapshots.at(-1)?.engine).toBe('ready');
      sent = performance.now();
      send({ id: 1, action: { type: 'queue', tracks: [streamed(song.url('/song.wav'), 'song', rate), { location: live, track: {
        id: 'station:1', title: 'Live', artist: '', album: '', duration: null, source: 'station',
        sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null,
      } }] } });
      await expect.poll(() => snapshots.at(-1)?.currentIndex, { timeout: 10_000 }).toBe(1);
      await expect.poll(() => snapshots.at(-1)?.playing, { timeout: 5000 }).toBe(true);
      // The song's whole file arrives at once, which is when mpv would open the next entry. The
      // station's stream was opened once, near the end of the song, and never before.
      expect(connections).toHaveLength(1);
      expect(connections[0]).toBeGreaterThan((seconds - 0.5) * 1000);
    } finally { song.close(); station.closeAllConnections(); station.close(); }

describe.skipIf(!process.env.SQUIGGLY_LIBMPV_PATH)('resuming in real libmpv', () => {
  const item = (location: string, id: string, duration: number) => ({ location, track: { id, title: id, artist: '', album: '', duration, source: 'local' as const,
    sourceFormat: 'wav', sourceSampleRate: null, sourceBitDepth: null } });

  it('plays a resumed queue from its saved position without playing 0:00 first', async () => {
    const file = await wavFixture(8);
    const { snapshots, replies, send } = start(process.env.SQUIGGLY_LIBMPV_PATH!);
    await expect.poll(() => snapshots.at(-1)?.engine).toBe('ready');
    send({ id: 1, action: { type: 'queue', tracks: [item(file, 'a', 8)], startPosition: 5, paused: false } });
    await expect.poll(() => replies.get(1)).toBeNull();
    // Really playing on from the saved position, not only reported as starting there.
    await expect.poll(() => snapshots.at(-1)?.position ?? 0, { timeout: 5000 }).toBeGreaterThan(5.4);
    expect(snapshots.at(-1)).toMatchObject({ playing: true, currentIndex: 0 });
    const playing = snapshots.filter(s => s.playing);
    expect(playing.length).toBeGreaterThan(0);
    expect(Math.min(...playing.map(s => s.position))).toBeGreaterThanOrEqual(4.5);
  });

  it('writes only the audio after the saved position', async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), 'squiggly-resume-'));
    const output = join(fixtureDirectory, 'output.wav');
    const source = join(fixtureDirectory, 'marked.wav');
    // Loud for the first three seconds, an eighth as loud after, so any of the start shows.
    const rate = 48000, wav = tone(rate, 6);
    for (let i = rate * 3; i < rate * 6; i++) wav.writeInt16LE(Math.round(wav.readInt16LE(44 + i * 2) / 8), 44 + i * 2);
    await writeFile(source, wav);
    const { snapshots, send } = start(process.env.SQUIGGLY_LIBMPV_PATH!, { SQUIGGLY_TEST_PCM_FILE: output });
    await expect.poll(() => snapshots.at(-1)?.engine).toBe('ready');
    send({ id: 1, action: { type: 'queue', tracks: [item(source, 'm', 6)], startPosition: 3, paused: false } });
    // The PCM output doesn't keep time, so the rest of the song plays out at once.
    await expect.poll(() => snapshots.some(s => s.currentIndex === 0), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => snapshots.at(-1)?.currentIndex, { timeout: 10_000 }).toBe(-1);
    expect(snapshots.filter(s => s.playing).every(s => s.position >= 2.5)).toBe(true);
    const { readFile } = await import('node:fs/promises');
    let out = Buffer.alloc(0), data = out, frame = 1;
    const frames = async () => {
      out = await readFile(output); data = out.subarray(out.indexOf('data') + 8);
      frame = out.readUInt16LE(22) * out.readUInt16LE(34) / 8;
      return Math.floor(data.length / frame);
    };
    // Three seconds, all of it the quiet half. mpv may still be writing its last buffer.
    await expect.poll(async () => Math.abs(await frames() - rate * 3), { timeout: 5000 }).toBeLessThan(rate / 20);
    const bits = out.readUInt16LE(34);
    const read = (i: number) => bits === 16 ? data.readInt16LE(i * frame) / 32768 : bits === 32 && out.readUInt16LE(20) === 3 ? data.readFloatLE(i * frame) : data.readInt32LE(i * frame) / 2 ** 31;
    let peak = 0;
    for (let i = 0, count = Math.floor(data.length / frame); i < count; i++) peak = Math.max(peak, Math.abs(read(i)));
    expect(peak).toBeGreaterThan(0.02);
    expect(peak).toBeLessThan(0.05);
  });

  it('stays paused when paused while a resume loads', async () => {
    const file = await wavFixture(8);
    const { snapshots, replies, send } = start(process.env.SQUIGGLY_LIBMPV_PATH!);
    await expect.poll(() => snapshots.at(-1)?.engine).toBe('ready');
    send({ id: 1, action: { type: 'queue', tracks: [item(file, 'a', 8)], startPosition: 5, paused: false } });
    send({ id: 2, action: { type: 'pause' } });
    await expect.poll(() => replies.get(2)).toBeNull();
    // The seek still lands, and playback stays where it put it.
    await expect.poll(() => snapshots.at(-1)?.position ?? 0, { timeout: 5000 }).toBeGreaterThan(4.9);
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(snapshots.at(-1)).toMatchObject({ playing: false, currentIndex: 0 });
    expect(snapshots.at(-1)!.position).toBeLessThan(5.3);
    send({ id: 3, action: { type: 'play' } });
    await expect.poll(() => snapshots.at(-1)?.position ?? 0, { timeout: 5000 }).toBeGreaterThan(5.4);
  });
});
