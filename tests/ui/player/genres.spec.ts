import { expect, test } from '../fixtures/test';

// Genres: every genre with its counts, most songs first, and each genre's songs a page at a time.
// Records can be narrowed to a decade, and the filter is part of the place, as the sort is.
test.describe('genres', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('lists every genre by song count and plays one genre\'s songs', async ({ app, fake, page }) => {
    await app.section('Genres').click();
    await expect(app.heading).toHaveText('Genres');
    await expect(app.section('Genres')).toHaveAttribute('aria-current', 'page');
    const genres = app.main.locator('ul.genres > li');
    await expect(genres).toHaveCount(3);
    expect(await genres.allInnerTexts()).toEqual(['Rock\n50 songs, 10 records', 'Folk\n41 songs, 10 records', 'Ambient\n30 songs, 10 records']);

    await genres.getByRole('button', { name: /^Rock/ }).click();
    await expect(app.heading).toHaveText('Rock');
    // The section stays lit on the genre's own page.
    await expect(app.section('Genres')).toHaveAttribute('aria-current', 'page');
    await expect(app.main.locator('.byline')).toHaveText('50 songs, 10 records');
    await expect(app.tracks()).toHaveCount(50);
    expect(fake.callsTo('songsByGenre').map(call => call.args)).toEqual([['Rock', 0, 200]]);
    expect(await app.titles()).toContain('Second Wind 2');

    await app.rowButton(app.row('Opening 5')).click();
    await app.expectPlaying('Opening 5');
    // Shuffle draws from the whole genre, not just the songs loaded.
    await app.main.getByRole('button', { name: 'Shuffle', exact: true }).click();
    await expect.poll(() => fake.callsTo('randomSongs').map(call => call.args[0])).toContainEqual({ size: 500, genre: 'Rock' });
    // Then the queue, as after any Play or Shuffle, and Back steps out the way it came.
    await expect(app.heading).toHaveText('Queue');
    expect((await app.titles()).length).toBe(50);

    await page.goBack();
    await expect(app.heading).toHaveText('Rock');
    await page.goBack();
    await expect(app.heading).toHaveText('Genres');
  });

  test('G then G goes to genres', async ({ app, page }) => {
    await app.main.focus();
    await page.keyboard.press('g');
    await page.keyboard.press('g');
    await expect(app.heading).toHaveText('Genres');
  });

  test('a decade narrows Records, survives Back, and All clears it', async ({ app, fake, page }) => {
    const toggle = app.main.getByRole('button', { name: 'Decade', exact: true });
    const decades = app.main.getByRole('group', { name: 'Decade' });
    const records = app.main.locator('ul.grid > li');
    await expect(records.first()).toContainText('Test Pressing');
    // The decades are only looked for once asked.
    expect(fake.callsTo('randomSongs')).toEqual([]);
    await app.main.getByRole('group', { name: 'Sort records' }).getByRole('button', { name: 'A to Z', exact: true }).click();
    await expect(records.first()).toContainText('Amber Field');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // The decades are the ones the automatic playlists found.
    await expect(decades.getByRole('button')).toHaveText(['All', '2020s', '2010s', '2000s', '1990s']);
    await expect(decades.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');

    await decades.getByRole('button', { name: '1990s' }).click();
    await expect(records).toHaveCount(5);
    expect(await records.locator('.grid-name').allInnerTexts()).toEqual(['Quartz Evening', 'Xylophone Dusk', 'Slow Carousel', 'Cedar Lines', 'Jade Frequency']);
    expect(fake.callsTo('albums').at(-1)!.args).toEqual(['byYear', 0, 60, { fromYear: 1990, toYear: 1999 }]);
    // Records by year aren't in any of the sorts.
    await expect(app.main.getByRole('button', { name: 'A to Z', exact: true })).toHaveAttribute('aria-pressed', 'false');

    await records.getByRole('button', { name: /^Cedar Lines/ }).click();
    await expect(app.heading).toHaveText('Cedar Lines');
    await page.goBack();
    await expect(app.heading).toHaveText('Records');
    await expect(decades.getByRole('button', { name: '1990s' })).toHaveAttribute('aria-pressed', 'true');
    await expect(records).toHaveCount(5);

    // All returns to the sort the decade was chosen from.
    await decades.getByRole('button', { name: 'All' }).click();
    await expect(records.first()).toContainText('Amber Field');
    await expect(app.main.getByRole('button', { name: 'A to Z', exact: true })).toHaveAttribute('aria-pressed', 'true');
    // Choosing a sort drops the decade too, and so does closing Decade.
    await decades.getByRole('button', { name: '2000s' }).click();
    await expect(records.first()).toContainText('Rust Belt Hymns');
    await app.main.getByRole('button', { name: 'Newest', exact: true }).click();
    await expect(decades.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    await expect(records.first()).toContainText('Test Pressing');
    await decades.getByRole('button', { name: '2010s' }).click();
    await expect(records.first()).toContainText('Copper Sky');
    await toggle.click();
    await expect(decades).toHaveCount(0);
    await expect(records.first()).toContainText('Test Pressing');
  });
});
