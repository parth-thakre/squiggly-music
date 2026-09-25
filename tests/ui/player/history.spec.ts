import { expect, test, type App } from '../fixtures/test';

const sections = ['Artists', 'Playlists', 'Favorites', 'Records'] as const;
const current = (app: App) => app.page.getByRole('navigation', { name: 'Library' }).locator('button[aria-current="page"]');

test.describe('history', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('Back and Forward keep working after more than 50 places', async ({ app, page }) => {
    test.setTimeout(60_000);
    // Records is the first place; then 64 more, cycling through the sections.
    const visited: string[] = ['Records'];
    for (let i = 0; i < 64; i++) {
      const name = sections[i % sections.length];
      await app.section(name).click();
      await expect(app.heading).toHaveText(name);
      visited.push(name);
    }
    const back = page.getByRole('button', { name: 'Back', exact: true });
    // Step back with the app's own Back button, then with the browser's.
    for (let step = 1; step <= 6; step++) {
      await (step % 2 ? back.click() : page.goBack());
      await expect(current(app)).toHaveText(visited[visited.length - 1 - step]);
      await expect(app.heading).toHaveText(visited[visited.length - 1 - step]);
    }
    for (let step = 5; step >= 3; step--) {
      await page.goForward();
      await expect(app.heading).toHaveText(visited[visited.length - 1 - step]);
    }
    // Alt+ArrowLeft goes back too.
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(app.heading).toHaveText(visited[visited.length - 1 - 4]);
    await expect(back).toBeVisible();
  });

  test('the Records sort survives opening a record and coming Back', async ({ app, page }) => {
    const sort = app.main.getByRole('group', { name: 'Sort records' });
    await expect(sort.getByRole('button', { name: 'Newest' })).toHaveAttribute('aria-pressed', 'true');
    const firstRecord = app.main.locator('ul.grid > li').first();
    await expect(firstRecord).toContainText('Test Pressing');

    await sort.getByRole('button', { name: 'A to Z' }).click();
    await expect(sort.getByRole('button', { name: 'A to Z' })).toHaveAttribute('aria-pressed', 'true');
    await expect(firstRecord).toContainText('Amber Field');
    await firstRecord.getByRole('button').click();
    await expect(app.heading).toHaveText('Amber Field');

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(app.heading).toHaveText('Records');
    await expect(sort.getByRole('button', { name: 'A to Z' })).toHaveAttribute('aria-pressed', 'true');
    await expect(firstRecord).toContainText('Amber Field');
    await page.goForward();
    await expect(app.heading).toHaveText('Amber Field');
    await page.goBack();
    await expect(sort.getByRole('button', { name: 'A to Z' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('Back to a search restores its query, and a pending search never pulls you back', async ({ app, page }) => {
    const search = page.getByRole('searchbox', { name: 'Search your library' });
    await search.fill('harbor');
    await expect(app.heading).toHaveText('“harbor”');
    await expect(app.main.getByRole('button', { name: /Quiet Harbor/ })).toBeVisible();
    await app.section('Artists').click();
    await expect(app.heading).toHaveText('Artists');
    await expect(search).toHaveValue('');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(app.heading).toHaveText('“harbor”');
    await expect(search).toHaveValue('harbor');

    // Typing, then choosing a section before the search fires: the section wins.
    await search.fill('amber');
    await app.section('Playlists').click();
    await expect(app.heading).toHaveText('Playlists');
    await page.waitForTimeout(600);
    await expect(app.heading).toHaveText('Playlists');
  });
});
