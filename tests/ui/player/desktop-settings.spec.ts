import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test, trackOf } from '../fixtures/test';

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
    await expect(page.getByText('The password is kept for this session only.')).toBeVisible();
  });
});

test('the output device is chosen in Settings and saved there', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const output = page.getByRole('combobox', { name: /Output/ });
  await expect(output).toHaveValue('auto');
  await expect(output.locator('option')).toHaveText(['System default']);
});

const setPlayer = (page: import('@playwright/test').Page, patch: object) =>
  page.evaluate(patch => (window as unknown as { setPlayer: (patch: object) => void }).setPlayer(patch), patch);

test('a saved output that is unplugged shows as disconnected, by the name it had', async ({ page }) => {
  const system = { name: 'auto', description: 'System default' };
  const dac = { name: 'wasapi/{b2f16eba-7d1c-4f3a-9d2e-5a1b3c4d5e6f}', description: 'USB DAC' };
  await installDesktopBridge(page, { settings: { outputDevice: dac.name } });
  const setDevices = (devices: typeof dac[]) => setPlayer(page, { devices });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const output = page.getByRole('combobox', { name: /Output/ });
  // Not seen since launch: the id is all there is to go on.
  await setDevices([system]);
  await expect(output).toHaveValue(dac.name);
  await expect(output.locator('option')).toHaveText([`${dac.name} (disconnected)`, 'System default']);
  await setDevices([system, dac]);
  await expect(output.locator('option')).toHaveText(['System default', 'USB DAC']);
  // Unplugged: still the saved choice, named as it was listed, here and after a reload.
  await setDevices([system]);
  await expect(output).toHaveValue(dac.name);
  await expect(output.locator('option')).toHaveText(['USB DAC (disconnected)', 'System default']);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await setDevices([system]);
  await expect(output.locator('option')).toHaveText(['USB DAC (disconnected)', 'System default']);
});

test('the deck names the output mpv was asked for, never where the sound ended up, and reads its notes whole', async ({ page }) => {
  const system = { name: 'auto', description: 'System default' };
  const dac = { name: 'pipewire/alsa_output.usb-dac', description: 'USB DAC' };
  await installDesktopBridge(page, { settings: { outputDevice: dac.name } });
  await page.goto('/');
  const push = (value: object) => page.evaluate(v => (window as unknown as { pushPlayer(p: object): void }).pushPlayer(v), value);
  await push({ queue: [trackOf('tr-1-1')], entryIds: ['e1'], currentIndex: 0, duration: 45, playId: 'p1', playing: true, position: 1, devices: [system, dac],
    audio: { requestedDevice: dac.name, outputBackend: 'pipewire', exclusiveRequested: true } });
  const out = page.locator('.deck .signal-out');
  // PipeWire's session manager can move the stream, so the device is the one asked for.
  await expect(out).toHaveText('Asked for USB DAC, exclusive');
  await push({ audio: { requestedDevice: 'auto', exclusiveRequested: true } });
  await expect(out).toHaveText('PipeWire, exclusive use requested');
  await push({ audio: { exclusiveRequested: false } });
  await expect(out).toHaveText('PipeWire');
  // What changes the sound takes as many lines as it needs, the last note as readable as the first.
  await push({ streamKbps: 128, volume: 40 });
  await expect(out).toHaveText('Streaming a 128 kbps MP3. Volume at 40%.');
  expect(await out.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test('news from the engine goes when the engine takes it back; an error stays until dismissed', async ({ page }) => {
  await installDesktopBridge(page);
  await page.goto('/');
  await setPlayer(page, { error: 'Switched back to USB DAC.' });
  await expect(page.getByRole('alert')).toContainText('Switched back to USB DAC.');
  await setPlayer(page, { error: null });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await setPlayer(page, { error: 'Playback failed in libmpv (code -13).' });
  await page.getByRole('alert').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Dismissed, it stays dismissed while the engine still reports it.
  await setPlayer(page, { position: 1 });
  await expect(page.getByRole('alert')).toHaveCount(0);
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
