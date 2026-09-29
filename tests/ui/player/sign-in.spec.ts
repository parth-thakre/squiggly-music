import { account, App, expect, test, webPassword } from '../fixtures/test';

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
    await expect(app.heading).toHaveText('Home');
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

test.describe('connect', () => {
  test('a host with no server of its own asks for one, and Disconnect in Settings goes back to asking', async ({ page, unconfigured }) => {
    unconfigured.fake.reset();
    const app = new App(page, unconfigured.url);
    await page.goto(unconfigured.url);
    // The same connect screen as the desktop and Android, saying what the host keeps.
    await expect(page.getByRole('heading', { name: 'Squiggly', level: 1 })).toBeVisible();
    await expect(page.getByText('The host that serves this page keeps the connection in its memory until it restarts, a day passes without using it, or you disconnect in Settings. Nothing is written to disk.')).toBeVisible();
    await expect(page.getByRole('button', { name: "Try Navidrome's demo" })).toBeVisible();
    expect((await page.request.post(`${app.url}/api/playlists`, { data: [], headers: { origin: app.url } })).status()).toBe(503);

    // Typed without http://, as on the desktop: the host tries HTTPS, then HTTP.
    await page.getByLabel('Server address').fill(unconfigured.navidrome);
    await page.getByLabel('Username').fill(account.username);
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Incorrect username or password. Check your Navidrome login and try again.');
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(app.heading).toHaveText('Home');
    await app.play('Test Pressing', 'Long Run');
    // The connection is the page's to drop, from the deck and from Settings.
    await expect(app.deck.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
    await expect(app.deck.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await app.openSettings();
    await expect(app.main.getByText(`Connected to Navidrome (http://${unconfigured.navidrome}). Disconnecting stops playback, empties the queue, and goes back to the connect screen`)).toBeVisible();
    await app.main.getByRole('button', { name: 'Disconnect', exact: true }).click();

    await expect(page.getByLabel('Server address')).toBeVisible();
    await expect(app.deck).toHaveCount(0);
    expect(await page.evaluate(() => [...document.querySelectorAll('audio')].every(audio => audio.paused))).toBe(true);
    // The host forgot it too.
    await page.reload();
    await expect(page.getByLabel('Server address')).toBeVisible();
    expect((await page.request.post(`${app.url}/api/playlists`, { data: [], headers: { origin: app.url } })).status()).toBe(503);
  });

  test('a connection the host forgot (a restart, say) returns the page to the connect screen', async ({ page, unconfigured }) => {
    unconfigured.fake.reset();
    const app = new App(page, unconfigured.url);
    await page.goto(unconfigured.url);
    await page.getByLabel('Server address').fill(`http://${unconfigured.navidrome}`);
    await page.getByLabel('Username').fill(account.username);
    await page.getByLabel('Password').fill(account.password);
    await page.getByLabel('Password').press('Enter');
    await expect(app.heading).toHaveText('Home');
    // The host drops it behind the page's back; the next library call finds nothing there.
    expect((await page.request.post(`${app.url}/api/disconnect`, { data: {}, headers: { origin: app.url } })).status()).toBe(200);
    // Home's shelves may still be asking for their songs, and any such call finds the host has
    // forgotten the page; if none is on its way, going somewhere makes one.
    const artists = app.section('Artists');
    // The page may go back to the connect screen under the click; a short wait is enough to tell.
    if (await artists.isVisible()) await artists.click({ timeout: 1500 }).catch(() => undefined);
    await expect(page.getByLabel('Server address')).toBeVisible();
    await expect(app.deck).toHaveCount(0);
  });
});
