import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test } from '../fixtures/test';

// The desktop's system media session on Windows and macOS (systemMedia.ts), through a stand-in
// for the preload bridge: window.pushMedia plays the main process, and bridgeCalls records what
// the page sent back. The operating system's side is Chromium's own.
type Media = { title: string; artist: string; album: string } | null;
const song = {
  index: 2, entryId: 'e.3', trackId: 't-3', title: 'Harvest Moon', artist: 'Neil Young', album: 'Harvest Moon',
  coverArt: null, duration: 300, position: 42, playing: true,
};

test.beforeEach(async ({ page }) => {
  // Keeps the session's action handlers where the test can press them, as the OS would.
  await page.addInitScript(() => {
    const handlers: Record<string, (details: MediaSessionActionDetails) => void> = {};
    const set = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => { if (handler) handlers[action] = handler; set(action, handler); };
    Object.assign(window, { press: (action: string, details = {}) => handlers[action]({ action, ...details } as MediaSessionActionDetails) });
  });
  await installDesktopBridge(page, { mediaHost: true });
});

const calls = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls);
const session = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const metadata = navigator.mediaSession.metadata as Media;
  return { state: navigator.mediaSession.playbackState, title: metadata?.title ?? null, artist: metadata?.artist ?? null, album: metadata?.album ?? null };
});
const push = (page: import('@playwright/test').Page, state: unknown) => page.evaluate(value => (window as unknown as { pushMedia(s: unknown): void }).pushMedia(value), state);
const press = (page: import('@playwright/test').Page, action: string, details: object = {}) =>
  page.evaluate(([name, extra]) => (window as unknown as { press(a: string, d: object): void }).press(name as string, extra as object), [action, details] as const);

test('the playing song becomes the media session, and its buttons drive the player', async ({ page }) => {
  await page.goto('/');
  await push(page, song);
  await expect.poll(() => session(page)).toEqual({ state: 'playing', title: 'Harvest Moon', artist: 'Neil Young', album: 'Harvest Moon' });
  // The session is live once the silent clip plays; the main process then lets go of the keys.
  await expect.poll(() => calls(page)).toContain('media-live:true');

  await press(page, 'pause');
  await press(page, 'nexttrack');
  await press(page, 'previoustrack');
  await press(page, 'seekto', { seekTime: 90 });
  await press(page, 'seekto', { seekTime: 900 });
  expect((await calls(page)).filter(call => call.startsWith('command:'))).toEqual([
    'command:{"type":"pause"}', 'command:{"type":"next"}', 'command:{"type":"previous"}',
    'command:{"type":"seek","seconds":90,"queueIndex":2,"trackId":"t-3","entryId":"e.3"}',
    // Past the end is held to the song's length.
    'command:{"type":"seek","seconds":300,"queueIndex":2,"trackId":"t-3","entryId":"e.3"}',
  ]);

  await push(page, { ...song, playing: false });
  await expect.poll(() => session(page)).toMatchObject({ state: 'paused', title: 'Harvest Moon' });
  await press(page, 'play');
  expect(await calls(page)).toContain('command:{"type":"play"}');
});

test('the session ends with nothing to show, and the keys go back to the main process', async ({ page }) => {
  await page.goto('/');
  await push(page, song);
  await expect.poll(() => calls(page)).toContain('media-live:true');
  // Also what the main process sends when exclusive output is switched on.
  await push(page, null);
  await expect.poll(() => session(page)).toEqual({ state: 'none', title: null, artist: null, album: null });
  expect(await calls(page)).toContain('media-live:false');
});

test('a window that does not host the session leaves it alone', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { squiggly: { media: { hosted: boolean } } }).squiggly.media.hosted = false; });
  await page.goto('/');
  expect(await page.evaluate(() => typeof (window as unknown as { pushMedia?: unknown }).pushMedia)).toBe('undefined');
  expect(await session(page)).toEqual({ state: 'none', title: null, artist: null, album: null });
});
