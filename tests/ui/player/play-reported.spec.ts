import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test } from '../fixtures/test';

// The desktop's main process reports plays itself, and tells every window, hidden ones too, when
// it has reported a finished one. The window forgets the song's record, so the next look at it
// reads its play counts from the server; the page showing it now stays as it is.
const reported = (page: import('@playwright/test').Page, play: object) =>
  page.evaluate(value => (window as unknown as { pushPlayReported(p: object): void }).pushPlayReported(value), play);

test('a play the main process reports sends the next look at its record to the server', async ({ app, fake, page }) => {
  await installDesktopBridge(page, { server: true });
  await app.signIn();
  await app.openAlbum('Test Pressing');
  const reads = () => fake.callsTo('album').filter(call => call.args[0] === 'al-1').length;
  const first = reads();
  expect(first).toBeGreaterThan(0);
  // Back and forth, the record is the one already read.
  await page.goBack();
  await expect(app.heading).toHaveText('Records');
  await page.goForward();
  await expect(app.heading).toHaveText('Test Pressing');
  expect(reads()).toBe(first);
  // Reported while the record shows: it stays as it is.
  await reported(page, { trackId: 'tr-1-1', albumId: 'al-1' });
  await page.waitForTimeout(300);
  expect(reads()).toBe(first);
  await page.goBack();
  await expect(app.heading).toHaveText('Records');
  await page.goForward();
  await expect(app.heading).toHaveText('Test Pressing');
  await expect.poll(reads).toBe(first + 1);
});
