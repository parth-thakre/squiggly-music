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
    await expect(app.main.getByRole('button', { name: /Test Pressing/ })).toBeVisible();

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
    await expect(app.main.getByRole('button', { name: /Ada Brass/ })).toBeVisible();
  });
});
