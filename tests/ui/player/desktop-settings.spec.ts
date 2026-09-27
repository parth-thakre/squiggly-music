import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test } from '../fixtures/test';

// Desktop-only Settings, through a stand-in for the preload bridge (fixtures/desktop.ts).
test.beforeEach(async ({ page }) => { await installDesktopBridge(page); });

test('Disconnect in Settings returns the desktop app to the connect screen', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await expect(page.getByText('Connected to Navidrome (music.example.com).')).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await expect(page.getByLabel('Server address')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls)).toEqual(['disconnect']);
});

test('the browser build has no Disconnect in Settings', async ({ app, page }) => {
  // Without the bridge the same page is the browser build, which signs out from the deck instead.
  await page.addInitScript(() => { delete (window as { squiggly?: unknown }).squiggly; });
  await app.signIn();
  await app.deck.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(app.heading).toHaveText('Settings');
  await expect(page.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
});
