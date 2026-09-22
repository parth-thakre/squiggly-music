import { afterEach, describe, expect, it } from 'vitest';
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
    send({ id: 1, action: { type: 'queue', tracks: [{ location: file, track: {
      id: 'test', title: 'Generated PCM', artist: 'Test', album: '', duration: 4, source: 'local',
      sourceFormat: 'wav', sourceSampleRate: null, sourceBitDepth: null,
    } }] } });
    await expect.poll(() => snapshots.at(-1)?.playing).toBe(true);
    expect(replies.get(1)).toBeNull();
    expect(snapshots.at(-1)?.audio.decoderRate).toBe(48000);
    expect(snapshots.at(-1)?.audio.outputBackend).toBe('null');
    expect(snapshots.at(-1)?.audio.replayGain).toBe('no');
    expect(JSON.stringify(snapshots)).not.toContain(fixtureDirectory);
    send({ id: 2, action: { type: 'pause' } });
    await expect.poll(() => snapshots.at(-1)?.playing).toBe(false);
    send({ id: 3, action: { type: 'seek', seconds: 1 } });
    await expect.poll(() => replies.has(3)).toBe(true);
    expect(replies.get(3)).toBeNull();
    await expect.poll(() => snapshots.at(-1)?.position).toBeCloseTo(1, 1);
    send({ id: 4, action: { type: 'volume', percent: 50 } });
    await expect.poll(() => snapshots.at(-1)?.volume).toBe(50);
    send({ id: 5, action: { type: 'stop' } });
    await expect.poll(() => snapshots.at(-1)?.currentIndex).toBe(-1);
  });
});
