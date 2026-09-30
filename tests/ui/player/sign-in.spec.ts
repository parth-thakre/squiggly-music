import type { Page } from '@playwright/test';
import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test, webPassword } from '../fixtures/test';

const day = 24 * 60 * 60 * 1000;

test.describe('sign-in', () => {
  test('a wrong password is refused with a message and the field is cleared', async ({ app, page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Squiggly', level: 1 })).toBeVisible();
    await expect(app.signInPassword).toBeFocused();
    await app.signInPassword.fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('That password is incorrect.');
    await expect(app.signInPassword).toHaveValue('');
    await expect(app.section('Records')).toHaveCount(0);
  });

  test('signing in opens the library and signing out returns to the sign-in screen', async ({ app, page }) => {
    await page.goto('/');
    await app.signInPassword.fill(webPassword);
    await app.signInPassword.press('Enter');
    await expect(app.heading).toHaveText('Records');
    await expect(app.main.getByRole('button', { name: /^Test Pressing/ })).toBeVisible();

    await app.deck.getByRole('button', { name: 'Sign out' }).click();
    await expect(app.signInPassword).toBeVisible();
    await expect(app.section('Records')).toHaveCount(0);
    // The session is gone on the server too, not just hidden.
    await page.reload();
    await expect(app.signInPassword).toBeVisible();
    expect((await page.request.post('/api/playlists', { data: [], headers: { origin: app.url } })).status()).toBe(401);
  });

  test('a session that ends mid-use (401 from /api) returns to sign-in, and signing in again resumes', async ({ app, page, fake }) => {
    await app.signIn();
    await app.play('Test Pressing', 'Long Run');
    // The server forgets the session: its 30-day lifetime runs out.
    fake.clock.now += 31 * day;
    await app.section('Artists').click();
    await expect(app.signInPassword).toBeVisible();
    await expect(app.deck).toHaveCount(0);

    await app.signInPassword.fill(webPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(app.section('Artists')).toBeVisible();
    await app.section('Artists').click();
    await expect(app.heading).toHaveText('Artists');
    await expect(app.main.getByRole('button', { name: /^Ada Brass/ })).toBeVisible();
  });
});

// The desktop and Android connect screen, through a stand-in for the preload bridge (fixtures/desktop.ts).
test.describe('connecting to a server without HTTPS', () => {
  const calls = (page: Page) => page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls);
  const typeSignIn = async (page: Page) => {
    await page.getByLabel('Server address').fill('music.example.com');
    await page.getByLabel('Username').fill('ana');
    await page.getByLabel('Password').fill('secret');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
  };

  test('asks before plain HTTP, and connects there only on Continue', async ({ page }) => {
    await installDesktopBridge(page, { connected: false, connect: {
      'music.example.com': { ok: true, value: { type: 'plain-http', url: 'http://music.example.com' } },
      'http://music.example.com': { ok: true, value: { type: 'connected' } },
    } });
    await page.goto('/');
    await typeSignIn(page);
    await expect(page.getByRole('alert')).toContainText('This server isn\'t using HTTPS. Your password would be sent unprotected.');
    // Cancel sends nothing more.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await calls(page)).toEqual(['connect:music.example.com:ana']);

    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await calls(page)).toEqual(['connect:music.example.com:ana', 'connect:music.example.com:ana', 'connect:http://music.example.com:ana']);
  });

  test('an untrusted certificate is an error, with no way on over plain HTTP', async ({ page }) => {
    const refused = 'This server\'s HTTPS certificate isn\'t trusted (it may be self-signed, expired, or for another address), so Squiggly won\'t connect to it. Check the address, or fix the certificate on the server.';
    await installDesktopBridge(page, { connected: false, connect: { 'music.example.com': { ok: false, error: refused } } });
    await page.goto('/');
    await typeSignIn(page);
    await expect(page.getByRole('alert')).toHaveText(refused);
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  });
});
