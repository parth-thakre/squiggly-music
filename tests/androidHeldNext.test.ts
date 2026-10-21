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

// The page's player on Android, its native player faked: what the native player reports while
// autoplay asks, with Next held on the last song.
async function fixture({ initialReport = true, twoSongs = false } = {}) {
  vi.useFakeTimers();
  let report!: (value: AndroidPlayback) => void;
  let answer!: (value: Result<Track[]>) => void;
  fake.similarSongs.mockReset().mockImplementation(() => new Promise(done => { answer = done; }));
  const session: AndroidSession = { ready: true, connected: true, serverName: 'test', sessionId: 's1', account: 'test',
    signIn: { saved: null, canRemember: false, reconnecting: false, reconnectError: null } };
  const load = vi.fn();
  vi.stubGlobal('window', { squigglyAndroid: {
    session: { get: () => session, subscribe: vi.fn() },
    player: { subscribe: (listener: typeof report) => { report = listener; }, onReset: vi.fn(), // Nothing held from before: an empty queue, and no presses yet.
      restore: async () => ({ queue: [], entryIds: [], index: -1, playback: { entryId: null, playId: 0, playing: false, buffering: false, ended: false,
        position: 0, duration: 0, fallback: false, error: null, pressed: 0 } }),
      sync: vi.fn(), load, repeat: vi.fn(), pause: vi.fn(), play: vi.fn(), seek: vi.fn() },
  } });
  vi.stubGlobal('document', { addEventListener: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  const { player, getPlayer } = await import('../apps/desktop/renderer/src/app/player');
  await player.play(twoSongs ? [song('old'), song('tail')] : [song('old')], 0);
  const entryId = getPlayer().entryIds[0];
  const playback: AndroidPlayback = { entryId, playId: 1, playing: true, buffering: false, ended: false,
    position: 42, duration: 200, fallback: false, error: null, pressed: 0 };
  if (initialReport) report(playback);
  return { player, getPlayer, load, report, playback,
    answer: () => answer({ ok: true, value: Array.from({ length: 10 }, (_, i) => song(`new-${i}`)) }),
  };
}

async function appended(f: Awaited<ReturnType<typeof fixture>>, count = 11) {
  f.answer();
  await vi.waitFor(() => expect(f.getPlayer().queue).toHaveLength(count));
}

describe('a Next held in the page on Android', () => {
  it('moves on once the songs are in, through buffering and the reports between', async () => {
    const f = await fixture();
    f.player.next();
    f.report({ ...f.playback, buffering: true, position: 42.5 });
    f.report({ ...f.playback, position: 75 });
    await appended(f);
    expect(f.getPlayer().index).toBe(1);
    expect(f.load).toHaveBeenCalledTimes(2);
  });

  it('survives the native player starting the page\'s own load', async () => {
    // Pressed before the first report of the song the page loaded.
    let f = await fixture({ initialReport: false });
    f.player.next();
    f.report({ ...f.playback, position: 0, buffering: true });
    f.report({ ...f.playback, position: 0.2 });
    await appended(f);
    expect(f.getPlayer().index).toBe(1);
    vi.clearAllTimers(); vi.unstubAllGlobals(); vi.resetModules();
    // Next twice from the song before the last: the second waits while the first loads.
    f = await fixture({ twoSongs: true });
    f.player.next();
    const tail = f.getPlayer().entryIds[1];
    f.player.next();
    f.report({ ...f.playback, entryId: tail, playId: 2, position: 0, buffering: true });
    f.report({ ...f.playback, entryId: tail, playId: 2, position: 0.2 });
    await appended(f, 12);
    expect(f.getPlayer().index).toBe(2);
    expect(f.load).toHaveBeenCalledTimes(3);
  });

  it('is let go by a pause from the notification or headphones', async () => {
    const f = await fixture();
    f.player.next();
    f.report({ ...f.playback, playing: false });
    await appended(f);
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.getPlayer().index).toBe(0);
  });

  it('is let go by a press carried by the first report of the page\'s own load', async () => {
    const f = await fixture({ initialReport: false });
    f.player.next();
    f.report({ ...f.playback, position: 100, pressed: 1 });
    await appended(f);
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.getPlayer().index).toBe(0);
  });

  for (const [press, position] of [['a seek forward', 100], ['Previous, early in the song', 0]] as const) {
    it(`is let go by ${press} from the notification`, async () => {
      const f = await fixture();
      f.report({ ...f.playback, position: 0.7 });
      f.player.next();
      f.report({ ...f.playback, position, pressed: 1 });
      await appended(f);
      expect(f.load).toHaveBeenCalledTimes(1);
      expect(f.getPlayer().index).toBe(0);
    });
  }
});
