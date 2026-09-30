import { join, resolve } from 'node:path';
import { compileEntry } from '../../../apps/desktop/main/extensions/compile';
import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test } from '../fixtures/test';

// The window's extension runtime with a real compiled example. The stand-in bridge
// (fixtures/desktop.ts) lists the extensions, and their modules are served from this origin
// in place of squiggly-ext://. What runs in the page is the app's own runtime and context.
const examples = resolve('examples/extensions');
let sleepTimer = '';
test.beforeAll(async () => { sleepTimer = (await compileEntry(join(examples, 'sleep-timer/src/index.ts'), join(examples, 'sleep-timer'))).code; });

test.beforeEach(async ({ page }) => {
  await page.route('**/__extensions/*.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: route.request().url().endsWith('/broken.js') ? 'export default { activate() { throw new Error("boom"); } };' : sleepTimer,
  }));
  await installDesktopBridge(page, { extensions: [
    { id: 'sleep-timer', name: 'Sleep timer example', url: '/__extensions/sleep-timer.js' },
    { id: 'broken', name: 'Broken', url: '/__extensions/broken.js' },
    { id: 'typo', name: 'Typo', url: '/__extensions/typo.js', error: 'src/index.ts:1:17: Expected "}" but found end of file' },
  ] });
});

test('an extension adds commands to the palette, and they run', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Commands' });
  await palette.getByRole('combobox').fill('sleep');
  const start = palette.getByRole('option', { name: /^Start the example sleep timer/ });
  await expect(start).toContainText('Sleep timer example');
  await start.click();
  await expect(page.getByText('Pausing in 30 minutes.')).toBeVisible();
  // Its `when` now lets the cancel command show.
  await page.keyboard.press('Control+k');
  await palette.getByRole('combobox').fill('cancel the example');
  await expect(palette.getByRole('option', { name: /^Cancel the example sleep timer/ })).toBeVisible();
});

test('a new extension is announced and stays off until it is turned on in Settings', async ({ page }) => {
  // Replaces the bridge from beforeEach: one extension, just found.
  await installDesktopBridge(page, { extensions: [{ id: 'sleep-timer', name: 'Sleep timer example', url: '/__extensions/sleep-timer.js', isNew: true }] });
  await page.goto('/');
  await expect(page.getByText('Found “Sleep timer example”. It stays off until you turn it on in Settings › Extensions.')).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Commands' }).getByRole('combobox').fill('sleep');
  await expect(page.getByRole('dialog', { name: 'Commands' }).getByRole('status')).toHaveText('Nothing matches “sleep”.');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const row = page.locator('.extensions-settings').getByRole('listitem').filter({ hasText: 'Sleep timer example' });
  await expect(row.getByText('New in the extensions folder. It stays off until you turn it on.')).toBeVisible();
  await row.getByRole('checkbox', { name: /^Sleep timer example/ }).check();
  await expect(row.getByText('New in the extensions folder.')).toBeHidden();
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Commands' }).getByRole('combobox').fill('sleep');
  await expect(page.getByRole('dialog', { name: 'Commands' }).getByRole('option', { name: /^Start the example sleep timer/ })).toBeVisible();
});

test('Settings lists extensions with their errors, and turning one off takes its commands away', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.locator('.extensions-settings');
  await expect(section.getByText('extensions/sleep-timer · sleep-timer')).toBeVisible();
  // A compile error from the main process, and an activate() that threw in this window.
  await expect(section.getByRole('alert').filter({ hasText: 'Expected "}"' })).toBeVisible();
  await expect(section.getByRole('alert').filter({ hasText: 'The renderer entry failed to start: boom' })).toBeVisible();

  await section.getByRole('checkbox', { name: /^Sleep timer example/ }).uncheck();
  await expect(section.getByRole('status')).toHaveText('Turned off Sleep timer example.');
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Commands' }).getByRole('combobox').fill('sleep');
  await expect(page.getByRole('dialog', { name: 'Commands' }).getByRole('status')).toHaveText('Nothing matches “sleep”.');
  await page.keyboard.press('Escape');

  // Remove asks first, then moves the folder to the trash.
  await section.getByRole('listitem').filter({ hasText: 'Sleep timer example' }).getByRole('button', { name: 'Remove' }).click();
  await expect(section.getByText('Move this folder to the trash? Its settings are removed too.')).toBeVisible();
  await section.getByRole('listitem').filter({ hasText: 'Sleep timer example' }).getByRole('button', { name: 'Remove' }).click();
  await expect(section.getByRole('status')).toHaveText('Moved Sleep timer example to the trash.');
  await expect(section.getByText('extensions/sleep-timer · sleep-timer')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls)).toContain('remove:sleep-timer');
});
