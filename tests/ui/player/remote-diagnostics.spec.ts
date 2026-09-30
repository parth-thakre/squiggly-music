import type { Page } from '@playwright/test';
import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test } from '../fixtures/test';

// Remote diagnostics exist only in desktop betas built with them (docs/packaging.md). Everywhere
// else, stable desktop builds, the browser build, and Android alike, there is no setting, no
// marker, and no "Send diagnostics now". This suite's builds have none, as stable releases.
const calls = (page: Page) => page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls);
const palette = (page: Page) => page.getByRole('dialog', { name: 'Commands' });
async function findCommand(page: Page, text: string) {
  await page.keyboard.press('Control+k');
  await palette(page).getByRole('combobox', { name: 'Find a command' }).fill(text);
  return palette(page).getByRole('option', { name: /^Send diagnostics now/ });
}
async function expectNoDiagnostics(page: Page) {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  // Settings is fully drawn once its last section is.
  await expect(page.getByRole('heading', { name: 'Keys' })).toBeVisible();
  await expect(page.getByText('Send diagnostics to the developer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Beta ·/ })).toHaveCount(0);
  await expect(page.getByText(/sends diagnostics/)).toHaveCount(0);
  await expect(await findCommand(page, 'diagnostics')).toHaveCount(0);
}

test('a desktop build without diagnostics has no setting, marker, or command', async ({ page }) => {
  await installDesktopBridge(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expectNoDiagnostics(page);
});

test('the browser build has no diagnostics setting, marker, or command', async ({ app, page }) => {
  await app.signIn();
  await app.deck.getByRole('button', { name: 'Settings', exact: true }).click();
  await expectNoDiagnostics(page);
});

test('a desktop build without diagnostics shows no marker on the connect screen', async ({ page }) => {
  await installDesktopBridge(page, { connected: false });
  await page.goto('/');
  await expect(page.getByLabel('Server address')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Beta ·/ })).toHaveCount(0);
});

test.describe('a beta with diagnostics', () => {
  test('the marker says so and opens the switch, which turns sending off and on', async ({ page }) => {
    await installDesktopBridge(page, { diagnostics: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'Beta · sends diagnostics' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    const toggle = page.getByRole('checkbox', { name: /Send diagnostics to the developer/ });
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeFocused();
    await expect(page.getByText('Never passwords, tokens, usernames, or server addresses with their sign-in parameters.')).toBeVisible();

    await toggle.uncheck();
    await expect(page.getByRole('button', { name: 'Beta · diagnostics off' })).toBeVisible();
    await expect(await findCommand(page, 'diagnostics')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await toggle.check();
    await expect(page.getByRole('button', { name: 'Beta · sends diagnostics' })).toBeVisible();
    const command = await findCommand(page, 'send diagnostics');
    await expect(command).toHaveCount(1);
    await page.keyboard.press('Enter');
    expect(await calls(page)).toEqual(['settings:{"diagnostics":false}', 'settings:{"diagnostics":true}', 'send-diagnostics']);
  });

  test('from Settings already, the marker still takes focus to the switch', async ({ page }) => {
    await installDesktopBridge(page, { diagnostics: true });
    await page.goto('/');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
    await page.getByRole('button', { name: 'Beta · sends diagnostics' }).click();
    await expect(page.getByRole('checkbox', { name: /Send diagnostics to the developer/ })).toBeFocused();
  });

  test('the connect screen, which has no Settings, shows the switch in place', async ({ page }) => {
    await installDesktopBridge(page, { diagnostics: true, connected: false });
    await page.goto('/');
    const marker = page.getByRole('button', { name: 'Beta · sends diagnostics' });
    await expect(marker).toHaveAttribute('aria-expanded', 'false');
    await marker.click();
    const toggle = page.getByRole('checkbox', { name: /Send diagnostics to the developer/ });
    await toggle.uncheck();
    await expect(page.getByRole('button', { name: 'Beta · diagnostics off' })).toHaveAttribute('aria-expanded', 'true');
    expect(await calls(page)).toEqual(['settings:{"diagnostics":false}']);
  });
});
