import type { Locator, Page } from '@playwright/test';
import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test, trackOf } from '../fixtures/test';

// A song asked to play that can't be heard yet: the stream or the output is still opening. The
// play button says it's starting rather than offering pause, and a press meanwhile changes nothing.

// Holds back every song the browser asks the server for, until release() is called.
async function holdStreams(page: Page) {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/stream?*', async route => { await held; await route.continue(); });
  return release;
}
async function expectStarting(button: Locator) {
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-disabled', 'true');
}

test.describe('starting, in the browser', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('the play button says a song is starting until it plays, and pressing it meanwhile never pauses', async ({ app, page }) => {
    const release = await holdStreams(page);
    await app.openAlbum('Test Pressing');
    await app.rowButton(app.row('Long Run')).click();
    await expect(app.deck.getByRole('heading', { level: 2 })).toHaveText('Long Run');
    const starting = app.deck.getByRole('button', { name: 'Starting', exact: true });
    await expectStarting(starting);
    await expect(app.deck.getByRole('button', { name: /^(Play|Pause)$/ })).toHaveCount(0);
    // The press someone makes in that silence, by pointer and by keyboard.
    await starting.click({ force: true });
    await starting.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');
    await expectStarting(starting);
    release();
    // Heard, and playing on: none of those presses paused it.
    await app.expectPlaying('Long Run');
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(1);
    // Still the same button, with focus where it was.
    await expect(app.deck.getByRole('button', { name: 'Pause', exact: true })).toBeFocused();
  });

  test('resuming the saved queue shows it starting, then plays from its position', async ({ app, page, fake }) => {
    fake.saved = { tracks: ['tr-1-4', 'tr-1-1'].map(id => ({ ...trackOf(id) })), currentIndex: 1, positionSeconds: 17, changed: null, changedBy: null };
    const release = await holdStreams(page);
    await page.reload();
    await app.deck.getByRole('button', { name: 'Resume' }).click();
    await expectStarting(app.deck.getByRole('button', { name: 'Starting', exact: true }));
    await app.deck.getByRole('button', { name: 'Starting', exact: true }).click({ force: true });
    release();
    await app.expectPlaying('Long Run');
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(18);
  });

  test('a pause request, unlike the button, still stops a song that is starting', async ({ app, page }) => {
    // Keeps the media session's handlers where the test can press them, as the OS would.
    await page.addInitScript(() => {
      const handlers: Record<string, () => void> = {};
      const set = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
      navigator.mediaSession.setActionHandler = (action, handler) => { if (handler) handlers[action] = handler as () => void; set(action, handler); };
      Object.assign(window, { press: (action: string) => handlers[action]() });
    });
    await page.reload();
    const release = await holdStreams(page);
    await app.openAlbum('Test Pressing');
    await app.rowButton(app.row('Long Run')).click();
    await expectStarting(app.deck.getByRole('button', { name: 'Starting', exact: true }));
    // A headset's or the lock screen's pause, as the sleep timer's does (player.pause).
    await page.evaluate(() => (window as unknown as { press(action: string): void }).press('pause'));
    const play = app.deck.getByRole('button', { name: 'Play', exact: true });
    await expect(play).toBeVisible();
    release();
    await page.waitForTimeout(1000);
    await expect(play).toBeVisible();
    expect(await app.seconds()).toBe(0);
    await play.click();
    await app.expectPlaying('Long Run');
  });
});

// The desktop app, where the audio host reports the song: playing, with audio.buffering set until
// mpv is really playing it (packages/player-mpv/host.ts).
const song = trackOf('tr-1-1');
const loaded = { queue: [song], entryIds: ['e.1'], currentIndex: 0, duration: 45, playId: 'p.1' };
const commands = (page: Page) => page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls.filter(call => call.startsWith('command:')));
const push = (page: Page, patch: object) => page.evaluate(value => (window as unknown as { pushPlayer(p: object): void }).pushPlayer(value), patch);

for (const where of ['deck', 'mini player'] as const) {
  test(`the desktop ${where} shows a song starting, and sends pause only once it plays`, async ({ page }) => {
    await installDesktopBridge(page, { commands: true, mini: where === 'mini player' });
    await page.goto('/');
    const scope = where === 'deck' ? page.getByRole('complementary', { name: 'Now playing' }) : page.locator('.mini');
    // Resume: the host opens the song at its saved position, paused until it's there.
    await push(page, { ...loaded, playing: true, position: 17, audio: { buffering: true } });
    const starting = scope.getByRole('button', { name: 'Starting', exact: true });
    await expectStarting(starting);
    await starting.click({ force: true });
    await page.waitForTimeout(200);
    expect(await commands(page)).toEqual([]);
    // Heard: now it can be paused.
    await push(page, { playing: true, position: 17.4, audio: { buffering: false } });
    await scope.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(() => commands(page)).toEqual(['command:{"type":"pause"}']);
    // A stall later in the same song is buffering, not starting: the button stays Pause.
    await push(page, { playing: true, position: 30, audio: { buffering: true } });
    await expect(scope.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    // The next song starts again.
    await push(page, { playing: true, position: 0, playId: 'p.2', audio: { buffering: true } });
    await expectStarting(starting);
  });
}
