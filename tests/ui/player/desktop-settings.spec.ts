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

test.describe('saved sign-in', () => {
  const saved = { url: 'https://music.example.com', username: 'ana' };
  test('a failed reconnect leaves the connect screen filled in, with the reason', async ({ page }) => {
    await installDesktopBridge(page, { connected: false, signIn: { saved, reconnectError: 'The server did not answer.' } });
    await page.goto('/');
    await expect(page.getByRole('alert')).toHaveText('Couldn\'t reconnect to music.example.com: The server did not answer.');
    await expect(page.getByLabel('Server address')).toHaveValue(saved.url);
    await expect(page.getByLabel('Username')).toHaveValue('ana');
    await expect(page.getByText('Squiggly remembers this sign-in')).toBeVisible();
  });
  test('while reconnecting, the connect form waits', async ({ page }) => {
    await installDesktopBridge(page, { connected: false, signIn: { saved, reconnecting: true } });
    await page.goto('/');
    await expect(page.getByText('Connecting to music.example.com as ana.')).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveCount(0);
  });
  test('without secure storage, the password is said to stay in memory', async ({ page }) => {
    await installDesktopBridge(page, { connected: false, signIn: { canRemember: false } });
    await page.goto('/');
    await expect(page.getByText('This system can\'t store the password securely')).toBeVisible();
  });
});

test('the output device is chosen in Settings and saved there', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const output = page.getByRole('combobox', { name: /Output/ });
  await expect(output).toHaveValue('auto');
  await expect(output.locator('option')).toHaveText(['System default']);
});

test.describe('updates', () => {
  const calls = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls);
  test('a downloaded update offers a restart, in the deck and in Settings', async ({ page }) => {
    await installDesktopBridge(page, { update: { status: 'ready', version: '0.1.1' } });
    await page.goto('/');
    await page.getByRole('button', { name: 'Restart to update to 0.1.1' }).click();
    expect(await calls(page)).toEqual(['update:install']);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Squiggly 0.1.1 is ready. It installs when you restart or quit.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check now' })).toHaveCount(0);
  });
  test("a copy that can't update itself links to the release instead", async ({ page }) => {
    await installDesktopBridge(page, { update: { mode: 'notify', status: 'available', version: '0.1.1' } });
    await page.goto('/');
    await page.getByRole('button', { name: 'Squiggly 0.1.1 is out' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Squiggly 0.1.1 is out. You have 0.1.0.')).toBeVisible();
    await page.getByRole('button', { name: 'Check now' }).click();
    expect(await calls(page)).toEqual(['update:open', 'update:check']);
  });
  test('up to date says so, and nothing shows in the deck', async ({ page }) => {
    await installDesktopBridge(page);
    await page.goto('/');
    await expect(page.locator('.update-link')).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Squiggly 0.1.0 is the latest version.')).toBeVisible();
    await expect(page.getByLabel(/Check for updates/)).toBeChecked();
  });
});

test("the connect screen offers Navidrome's public demo", async ({ page }) => {
  await installDesktopBridge(page, { connected: false });
  await page.goto('/');
  await page.getByRole('button', { name: "Try Navidrome's demo" }).click();
  expect(await page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls)).toEqual(['connect:https://demo.navidrome.org:demo']);
  await expect(page.getByRole('alert')).toHaveText('No server in the test.');
});
