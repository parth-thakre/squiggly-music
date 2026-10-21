// Autoplay's fallback in the page (player.ts), which the browser and Android run, with the Android
// player faked: the server finds nothing similar, and each random-songs answer waits for the test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AndroidPlayback, AndroidSession, Result, Track } from '../packages/core/contracts';

const fake = vi.hoisted(() => ({ similarSongs: vi.fn(), randomSongs: vi.fn() }));
vi.mock('../apps/desktop/renderer/src/app/library', () => ({ api: fake, resetLibraryCaches: vi.fn() }));
vi.mock('../apps/desktop/renderer/src/app/settings', () => ({ getSettings: () => ({ autoplay: true, syncQueue: false, reportPlays: false }), subscribeSettings: vi.fn() }));
vi.mock('../apps/desktop/renderer/src/app/searches', () => ({ searchesFor: vi.fn(), clearSearches: vi.fn() }));
vi.mock('../apps/desktop/renderer/src/app/keptState', () => ({ keptSupported: false, isKept: () => false }));
vi.mock('../apps/desktop/renderer/src/bridge/previewLibrary', () => ({ onDisconnected: vi.fn(), onSignedOut: vi.fn(), webReach: {}, webSession: {} }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
const song = (id: string, genre?: string): Track => ({ id, title: id, artist: 'artist', album: 'album', duration: 200,
  source: 'navidrome', sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null, ...(genre ? { genre } : {}) });

async function fixture(tracks = [song('old', 'Folk')]) {
  vi.useFakeTimers();
  let report!: (value: AndroidPlayback) => void;
  const answers: ((value: Result<Track[]>) => void)[] = [];
  fake.similarSongs.mockReset().mockResolvedValue({ ok: true, value: [] });
  fake.randomSongs.mockReset().mockImplementation(() => new Promise(done => { answers.push(done); }));
  const session: AndroidSession = { ready: true, connected: true, serverName: 'test', sessionId: 's1', account: 'test',
    signIn: { saved: null, canRemember: false, reconnecting: false, reconnectError: null } };
  const load = vi.fn(), sync = vi.fn();
  vi.stubGlobal('window', { squigglyAndroid: {
    session: { get: () => session, subscribe: vi.fn() },
    player: { subscribe: (listener: typeof report) => { report = listener; }, onReset: vi.fn(),
      restore: async () => ({ queue: [], entryIds: [], index: -1, playback: { entryId: null, playId: 0, playing: false, buffering: false,
        ended: false, position: 0, duration: 0, fallback: false, error: null, pressed: 0 } }),
      sync, load, repeat: vi.fn(), pause: vi.fn(), play: vi.fn(), seek: vi.fn() },
  } });
  vi.stubGlobal('document', { addEventListener: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  const { player, getPlayer } = await import('../apps/desktop/renderer/src/app/player');
  await player.play(tracks, tracks.length - 1);
  const playback: AndroidPlayback = { entryId: getPlayer().entryIds.at(-1)!, playId: 1, playing: true, buffering: false, ended: false,
    position: 42, duration: 200, fallback: false, error: null, pressed: 0 };
  report(playback);
  await vi.waitFor(() => expect(answers).toHaveLength(1));
  return { player, getPlayer, load, sync, report, playback, answers };
}

describe('autoplay\'s fallback in the page', () => {
  it('tries again a minute on when its random songs were all queued, and adds what it finds then', async () => {
    const f = await fixture();
    expect(fake.randomSongs.mock.calls[0]).toEqual([{ size: 30, genre: 'Folk' }]);
    f.answers[0]({ ok: true, value: [song('old')] });
    await vi.advanceTimersByTimeAsync(0);
    f.answers[1]({ ok: true, value: [song('old')] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getPlayer().autoplay.missed).toBeNull();
    // Nothing asked meanwhile, however often the player reports.
    for (let i = 0; i < 20; i++) f.report({ ...f.playback, position: 43 + i });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.randomSongs).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.randomSongs).toHaveBeenCalledTimes(3);
    f.answers[2]({ ok: true, value: [song('old'), song('new')] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getPlayer().queue.map(t => t.id)).toEqual(['old', 'new']);
  });

  it('ends the queue only when the server gives no songs at all', async () => {
    const f = await fixture();
    f.answers[0]({ ok: true, value: [] });
    await vi.advanceTimersByTimeAsync(0);
    f.answers[1]({ ok: true, value: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.getPlayer().autoplay.missed).toBe(f.getPlayer().entryIds[0]);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fake.randomSongs).toHaveBeenCalledTimes(2);
  });
});
