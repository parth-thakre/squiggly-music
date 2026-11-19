import { expect, test } from '../fixtures/test';

// The editorial pages: an artist's All songs, the order menu from the keyboard, the queue's record
// dividers, and a record's liner notes.
test.describe('editorial pages', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('an artist\'s All songs lists every song of theirs, in an order of its own, and Back returns to the artist', async ({ app, page }) => {
    await app.section('Artists').click();
    await app.main.getByRole('button', { name: /^Ada Brass/ }).first().click();
    await expect(app.heading).toHaveText('Ada Brass');
    await app.main.getByRole('button', { name: 'All songs', exact: true }).click();
    // Named by the artist, a link back to them, with what the list holds.
    await expect(app.heading).toHaveText('Ada Brass');
    await expect(app.heading.getByRole('button', { name: 'Ada Brass' })).toBeVisible();
    await expect(app.main.locator('.tracks-artist .facts')).toContainText(/^\d+ songs, /);
    await app.expectOrder('A to Z');
    const titles = await app.titles();
    expect(titles.length).toBeGreaterThan(5);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })));
    // Only the orders that make sense for one artist's songs.
    await app.order.click();
    await expect(page.getByRole('menu', { name: 'Order' }).getByRole('menuitemradio')).toHaveText(['A to Z', 'Most played', 'Top rated']);
    await page.keyboard.press('Escape');
    await app.sortBy('Top rated');
    // A sort replaces the place: Back leaves All songs for the artist.
    await page.goBack();
    await expect(app.heading).toHaveText('Ada Brass');
    await expect(app.main.getByRole('region', { name: 'Records', exact: true })).toBeVisible();
  });

  test('an artist\'s Most played ranks their songs by how often they were played, and opens All songs in that order', async ({ app, page }) => {
    // The server's play counts for three of Ada Brass's songs; the rest were never played.
    const plays: Record<string, number> = { 'tr-1-2': 9, 'tr-1-4': 3, 'tr-1-1': 3 };
    await page.route('**/api/album', async route => {
      const response = await route.fetch();
      const result = await response.json() as { ok: boolean; value?: { tracks: { id: string }[] } };
      if (result.ok && result.value) result.value.tracks = result.value.tracks.map(t => plays[t.id] ? { ...t, playCount: plays[t.id] } : t);
      await route.fulfill({ response, json: result });
    });
    await app.section('Artists').click();
    await app.main.getByRole('button', { name: /^Ada Brass/ }).first().click();
    await expect(app.heading).toHaveText('Ada Brass');
    const most = app.main.getByRole('region', { name: 'Most played' });
    // Most first, a tie by name, and only songs played at all.
    await expect.poll(() => app.titles(most)).toEqual(['Lyric Line', 'Long Run', 'Thirty Two']);
    await expect(app.row('Lyric Line', most)).toContainText('9 plays');
    await most.getByRole('button', { name: 'Most played', exact: true }).click();
    await expect(app.heading).toHaveText('Ada Brass');
    await app.expectOrder('Most played');
    expect((await app.titles()).slice(0, 3)).toEqual(['Lyric Line', 'Long Run', 'Thirty Two']);
    // An artist none of whose songs were played has no Most played.
    await page.goBack();
    await app.section('Artists').click();
    await app.main.getByRole('button', { name: /^Bell Tower/ }).first().click();
    await expect(app.heading).toHaveText('Bell Tower');
    await expect(app.main.getByRole('region', { name: 'Records', exact: true })).toBeVisible();
    await expect(app.main.locator('.artist-top')).toHaveCount(0);
  });

  test('the order menu opens on the order in use, and the keyboard picks another', async ({ app, page }) => {
    const trigger = app.order;
    await app.expectOrder('newest first');
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Order' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('menuitemradio', { name: 'Newest' })).toBeFocused();
    await expect(menu.getByRole('menuitemradio', { name: 'Newest' })).toHaveAttribute('aria-checked', 'true');
    // Up from the first wraps to the last; Home goes back to the first; Escape closes and returns.
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('menuitemradio', { name: 'Top rated' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(menu.getByRole('menuitemradio', { name: 'Newest' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(app.heading).toHaveText('Records');

    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitemradio', { name: 'A to Z' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await app.expectOrder('A to Z');
    await expect(app.order).toBeFocused();
    await expect(app.main.locator('ul.grid > li').first()).toContainText('Amber Field');
  });

  test('the queue heads each run of a record after the playing one, and a heading opens its record', async ({ app }) => {
    await app.play('Test Pressing', 'Long Run');
    await app.openAlbum('Quiet Harbor');
    await app.chooseFromMenu(app.row('Opening 2'), 'Add to queue');
    await app.chooseFromMenu(app.row('Second Wind 2'), 'Add to queue');
    await app.openAlbum('Amber Field');
    await app.chooseFromMenu(app.row('Opening 3'), 'Add to queue');
    await app.openQueue();
    // The playing song leads, its record's other songs follow unheaded, then a heading for the next
    // record's two songs. A song alone from a record (a shuffle, a playlist) gets no heading.
    await expect(app.main.getByRole('heading', { level: 2, name: 'Long Run' })).toBeVisible();
    await expect(app.main.getByText('7 songs to come')).toBeVisible();
    const records = app.main.locator('ol.tracks > li.group-record');
    await expect(records).toHaveCount(1);
    await expect(records.locator('.queue-record-name')).toHaveText('Quiet Harbor');
    await expect(records.locator('.queue-record-by')).toContainText('Bell Tower, 2 songs');
    expect(await app.titles()).toEqual(['Long Run', 'Lyric Line', 'Short Stop', 'Thirty Two', 'Tail Light', 'Opening 2', 'Second Wind 2', 'Opening 3']);
    await records.getByRole('button').click();
    await expect(app.heading).toHaveText('Quiet Harbor');
  });

  test('a record\'s liner notes say who is on which song and what the server says the files are', async ({ app }) => {
    await app.openAlbum('Quiet Harbor');
    const credits = app.main.getByRole('region', { name: 'Credits' });
    await expect(credits.locator('.credits-cast')).toHaveText('Bell Tower (every song), Cinder Lane (2)');
    // Only what the server reports about the files, and no claim about what reaches the ears.
    await expect(credits.locator('.credits-files')).toContainText(/kHz/);
    await expect(app.main).not.toContainText(/bit-perfect|lossless|hi-?res/i);
    await expect(app.main.getByRole('region', { name: 'More records' })).toContainText('More by Bell Tower');
    await credits.getByRole('button', { name: 'Cinder Lane' }).click();
    await expect(app.heading).toHaveText('Cinder Lane');
  });
});
