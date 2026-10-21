import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AndroidPlayback, AndroidSession, Result, Track } from '../packages/core/contracts';

const fake = vi.hoisted(() => ({ similarSongs: vi.fn() }));
vi.mock('../apps/desktop/renderer/src/app/library', () => ({ api: fake, resetLibraryCaches: vi.fn() }));
vi.mock('../apps/desktop/renderer/src/app/settings', () => ({
  getSettings: () => ({ autoplay: true, syncQueue: false, reportPlays: false }), subscribeSettings: vi.fn(),
}));
vi.mock('../apps/desktop/renderer/src/app/searches', () => ({ searchesFor: vi.fn(), clearSearches: vi.fn() }));
vi.mock('../apps/desktop/renderer/src/app/keptState', () => ({ keptSupported: false, isKept: () => false }));
vi.mock('../apps/desktop/renderer/src/bridge/previewLibrary', () => ({
  onDisconnected: vi.fn(), onSignedOut: vi.fn(), webReach: {}, webSession: {},
}));

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });
const song = (id: string): Track => ({ id, title: id, artist: 'artist', album: 'album', duration: 200,
  source: 'navidrome', sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null });

// The page's player on Android, its native player faked: Next on the last song while autoplay
// asks, then what the native player reports before the answer comes.
async function fixture() {
  vi.useFakeTimers();
  let report!: (value: AndroidPlayback) => void;
  let answer!: (value: Result<Track[]>) => void;
  fake.similarSongs.mockReset().mockImplementation(() => new Promise(done => { answer = done; }));
  const session: AndroidSession = { ready: true, connected: true, serverName: 'test', sessionId: 's1', account: 'test',
    signIn: { saved: null, canRemember: false, reconnecting: false, reconnectError: null } };
  const load = vi.fn();
  vi.stubGlobal('window', { squigglyAndroid: {
    session: { get: () => session, subscribe: vi.fn() },
    player: { subscribe: (listener: typeof report) => { report = listener; }, onReset: vi.fn(), restore: async () => null,
      sync: vi.fn(), load, repeat: vi.fn(), pause: vi.fn(), play: vi.fn(), seek: vi.fn() },
  } });
  vi.stubGlobal('document', { addEventListener: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  const { player, getPlayer } = await import('../apps/desktop/renderer/src/app/player');
  await player.play([song('old')], 0);
  const entryId = getPlayer().entryIds[0];
  const playback: AndroidPlayback = { entryId, playId: 1, playing: true, buffering: false, ended: false,
    position: 42, duration: 200, fallback: false, error: null };
  report(playback);
  player.next();
  return { player, getPlayer, load, report, playback,
    answer: (songs = Array.from({ length: 10 }, (_, i) => song(`new-${i}`))) => answer({ ok: true, value: songs }),
    fail: () => answer({ ok: false, error: 'server failed' }),
  };
}

describe('a Next held in the page on Android', () => {
  it('moves on once the songs are in', async () => {
    const f = await fixture();
    f.answer();
    await vi.waitFor(() => expect(f.getPlayer().index).toBe(1));
    expect(f.load).toHaveBeenCalledTimes(2);
  });

  it('is let go by a pause from the notification or headphones', async () => {
    const f = await fixture();
    f.report({ ...f.playback, playing: false });
    f.answer();
    await vi.waitFor(() => expect(f.getPlayer().queue).toHaveLength(11));
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.getPlayer().index).toBe(0);
  });

  it('is let go when the notification\'s Previous starts the song over', async () => {
    const f = await fixture();
    f.report({ ...f.playback, position: 0 });
    f.answer();
    await vi.waitFor(() => expect(f.getPlayer().queue).toHaveLength(11));
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.getPlayer().index).toBe(0);
  });
});
