import { describe, expect, it, vi } from 'vitest';
import type { NativeItem, NativeOp } from '../apps/android/web/plugin';
import { stationTrack } from '../packages/core/stations';

// The Android bridge (apps/android/web/bridge.ts) with the real connector, a fake server behind
// its native fetch, and a fake native player that holds the queue it's sent.
const fake = vi.hoisted(() => {
  const stationLists: string[] = [];
  const held: { id: string; track: string }[] = [];
  const edits: { ops: NativeOp[]; seq: number }[] = [];
  const loads: { id: string; seq: number }[] = [];
  const order: string[] = [];
  const envelope = (payload: object) => new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...payload } }), { headers: { 'content-type': 'application/json' } });
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/getInternetRadioStations.view')) {
      stationLists.push(url.pathname);
      return envelope({ internetRadioStations: { internetRadioStation: [
        { id: '1', name: 'Night Signal', streamUrl: 'https://radio.example/night?listener=private' },
      ] } });
    }
    return envelope({});
  };
  let native: string[] = [];
  const plugin = {
    loadAccount: vi.fn(async () => ({ canRemember: true, account: { url: 'https://music.example', username: 'listener', password: 'secret' } })),
    saveAccount: vi.fn(async () => ({ saved: true })),
    forgetAccount: vi.fn(async () => undefined),
    setServer: vi.fn(async () => undefined),
    addListener: vi.fn(async () => ({ remove: async () => undefined })),
    restore: vi.fn(async () => ({ items: held, playback: {
      seq: 4, entryId: held[0]?.id ?? null, playId: 1, playing: false, buffering: false, ended: false, position: 0, duration: 0, fallback: false, error: null,
    } })),
    edit: vi.fn(async ({ ops, seq }: { ops: NativeOp[]; seq: number }) => {
      edits.push({ ops, seq }); order.push('edit');
      for (const op of ops) {
        const ids = (items: NativeItem[]) => items.map(item => item.id);
        if (op.type === 'replace') native = ids(op.items);
        else if (op.type === 'insert') native.splice(op.at, 0, ...ids(op.items));
        else if (op.type === 'remove') native.splice(op.from, op.count);
        else native.splice(op.to, 0, ...native.splice(op.from, 1));
      }
      return { ids: [...native] };
    }),
    load: vi.fn(async ({ id, seq }: { id: string; seq: number }) => { loads.push({ id, seq }); order.push(`load ${id}`); }),
    seek: vi.fn(async () => undefined), play: vi.fn(async () => undefined), pause: vi.fn(async () => undefined),
    // Keep on this device (Kept.kt): nothing kept, so a launch signs in as usual.
    keptState: vi.fn(async () => ({ account: null, revision: 0, songs: 0, usedBytes: 0, containers: [], jobs: [], notice: null })),
    keptPresent: vi.fn(async () => ({ ids: [] })),
    keptBind: vi.fn(async () => undefined), keptResume: vi.fn(async () => undefined),
  };
  return { stationLists, held, edits, loads, order, fetch, plugin, setNative: (ids: string[]) => { native = ids; } };
});
vi.mock('../apps/android/web/plugin', () => ({ Squiggly: fake.plugin }));
vi.mock('../apps/android/web/http', () => ({ nativeFetch: fake.fetch }));

describe('Android bridge', () => {
  it('replays a station restored after a relaunch with its stream, before the station list has been opened', async () => {
    // The player kept playing the station after the app was swiped away; the page is new.
    const night = stationTrack({ id: '1', name: 'Night Signal', homePageUrl: null });
    fake.held.push({ id: 'old', track: JSON.stringify(night) });
    fake.setNative(['old']);
    const { androidBridge: bridge } = await import('../apps/android/web/bridge');
    await expect.poll(() => bridge.session.get().connected).toBe(true);
    const restored = await bridge.player.restore();
    expect(restored?.queue).toEqual([night]);
    expect(fake.stationLists).toEqual([]);

    // Play: a new entry, so the native queue is replaced, and then that entry is loaded.
    bridge.player.sync([night], ['e1']);
    bridge.player.load('e1', { play: true, position: 0 });
    await expect.poll(() => fake.order).toEqual(['edit', 'load e1']);
    const [replace] = fake.edits[0].ops as Extract<NativeOp, { type: 'replace' }>[];
    expect(replace.items).toEqual([expect.objectContaining({
      id: 'e1', url: 'https://radio.example/night?listener=private', fallbackUrl: 'https://radio.example/night?listener=private', live: true,
    })]);
    // The load comes after the edit that holds its entry, and with a later number.
    expect(fake.loads[0].seq).toBeGreaterThan(fake.edits[0].seq);
    expect(fake.stationLists).toHaveLength(1);

    // Play next: now listed, it goes at once, without asking the server again.
    bridge.player.sync([night, night], ['e1', 'e2']);
    await expect.poll(() => fake.edits).toHaveLength(2);
    expect(fake.edits[1].ops).toEqual([{ type: 'insert', at: 1, items: [expect.objectContaining({ id: 'e2', url: 'https://radio.example/night?listener=private', live: true })] }]);
    expect(fake.stationLists).toHaveLength(1);

    // A station the server no longer lists is looked for once, then sent without an address,
    // so the player says it failed rather than the queue waiting on it.
    const gone = stationTrack({ id: '9', name: 'Gone FM', homePageUrl: null });
    bridge.player.sync([night, night, gone], ['e1', 'e2', 'e3']);
    await expect.poll(() => fake.edits).toHaveLength(3);
    expect(fake.edits[2].ops).toEqual([{ type: 'insert', at: 2, items: [expect.objectContaining({ id: 'e3', url: '', fallbackUrl: '', live: true })] }]);
    expect(fake.stationLists).toHaveLength(2);
  });
});
