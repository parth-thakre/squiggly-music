import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeptDetail, KeptState } from '../packages/core/contracts';
import { formatBytes, isAudioHead, keepStatus, keptOnly, limitMessage, MB, suffixFor } from '../packages/core/kept';
import { OUT_OF_REACH, PROBE_EVERY, PROBE_TIMEOUT } from '../packages/core/reach';
import { pageFor } from '../apps/desktop/renderer/src/app/offline';
import { createWebLibrary } from '../apps/desktop/renderer/src/bridge/previewLibrary';

afterEach(() => { vi.useRealTimers(); });

describe('what a page shows while the server is away', () => {
  it('shows every page as always while the server answers', () => {
    for (const view of ['home', 'records', 'kept', 'settings'] as const) expect(pageFor({ view } as never, false, true)).toBe('page');
  });
  it('turns Home into Kept, server pages into the notice, and leaves the rest', () => {
    expect(pageFor({ view: 'home' }, true, true)).toBe('kept');
    expect(pageFor({ view: 'kept' }, true, true)).toBe('kept');
    expect(pageFor({ view: 'artists' }, true, true)).toBe('notice');
    expect(pageFor({ view: 'album', id: 'al-1' }, true, true)).toBe('notice');
    expect(pageFor({ view: 'search', query: 'x' }, true, true)).toBe('notice');
    for (const view of ['queue', 'settings', 'lyrics', 'diagnostics'] as const) expect(pageFor({ view }, true, true)).toBe('page');
  });
  it('shows the notice on Home where nothing can be kept', () => {
    expect(pageFor({ view: 'home' }, true, false)).toBe('notice');
    expect(pageFor({ view: 'kept' }, true, false)).toBe('kept');
  });
});

describe('kept songs only', () => {
  const kept = new Set(['b', 'd']);
  const isKept = (id: string) => kept.has(id);
  it('keeps the order and starts at the chosen song, or the next kept one, or the last before it', () => {
    expect(keptOnly(['a', 'b', 'c', 'd'], 1, isKept)).toEqual({ items: ['b', 'd'], start: 0 });
    expect(keptOnly(['a', 'b', 'c', 'd'], 2, isKept)).toEqual({ items: ['b', 'd'], start: 1 });
    expect(keptOnly(['a', 'b', 'c', 'd', 'e'], 4, isKept)).toEqual({ items: ['b', 'd'], start: 1 });
    expect(keptOnly(['a', 'c'], 0, isKept)).toBeNull();
  });
});

describe('what a kept song is named and must start with', () => {
  const head = (...parts: (string | number[])[]) => new Uint8Array(parts.flatMap(part => typeof part === 'string' ? [...part].map(char => char.charCodeAt(0)) : part));
  it('takes the server\'s suffix only when it is an audio one', () => {
    expect(suffixFor('FLAC', null)).toBe('flac');
    expect(suffixFor('wma', null)).toBe('wma');
    for (const suffix of ['m3u', 'm3u8', 'pls', 'edl', 'cue', 'txt', 'xspf', 'srt']) {
      expect(suffixFor(suffix, 'audio/mpeg')).toBe('mp3');
      expect(suffixFor(suffix, 'audio/x-mpegurl')).toBe('audio');
    }
  });
  it('knows the audio files a server keeps', () => {
    const heads = [
      head('fLaC'), head('ID3', [4, 0]), head([0xff, 0xfb, 0x90]), head([0xff, 0xf1, 0x50]), head('OggS'),
      head('RIFF', [0, 0, 0, 0], 'WAVE'), head('FORM', [0, 0, 0, 0], 'AIFF'), head('FORM', [0, 0, 0, 0], 'AIFC'),
      head([0, 0, 0, 0x20], 'ftypM4A '), head('MAC '), head('wvpk'), head('DSD '), head('FRM8'),
      head([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]), head([0x1a, 0x45, 0xdf, 0xa3]),
    ];
    for (const bytes of heads) expect(isAudioHead(bytes)).toBe(true);
  });
  it('refuses playlists, EDL, cue sheets, and other text', () => {
    const texts = ['#EXTM3U\n', '/etc/passwd\n', '[playlist]\nFile1=/x', '# mpv EDL v0\n', 'FILE "a.flac" WAVE', '<?xml', '{"a":1}', 'RIFF1234AVI ', ''];
    for (const text of texts) expect(isAudioHead(head(text))).toBe(false);
    // UTF-16 text starts FF FE, which only an MPEG Layer I frame shares.
    expect(isAudioHead(head([0xff, 0xfe], '#\0E\0'))).toBe(false);
  });
});

describe('the Keep control', () => {
  const state = (patch: Partial<KeptState> = {}): KeptState => ({ revision: 1, songs: 3, usedBytes: 0, limitBytes: 4096 * MB, containers: [], jobs: [], dir: null, notice: null, ...patch });
  const container = { kind: 'playlist' as const, id: 'pl', name: 'Road', artist: null, coverArt: null, total: 3, present: 3, bytes: 30, keptAt: 1 };
  const detail: KeptDetail = { container, trackIds: ['a', 'b', 'c'], tracks: [] };
  it('says none, keeping, paused, stopped, kept, incomplete, and stale', () => {
    expect(keepStatus(state(), null, 'playlist', 'pl').status).toBe('none');
    const job = { kind: 'playlist' as const, id: 'pl', name: 'Road', done: 1, total: 3, failed: 0, state: 'keeping' as const, error: null };
    expect(keepStatus(state({ jobs: [job] }), null, 'playlist', 'pl')).toMatchObject({ status: 'keeping', done: 1, total: 3 });
    expect(keepStatus(state({ jobs: [{ ...job, state: 'paused' }] }), null, 'playlist', 'pl').status).toBe('paused');
    expect(keepStatus(state({ jobs: [{ ...job, state: 'stopped', error: 'One song couldn\'t be kept.' }] }), null, 'playlist', 'pl'))
      .toMatchObject({ status: 'stopped', error: 'One song couldn\'t be kept.' });
    expect(keepStatus(state({ containers: [container] }), detail, 'playlist', 'pl', ['a', 'b', 'c']).status).toBe('kept');
    expect(keepStatus(state({ containers: [{ ...container, present: 2 }] }), detail, 'playlist', 'pl').status).toBe('incomplete');
    expect(keepStatus(state({ containers: [container] }), detail, 'playlist', 'pl', ['a', 'c']).status).toBe('stale');
  });
  it('writes sizes and the limit plainly', () => {
    expect(formatBytes(600 * MB)).toBe('600 MB');
    expect(formatBytes(1.24 * 1024 * MB)).toBe('1.2 GB');
    expect(formatBytes(4096 * MB)).toBe('4.0 GB');
    expect(formatBytes(0)).toBe('0 MB');
    expect(limitMessage(1, 50 * MB, 10 * MB, 64)).toBe('Keeping this song needs about 50 MB, and 10 MB of the 64 MB limit is free. Raise the limit in Settings, or forget something kept first.');
  });
});

describe('the browser build\'s library calls', () => {
  function host(answers: (path: string) => { status: number; body: unknown } | 'down') {
    const calls: string[] = [];
    const fetcher = vi.fn(async (path: RequestInfo | URL) => {
      calls.push(String(path));
      const answer = answers(String(path));
      if (answer === 'down') throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
    });
    return { calls, ...createWebLibrary(fetcher as typeof fetch) };
  }
  it('asks once whether the server is there after a call gets no answer, and answers at once while away', async () => {
    vi.useFakeTimers();
    let up = false;
    const web = host(() => up ? { status: 200, body: { ok: true, value: [] } } : { status: 502, body: { ok: false, error: 'Server request failed.', unreachable: true } });
    const first = await web.call('artists', []);
    expect(first).toEqual({ ok: false, error: 'Server request failed.', unreachable: true });
    await vi.waitFor(() => expect(web.webReach.get().away).toBe(true));
    expect(web.calls).toEqual(['/api/artists', '/api/albums']);
    expect(await web.call('artists', [])).toEqual({ ok: false, error: OUT_OF_REACH, unreachable: true });
    expect(web.calls).toHaveLength(2);
    up = true;
    await vi.advanceTimersByTimeAsync(PROBE_EVERY);
    await vi.waitFor(() => expect(web.webReach.get().away).toBe(false));
    expect(await web.call('artists', [])).toEqual({ ok: true, value: [] });
  });
  it('stays online when a refused call fails, or the confirming probe is answered', async () => {
    let probe = { status: 200, body: { ok: true, value: [] } as unknown };
    const web = host(path => path === '/api/albums' ? probe : { status: 502, body: { ok: false, error: 'The server rejected the request.' } });
    await web.call('artists', []);
    expect(web.calls).toEqual(['/api/artists']);
    probe = { status: 200, body: { ok: true, value: [] } };
    const slow = host(path => path === '/api/albums' ? probe : { status: 502, body: { ok: false, error: 'x', unreachable: true } });
    await slow.call('artists', []);
    await vi.waitFor(() => expect(slow.calls).toEqual(['/api/artists', '/api/albums']));
    expect(slow.webReach.get().away).toBe(false);
  });
  it('gives up on a probe after 8 seconds, as no answer, and asks again later', async () => {
    vi.useFakeTimers();
    let hang = true;
    const signals: AbortSignal[] = [];
    const calls: string[] = [];
    const fetcher = vi.fn((path: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(path));
      if (String(path) === '/api/albums' && hang) { signals.push(init!.signal!); return new Promise<Response>(() => {}); }
      const body = String(path) === '/api/albums' ? { ok: true, value: [] } : { ok: false, error: 'x', unreachable: true };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const web = createWebLibrary(fetcher as typeof fetch);
    await web.call('artists', []);
    expect(web.webReach.get()).toMatchObject({ away: false, checking: true });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT - 1);
    expect(web.webReach.get()).toMatchObject({ away: false, checking: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(web.webReach.get()).toMatchObject({ away: true, checking: false });
    expect(signals[0].aborted).toBe(true);
    // The next probe, on the timer, is answered.
    hang = false;
    await vi.advanceTimersByTimeAsync(PROBE_EVERY);
    expect(web.webReach.get()).toMatchObject({ away: false, checking: false });
    expect(calls).toEqual(['/api/artists', '/api/albums', '/api/albums']);
    // Headers, then a body that never ends: the same 8 seconds.
    hang = false;
    fetcher.mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'x', unreachable: true }), { status: 200 })))
      .mockImplementationOnce(() => Promise.resolve(new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) }), { status: 200 })));
    await web.call('artists', []);
    expect(web.webReach.get()).toMatchObject({ away: false, checking: true });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT);
    expect(web.webReach.get()).toMatchObject({ away: true, checking: false });
  });
  it('lets a retry through while away', async () => {
    let up = false;
    const web = host(() => up ? { status: 200, body: { ok: true, value: [] } } : { status: 502, body: { ok: false, error: 'x', unreachable: true } });
    await web.call('artists', []);
    await vi.waitFor(() => expect(web.webReach.get().away).toBe(true));
    expect(await web.webReach.retry()).toEqual({ kind: 'unreachable' });
    up = true;
    expect(await web.webReach.retry()).toEqual({ kind: 'answered' });
    expect(web.webReach.get().away).toBe(false);
  });
});
