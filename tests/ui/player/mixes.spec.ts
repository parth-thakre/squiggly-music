import { expect, test, type App } from '../fixtures/test';

// Mixes: every automatic playlist the library can build, grouped by what it draws from. Home's
// "Your mixes" and the Playlists page's "Automatic" lead here, and so does G then M.
const group = (app: App, name: string) => app.main.getByRole('region', { name, exact: true });
const names = (app: App, name: string) => group(app, name).locator('.grid-name');
const seeAll = (app: App, name: string) => group(app, name).getByRole('button', { name: /^See all/ });

test.describe('mixes', () => {
  test('lists every mix under its group, the decades once found, and lights Playlists', async ({ app, fake, page }) => {
    fake.frequent = ['al-3', 'al-5'];
    await app.signIn();
    await app.main.focus();
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await expect(app.heading).toHaveText('Mixes');
    await expect(app.section('Playlists')).toHaveAttribute('aria-current', 'page');
    await expect(app.main.locator('.byline')).toHaveText('Playlists Squiggly builds from your library. They change as it does.');
    await expect(app.main.getByRole('heading', { level: 2 })).toHaveText(['From what you play', 'By genre', 'By decade']);
    // The two every library has come first, under no heading.
    await expect(app.main.locator('ul.grid').first().locator('.grid-name')).toHaveText(['Everything, shuffled', 'Recently added']);
    await expect(names(app, 'From what you play')).toHaveText(['On repeat', 'Lately']);
    await expect(names(app, 'By genre')).toHaveText(['Rock', 'Folk', 'Ambient']);
    await expect(names(app, 'By decade')).toHaveText(['The 2020s', 'The 2010s', 'The 2000s', 'The 1990s']);
    await expect(group(app, 'By decade')).toContainText('Fifty songs released from 1990 to 1999.');
    // The decades were looked for once: nine requests, kept for Records' Decade and Playlists.
    await expect.poll(() => fake.callsTo('randomSongs').filter(call => (call.args[0] as { size: number }).size === 8)).toHaveLength(9);
    await app.section('Playlists').click();
    await expect(app.main.getByRole('heading', { name: 'Automatic' })).toBeVisible();
    await expect.poll(() => fake.callsTo('randomSongs').filter(call => (call.args[0] as { size: number }).size === 8)).toHaveLength(9);
  });

  test('without listening history the history group is left out', async ({ app, page }) => {
    await app.signIn();
    await app.main.focus();
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await expect(app.heading).toHaveText('Mixes');
    await expect(names(app, 'By decade')).toHaveCount(4);
    await expect(app.main.getByRole('heading', { level: 2 })).toHaveText(['By genre', 'By decade']);
    await expect(group(app, 'From what you play')).toHaveCount(0);
  });

  test('a mix that answers after another song started leaves that song playing', async ({ app, fake, page }) => {
    await page.setViewportSize({ width: 1100, height: 480 });
    await app.signIn();
    await app.main.focus();
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await expect(names(app, 'By decade')).toHaveCount(4);
    // The 1990s sit below the fold, so nothing has drawn them yet. Their draw takes four seconds.
    const nineties = () => fake.callsTo('randomSongs').filter(call => { const args = call.args[0] as { size: number; fromYear?: number }; return args.size === 50 && args.fromYear === 1990; });
    expect(nineties()).toHaveLength(0);
    fake.delay('randomSongs', ...Array<number>(20).fill(4000));
    const tile = group(app, 'By decade').locator('li').filter({ hasText: 'The 1990s' });
    await tile.hover();
    await tile.getByRole('button', { name: 'Play The 1990s' }).click();
    await app.play('Test Pressing', 'Long Run');
    expect(nineties()).toHaveLength(1);
    await page.waitForTimeout(4500);
    await expect(app.heading).toHaveText('Test Pressing');
    await app.expectPlaying('Long Run');
  });

  test('See all on Home and on Playlists lands here, and Playlists keeps only the first eight', async ({ app, page }) => {
    await app.signIn({ home: true });
    await seeAll(app, 'Your mixes').click();
    await expect(app.heading).toHaveText('Mixes');
    await expect(names(app, 'By decade')).toHaveCount(4);
    await page.goBack();
    await expect(app.heading).toHaveText('Home');

    await app.section('Playlists').click();
    await expect(app.heading).toHaveText('Playlists');
    const automatic = group(app, 'Automatic');
    // Nine mixes in this library: two for everyone, three genres, four decades. The last waits here.
    await expect(automatic.locator('.row-name')).toHaveText(['Everything, shuffled', 'Recently added', 'Rock', 'Folk', 'Ambient', 'The 2020s', 'The 2010s', 'The 2000s']);
    await seeAll(app, 'Automatic').click();
    await expect(app.heading).toHaveText('Mixes');
    await expect(names(app, 'By decade')).toContainText(['The 1990s']);
    await expect(app.section('Playlists')).toHaveAttribute('aria-current', 'page');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(app.heading).toHaveText('Playlists');
  });

  test('a tile opens its mix and Back returns to where the page was left; a tile plays from its button', async ({ app, page }) => {
    await page.setViewportSize({ width: 1100, height: 560 });
    await app.signIn();
    await app.main.focus();
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    const nineties = group(app, 'By decade').locator('li').filter({ hasText: 'The 1990s' });
    await expect(nineties).toBeVisible();
    await app.main.evaluate(main => main.scrollTo(0, main.scrollHeight));
    const offset = await app.main.evaluate(main => main.scrollTop);
    expect(offset).toBeGreaterThan(100);
    await nineties.getByRole('button', { name: /^The 1990s/ }).click();
    await expect(app.heading).toHaveText('The 1990s');
    await expect(app.section('Playlists')).toHaveAttribute('aria-current', 'page');
    await expect(app.main.locator('.byline')).toHaveText('Fifty songs released from 1990 to 1999.');
    await page.goBack();
    await expect(app.heading).toHaveText('Mixes');
    await expect.poll(() => app.main.evaluate(main => main.scrollTop)).toBeGreaterThan(offset - 2);

    const rock = group(app, 'By genre').locator('li').filter({ hasText: 'Rock' });
    await rock.hover();
    await rock.getByRole('button', { name: 'Play Rock' }).click();
    await expect(app.deck.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  });
});
