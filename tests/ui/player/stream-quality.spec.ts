import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test, trackOf } from '../fixtures/test';

// Settings › Streaming quality, and what the deck says while a smaller MP3 plays.

const song = trackOf('tr-1-1');
const calls = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls);

test('a lower streaming quality is saved, and the deck says when a song streams at it', async ({ page }) => {
  await installDesktopBridge(page, { commands: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const quality = page.getByRole('combobox', { name: /^Streaming quality/ });
  await expect(quality).toHaveValue('original');
  await quality.selectOption({ label: 'MP3, 128 kbps' });
  await expect.poll(() => calls(page)).toContain('settings:{"streamQuality":128}');
  await expect(quality).toHaveValue('128');

  // The host says the playing song streams as a 128 kbps MP3; the original's format still shows.
  await page.evaluate(value => (window as unknown as { pushPlayer(p: object): void }).pushPlayer(value),
    { queue: [song], entryIds: ['e.1'], currentIndex: 0, duration: 360, playId: 'p.1', playing: true, position: 10, streamKbps: 128, audio: { buffering: false } });
  await expect(page.locator('.deck .signal')).toContainText('Streaming a 128 kbps MP3 of it, as set in Settings.');
  // Back to the original: nothing more to say about it.
  await page.evaluate(value => (window as unknown as { pushPlayer(p: object): void }).pushPlayer(value), { streamKbps: null });
  await expect(page.locator('.deck .signal')).not.toContainText('kbps MP3');
});
