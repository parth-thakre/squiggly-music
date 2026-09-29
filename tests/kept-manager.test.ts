import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeepKind, Track } from '../packages/core/contracts';
import { KEPT_MESSAGES, limitMessage, MB } from '../packages/core/kept';
import { ServerError, Unreachable } from '../packages/adapter-opensubsonic/client';
import { KeptStore } from '../apps/desktop/main/keptStore';
import { choosePlayable, KeepManager, pickLocation, type KeepDeps } from '../apps/desktop/main/keepManager';

let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

const song = (id: string, extra: Partial<Track> = {}): Track => ({
  id, title: `Song ${id}`, artist: 'Ada Brass', album: 'Test Pressing', duration: 120, source: 'navidrome',
  sourceFormat: 'flac', sourceSampleRate: 44100, sourceBitDepth: 16, albumId: 'al-1', coverArt: 'al-1', starred: true, userRating: 4, ...extra,
});
const bytesOf = (id: string) => new TextEncoder().encode(`audio of ${id} `.repeat(8));

// A fake server: each song's body waits until the test lets it through (or streams at once).
async function setup(options: Partial<KeepDeps> & { gated?: boolean; respond?: (id: string) => Response | Promise<Response> } = {}) {
  dir = await mkdtemp(join(tmpdir(), 'squiggly-keep-'));
  const store = new KeptStore(dir);
  await store.load();
  await store.bind('host\nlistener');
  const known = new Map<string, Track>();
  const gates = new Map<string, () => void>();
  const opened: string[] = [];
  let open = 0, most = 0;
  const unreachable = vi.fn();
  const queue = new Set<string>();
  let away = false;
  const respond = options.respond ?? ((id: string) => {
    const bytes = bytesOf(id);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (options.gated) await new Promise<void>(resolve => gates.set(id, resolve));
        controller.enqueue(bytes); controller.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'audio/flac', 'content-length': String(bytes.length) } });
  });
  const manager = new KeepManager({
    store, known: id => known.get(id),
    open: async (id, signal) => {
      opened.push(id); open++; most = Math.max(most, open);
      signal.addEventListener('abort', () => { open--; }, { once: true });
      const response = await respond(id);
      if (!response.body) { open--; return response; }
      // Count a download as open until its body is read through or cancelled.
      const reader = response.body.getReader();
      const counted = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) { open--; controller.close(); } else controller.enqueue(value);
          } catch (error) { open--; controller.error(error); }
        },
        cancel(reason) { open--; return reader.cancel(reason); },
      });
      return new Response(counted, { status: response.status, headers: response.headers });
    },
    cover: async id => ({ bytes: new Uint8Array([id.length, 1, 2]), contentType: 'image/png' }),
    limitBytes: () => 64 * MB, freeBytes: async () => 100 * 1024 * MB,
    away: () => away, unreachable, inQueue: () => queue, changed: () => {},
    headerTimeoutMs: 2000, idleTimeoutMs: 2000,
    ...options,
  });
  const learn = (...tracks: Track[]) => tracks.forEach(track => known.set(track.id, track));
  const request = (kind: KeepKind, id: string, trackIds: string[], coverArt: string | null = 'al-1') => ({ kind, id, name: `Kept ${id}`, artist: null, coverArt, trackIds });
  const release = async (id: string) => { await vi.waitFor(() => expect(gates.has(id)).toBe(true)); gates.get(id)!(); gates.delete(id); };
  return { store, manager, learn, request, release, opened, gates, unreachable, queue, most: () => most, setAway: (value: boolean) => { away = value; }, dir };
}
const job = (manager: KeepManager, id: string) => manager.state(null).jobs.find(j => j.id === id);

describe('keeping songs on the desktop', () => {
  it('refuses a keep it can\'t take, each with its own plain message', async () => {
    const t = await setup({ limitBytes: () => 100 * MB });
    t.learn(song('a', { size: 60 * MB }), song('b', { size: 60 * MB }));
    expect(await t.manager.keep(t.request('album', 'al-1', ['a', 'b']))).toEqual({ ok: false, error: limitMessage(2, 120 * MB + 150 * 1024, 100 * MB, 100) });
    expect(limitMessage(84, 1.2 * 1024 * MB, 600 * MB, 4096)).toBe('Keeping these 84 songs needs about 1.2 GB, and 600 MB of the 4,096 MB limit is free. Raise the limit in Settings, or forget something kept first.');
    expect(await t.manager.keep(t.request('album', 'al-1', ['a', 'missing']))).toEqual({ ok: false, error: KEPT_MESSAGES.notLoaded });
    t.setAway(true);
    expect(await t.manager.keep(t.request('album', 'al-1', ['a']))).toEqual({ ok: false, error: KEPT_MESSAGES.away });
    t.setAway(false);
    vi.spyOn(t.store, 'songCount', 'get').mockReturnValue(19_999);
    expect(await t.manager.keep(t.request('album', 'al-1', ['a', 'b']))).toEqual({ ok: false, error: KEPT_MESSAGES.tooMany });
    vi.restoreAllMocks();
    t.store.indexBytes = 24 * MB;
    expect(await t.manager.keep(t.request('album', 'al-1', ['a']))).toEqual({ ok: false, error: KEPT_MESSAGES.indexFull });
    expect(t.opened).toEqual([]);
    expect(t.store.containers()).toEqual([]);
  });
  it('refuses a new record past 2,000 kept, and still keeps one already kept again', async () => {
    const t = await setup();
    t.learn(song('a'), song('b'));
    await t.manager.keep(t.request('album', 'al-1', ['a'], null));
    await t.manager.idle();
    vi.spyOn(t.store, 'containerCount', 'get').mockReturnValue(2_000);
    expect(await t.manager.keep(t.request('playlist', 'pl-1', ['a'], null))).toEqual({ ok: false, error: KEPT_MESSAGES.tooManyContainers });
    expect(t.store.record('playlist', 'pl-1')).toBeUndefined();
    expect(await t.manager.keep(t.request('album', 'al-1', ['a', 'b'], null))).toEqual({ ok: true, value: undefined });
    await t.manager.idle();
    vi.restoreAllMocks();
    expect(t.store.containers()).toMatchObject([{ kind: 'album', id: 'al-1', present: 2, total: 2 }]);
  });
  it('refuses when the disk would be left with less than 256 MB', async () => {
    const t = await setup({ freeBytes: async () => 300 * MB });
    t.learn(song('a', { size: 60 * MB }));
    expect(await t.manager.keep(t.request('album', 'al-1', ['a']))).toEqual({ ok: false, error: KEPT_MESSAGES.noDisk('computer') });
  });
  it('fetches two at a time, reports progress, and keeps the files and their covers', async () => {
    const t = await setup({ gated: true });
    const ids = ['a', 'b', 'c', 'd', 'e'];
    t.learn(...ids.map(id => song(id)));
    expect(await t.manager.keep(t.request('album', 'al-1', ids))).toEqual({ ok: true, value: undefined });
    expect(job(t.manager, 'al-1')).toMatchObject({ done: 0, total: 5, state: 'keeping' });
    await t.release('a'); await t.release('b');
    await vi.waitFor(() => expect(job(t.manager, 'al-1')?.done).toBe(2));
    for (const id of ['c', 'd', 'e']) await t.release(id);
    await t.manager.idle();
    expect(t.most()).toBeLessThanOrEqual(2);
    expect(job(t.manager, 'al-1')).toBeUndefined();
    expect(t.store.presentIds().sort()).toEqual(ids);
    expect(t.store.containers()[0]).toMatchObject({ present: 5, total: 5 });
    expect(t.store.hasCover('al-1')).toBe(true);
    // Stars and ratings are the server's; the kept track leaves them out.
    expect(t.store.track('a')).not.toHaveProperty('starred');
    expect(t.store.track('a')).not.toHaveProperty('userRating');
    expect((await readdir(t.dir)).filter(name => name.endsWith('.part'))).toEqual([]);
  });
  it('refuses a song bigger than the room left, and stops when the bytes pass it', async () => {
    const declared = await setup({ limitBytes: () => 50, respond: () => new Response(new Uint8Array(80), { headers: { 'content-type': 'audio/flac', 'content-length': '80' } }) });
    declared.learn(song('a', { coverArt: null }));
    await declared.manager.keep(declared.request('album', 'al-1', ['a'], null));
    await declared.manager.idle();
    expect(job(declared.manager, 'al-1')).toMatchObject({ state: 'stopped', error: KEPT_MESSAGES.limitReached(0, 0, 1) });
    const t = await setup({ limitBytes: () => 50, respond: () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(40)); c.enqueue(new Uint8Array(40)); c.close(); } }), { headers: { 'content-type': 'audio/flac' } }) });
    t.learn(song('a', { coverArt: null }));
    await t.manager.keep(t.request('album', 'al-1', ['a'], null));
    await t.manager.idle();
    expect(job(t.manager, 'al-1')?.state).toBe('stopped');
    expect(t.store.has('a')).toBe(false);
    expect((await readdir(t.dir)).filter(name => name.startsWith('s-'))).toEqual([]);
  });
  it('counts two downloads at once against the same room, so together they can\'t pass the limit', async () => {
    // No size from the server and no content-length: admission can't see the bytes coming, and
    // both headers arrive before either body sends anything.
    let opened = 0;
    let both!: () => void;
    const bothOpen = new Promise<void>(resolve => { both = resolve; });
    const t = await setup({ limitBytes: () => 1000, respond: () => {
      if (++opened === 2) both();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) { await bothOpen; controller.enqueue(new Uint8Array(700)); controller.close(); },
      }), { headers: { 'content-type': 'audio/flac' } });
    } });
    t.learn(song('a', { coverArt: null }), song('b', { coverArt: null }));
    expect(await t.manager.keep(t.request('album', 'al-1', ['a'], null))).toEqual({ ok: true, value: undefined });
    expect(await t.manager.keep(t.request('album', 'al-2', ['b'], null))).toEqual({ ok: true, value: undefined });
    await t.manager.idle();
    expect(t.store.usedBytes).toBeLessThanOrEqual(1000);
    expect(t.store.songCount).toBe(1);
    const stopped = t.manager.state(null).jobs.filter(j => j.state === 'stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0].error).toMatch(/limit after 0 of 1 songs/);
    expect((await readdir(t.dir)).filter(name => name.startsWith('s-')).length).toBe(1);
  });
  it('cancels: the song on its way is dropped with its part, finished songs stay', async () => {
    const t = await setup({ gated: true, concurrency: 1 });
    t.learn(song('a'), song('b'), song('c'));
    await t.manager.keep(t.request('album', 'al-1', ['a', 'b', 'c']));
    await t.release('a');
    await vi.waitFor(() => expect(t.gates.has('b')).toBe(true));
    expect(t.manager.cancel('album', 'al-1')).toEqual({ ok: true, value: undefined });
    await t.manager.idle();
    expect(t.store.presentIds()).toEqual(['a']);
    expect(job(t.manager, 'al-1')).toBeUndefined();
    expect(t.store.containers()[0]).toMatchObject({ present: 1, total: 3 });
    expect((await readdir(t.dir)).filter(name => name.endsWith('.part'))).toEqual([]);
  });
  it('refuses an error sent as a 200, and a song that arrives short, trying each once more', async () => {
    const t = await setup({ respond: id => id === 'json' ? Response.json({ 'subsonic-response': { status: 'failed' } })
      : new Response(new Uint8Array(10), { headers: { 'content-type': 'audio/flac', 'content-length': '20' } }) });
    t.learn(song('json'), song('short'));
    await t.manager.keep(t.request('album', 'al-1', ['json', 'short'], null));
    await t.manager.idle();
    expect(t.opened.sort()).toEqual(['json', 'json', 'short', 'short']);
    expect(job(t.manager, 'al-1')).toMatchObject({ state: 'stopped', failed: 2, error: '2 songs couldn\'t be kept.' });
    expect(t.store.songCount).toBe(0);
    expect((await readdir(t.dir)).filter(name => name.startsWith('s-'))).toEqual([]);
  });
  it('pauses when the server stops answering, and carries on when it is back', async () => {
    let down = false;
    const t = await setup({ concurrency: 1, respond: id => {
      if (down) throw new Unreachable('Server request failed. Check the address, connection, and Navidrome/OpenSubsonic compatibility.');
      if (id === 'b') down = true;
      const bytes = bytesOf(id);
      return new Response(bytes, { headers: { 'content-type': 'audio/flac', 'content-length': String(bytes.length) } });
    } });
    t.learn(song('a'), song('b'), song('c'), song('d'));
    await t.manager.keep(t.request('album', 'al-1', ['a', 'b', 'c', 'd'], null));
    await t.manager.idle();
    expect(job(t.manager, 'al-1')).toMatchObject({ state: 'paused', done: 2, error: null });
    expect(t.unreachable).toHaveBeenCalled();
    expect(t.store.presentIds().sort()).toEqual(['a', 'b']);
    down = false;
    t.manager.resumePaused();
    await t.manager.idle();
    expect(job(t.manager, 'al-1')).toBeUndefined();
    expect(t.store.presentIds().sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('pauses and asks about the server when a song times out or its body drops, and carries on when it is back', async () => {
    const whole = (id: string) => { const bytes = bytesOf(id); return new Response(bytes, { headers: { 'content-type': 'audio/flac', 'content-length': String(bytes.length) } }); };
    const failures: Record<string, (id: string) => Response> = {
      // Headers and one chunk, then nothing.
      stalls: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(4)); },
        pull: () => new Promise<void>(() => {}),
      }), { headers: { 'content-type': 'audio/flac' } }),
      // Headers and one chunk, then the connection drops.
      drops: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(4)); },
        pull(controller) { controller.error(new TypeError('terminated')); },
      }), { headers: { 'content-type': 'audio/flac' } }),
    };
    for (const name of ['headers', 'stalls', 'drops']) {
      let down = true;
      // Connected, but no headers: the connector's fetch settles only when aborted, and then says
      // "Keeping was stopped." as SubsonicClient.original does.
      const silent = name === 'headers' ? { open: (id: string, signal: AbortSignal) => down
        ? new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(new ServerError('Keeping was stopped.')), { once: true }))
        : Promise.resolve(whole(id)) } : {};
      const t = await setup({ concurrency: 1, headerTimeoutMs: 50, idleTimeoutMs: 50, respond: id => down ? failures[name](id) : whole(id), ...silent });
      t.learn(song('a', { coverArt: null }), song('b', { coverArt: null }));
      await t.manager.keep(t.request('album', 'al-1', ['a', 'b'], null));
      await t.manager.idle();
      expect(job(t.manager, 'al-1'), name).toMatchObject({ state: 'paused', done: 0, failed: 0, error: null });
      expect(t.unreachable, name).toHaveBeenCalledOnce();
      expect((await readdir(t.dir)).filter(file => file.endsWith('.part')), name).toEqual([]);
      down = false;
      t.manager.resumePaused();
      await t.manager.idle();
      expect(job(t.manager, 'al-1'), name).toBeUndefined();
      expect(t.store.presentIds().sort(), name).toEqual(['a', 'b']);
      await rm(t.dir, { recursive: true, force: true });
    }
  });
  it('keeps again without fetching what is already kept', async () => {
    const t = await setup();
    t.learn(song('a'), song('b'));
    await t.manager.keep(t.request('playlist', 'pl-1', ['a'], null));
    await t.manager.idle();
    await t.manager.keep(t.request('playlist', 'pl-1', ['a', 'b'], null));
    await t.manager.idle();
    expect(t.opened).toEqual(['a', 'b']);
    expect(t.store.containers()[0]).toMatchObject({ present: 2, total: 2 });
  });
  it('replaces a mix\'s draw and forgets only songs nothing else lists', async () => {
    const t = await setup();
    t.learn(...['a', 'b', 'c', 'd'].map(id => song(id)));
    await t.manager.keep(t.request('album', 'al-1', ['a'], null));
    await t.manager.keep(t.request('mix', 'everything', ['a', 'b', 'c'], null));
    await t.manager.idle();
    const fileOf = (id: string) => join(t.dir, t.store.song(id)!.file);
    const c = fileOf('c');
    await t.manager.keep(t.request('mix', 'everything', ['b', 'd'], null));
    await t.manager.idle();
    expect(t.store.presentIds().sort()).toEqual(['a', 'b', 'd']);
    expect(existsSync(c)).toBe(false);
    expect(t.store.containers().map(k => `${k.kind}:${k.id}:${k.total}`).sort()).toEqual(['album:al-1:1', 'mix:everything:2']);
  });
  it('waits to delete a forgotten song while it is queued, and takes it back without a download', async () => {
    const t = await setup();
    t.learn(song('a'), song('b'));
    await t.manager.keep(t.request('album', 'al-1', ['a', 'b'], null));
    await t.manager.idle();
    const a = join(t.dir, t.store.song('a')!.file), b = join(t.dir, t.store.song('b')!.file);
    t.queue.add('a');
    await t.manager.forget('album', 'al-1');
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(false);
    expect(t.manager.pendingDeletes).toBe(1);
    await t.manager.keep(t.request('album', 'al-1', ['a'], null));
    await t.manager.idle();
    expect(t.opened).toEqual(['a', 'b']);
    expect(t.store.has('a')).toBe(true);
    await t.manager.forget('album', 'al-1');
    t.queue.clear();
    await t.manager.retryPending();
    expect(existsSync(a)).toBe(false);
    expect(t.manager.pendingDeletes).toBe(0);
  });
  it('forgets everything and leaves unrelated files', async () => {
    const t = await setup();
    t.learn(song('a'));
    await t.manager.keep(t.request('album', 'al-1', ['a']));
    await t.manager.idle();
    await t.manager.forgetAll();
    expect(t.store.songCount).toBe(0);
    expect(t.store.usedBytes).toBe(0);
    expect((await readdir(t.dir)).sort()).toEqual(['index.json']);
  });
});

describe('what the audio host loads', () => {
  const stream = () => 'https://music.example.com/rest/stream.view?id=a&t=token';
  it('loads a kept file for a server song, and the stream otherwise', () => {
    expect(pickLocation(song('a'), () => '/kept/s-a.flac', stream)).toEqual({ track: song('a'), location: '/kept/s-a.flac', kept: true });
    expect(pickLocation(song('a'), () => null, stream)).toEqual({ track: song('a'), location: stream() });
    const station = { ...song('st'), source: 'station' as const };
    expect(pickLocation(station, () => '/kept/x', () => 'https://radio')).toEqual({ track: station, location: 'https://radio' });
  });
  it('plays only kept songs while away, from the chosen one or the next kept after it', () => {
    const tracks = ['a', 'b', 'c', 'd'].map(id => song(id));
    const kept = new Set(['a', 'c']);
    expect(choosePlayable(tracks, 1, id => kept.has(id), false)).toEqual({ items: tracks, start: 1 });
    expect(choosePlayable(tracks, 1, id => kept.has(id), true)).toEqual({ items: [tracks[0], tracks[2]], start: 1 });
    expect(choosePlayable(tracks, 3, id => kept.has(id), true)).toEqual({ items: [tracks[0], tracks[2]], start: 1 });
    expect(choosePlayable(tracks, 0, () => false, true)).toBeNull();
    const local = { ...song('l'), source: 'local' as const };
    expect(choosePlayable([local], 0, () => false, true)).toEqual({ items: [local], start: 0 });
  });
});
