import type { Page } from '@playwright/test';
import { installDesktopBridge, type KeptSeed } from '../fixtures/desktop';
import { expect, test, trackOf, type App } from '../fixtures/test';

// Keep on this device, on the desktop: the renderer against a thin fake of the main process
// (fixtures/desktop.ts) whose library calls reach the fake Navidrome through the browser build's
// host. The real main process (downloads, the index, limits) is covered by vitest.

const pressing = ['tr-1-1', 'tr-1-2', 'tr-1-3', 'tr-1-4', 'tr-1-5'];
const allow = (page: Page, count: number) => page.evaluate(n => { (window as unknown as { keepGate: { allow: number } }).keepGate.allow = n; }, count);
const calls = (page: Page) => page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls);
const marks = (app: App) => app.main.locator('ol.tracks > li .kept-mark');

test('keep a record, play it from the device, lose the server, play from Kept, and get it back', async ({ page, app, fake }) => {
  await installDesktopBridge(page, { server: true, kept: {} });
  await app.signIn();

  await test.step('keep Test Pressing, with progress and marks', async () => {
    await app.openAlbum('Test Pressing');
    await app.main.getByRole('button', { name: 'Keep on this device' }).click();
    await expect(app.main.getByRole('status').filter({ hasText: 'Keeping 0 of 5 songs' })).toBeVisible();
    await expect(app.main.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await allow(page, 2);
    await expect(app.main.getByRole('status').filter({ hasText: 'Keeping 2 of 5 songs' })).toBeVisible();
    await expect(marks(app)).toHaveCount(2);
    await allow(page, 5);
    await expect(app.main.getByRole('button', { name: 'Kept on this device', pressed: true })).toBeVisible();
    await expect(marks(app)).toHaveCount(5);
    // The rows keep their names; the mark sits beside the row's button.
    await expect(app.row('Long Run')).toHaveCount(1);
    expect([...fake.streamed].sort()).toEqual(pressing);
  });

  await test.step('the sleeve, the Playlists page, and Settings say so', async () => {
    await app.section('Records').click();
    await expect(app.main.getByRole('list').first().getByRole('button', { name: /^Test Pressing/ }).locator('.kept-mark')).toHaveCount(1);
    await app.section('Playlists').click();
    await expect(app.main.getByRole('heading', { name: 'Kept on this device' })).toBeVisible();
    await app.openSettings();
    await expect(app.main.getByText(/^5 songs, /)).toBeVisible();
  });

  await test.step('a kept song plays from the device, and nothing is fetched', async () => {
    await app.openAlbum('Test Pressing');
    await app.rowButton(app.row('Long Run')).click();
    await expect(app.deck.getByRole('heading', { level: 2 })).toHaveText('Long Run');
    await expect(app.deck.locator('.signal')).toContainText('Playing the copy kept on this device.');
    expect((await calls(page)).at(-1)).toBe(`play:${pressing.join(',')}:device`);
    expect(fake.streamed).toHaveLength(5);
  });

  await test.step('the server goes away: pages say so, and Kept still plays', async () => {
    fake.unreachable = true;
    await app.section('Artists').click();
    await expect(app.heading).toHaveText('Your server is out of reach');
    await expect(app.main.getByText('Squiggly can\'t reach Navidrome (music.example.com). Songs kept on this device still play.')).toBeVisible();
    await expect(app.main.getByRole('button', { name: 'Retry' })).toBeVisible();
    // The deck plays on.
    await expect(app.deck.getByRole('heading', { level: 2 })).toHaveText('Long Run');
    await app.main.getByRole('button', { name: 'Open kept songs' }).click();
    await expect(app.heading).toHaveText('Kept');
    await page.getByRole('button', { name: 'Squiggly home' }).click();
    await expect(app.heading).toHaveText('Kept');
    await expect(app.main.getByText(/^Your server is out of reach\./)).toBeVisible();
    await app.main.getByRole('button', { name: /^Test Pressing/ }).click();
    await app.rowButton(app.row('Tail Light')).click();
    await expect(app.deck.getByRole('heading', { level: 2 })).toHaveText('Tail Light');
    expect((await calls(page)).at(-1)).toBe(`play:${pressing.join(',')}:device`);
    // Nothing that needs the server is offered.
    await expect(app.main.locator('ol.tracks button.star')).toHaveCount(0);
    const menu = await app.openMenuOn(app.rowButton(app.row('Short Stop')));
    await expect(menu.getByRole('menuitem', { name: 'Play', exact: true })).toBeVisible();
    for (const item of ['Start radio', 'Add to playlist', 'Go to record', 'Share…']) await expect(menu.getByRole('menuitem', { name: item })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  await test.step('the server comes back after Retry', async () => {
    fake.unreachable = false;
    await app.section('Artists').click();
    await expect(app.heading).toHaveText('Your server is out of reach');
    await app.main.getByRole('button', { name: 'Retry' }).click();
    await expect(app.heading).toHaveText('Artists');
    await page.getByRole('button', { name: 'Squiggly home' }).click();
    await expect(app.heading).toHaveText('Home');
  });
});

test('launching with the server away opens on what is kept, and Retry returns Home', async ({ page, app }) => {
  const seed: KeptSeed[] = [{ kind: 'album', id: 'al-1', name: 'Test Pressing', artist: 'Ada Brass', coverArt: 'al-1', tracks: pressing.map(trackOf) }];
  await installDesktopBridge(page, { server: true, away: true, kept: { seed } });
  const response = await page.request.post('/api/session', { data: { password: 'squiggly test password' }, headers: { origin: app.url } });
  expect(response.status()).toBe(200);
  await page.goto('/');
  await expect(app.heading).toHaveText('Kept');
  await expect(app.main.getByRole('button', { name: /^Test Pressing/ })).toBeVisible();
  await app.main.getByRole('button', { name: 'Retry' }).click();
  await expect(app.heading).toHaveText('Home');
});

test('cancelling part way leaves what was kept, and offers the rest', async ({ page, app }) => {
  await installDesktopBridge(page, { server: true, kept: {} });
  await app.signIn();
  await app.openAlbum('Test Pressing');
  await app.main.getByRole('button', { name: 'Keep on this device' }).click();
  await allow(page, 2);
  await expect(app.main.getByRole('status').filter({ hasText: 'Keeping 2 of 5 songs' })).toBeVisible();
  await app.main.getByRole('button', { name: 'Cancel' }).click();
  await expect(app.main.getByRole('button', { name: 'Kept 2 of 5. Keep the rest' })).toBeVisible();
  await expect(marks(app)).toHaveCount(2);
});

test('a keep that is refused says why, under the button', async ({ page, app }) => {
  const refuse = 'Keeping these 5 songs needs about 1.2 GB, and 600 MB of the 4,096 MB limit is free. Raise the limit in Settings, or forget something kept first.';
  await installDesktopBridge(page, { server: true, kept: { refuse } });
  await app.signIn();
  await app.openAlbum('Test Pressing');
  await app.main.getByRole('button', { name: 'Keep on this device' }).click();
  await expect(app.main.getByRole('alert').filter({ hasText: refuse })).toBeVisible();
  await expect(app.main.getByRole('button', { name: 'Keep on this device' })).toBeVisible();
});
