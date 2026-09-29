import { allTracks, expect, test, type App } from '../fixtures/test';

// Tracks: every track on the server, sorted as records are, a page at a time, played like any
// other song list. Sorting comes from Navidrome's own API; without it the sorts are hidden.
const sorts = (app: App) => app.main.getByRole('group', { name: 'Sort tracks' });
async function sortBy(app: App, label: string) {
  await sorts(app).getByRole('button', { name: label, exact: true }).click();
  await expect(sorts(app).getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
}
const first = async (app: App, count: number) => (await app.titles()).slice(0, count);

test.describe('tracks', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('each sort orders every track its own way', async ({ app, fake }) => {
    await app.section('Tracks').click();
    await expect(app.heading).toHaveText('Tracks');
    await expect(app.section('Tracks')).toHaveAttribute('aria-current', 'page');
    // Newest first: the record added last, its last track first.
    await expect(sorts(app).getByRole('button', { name: 'Newest' })).toHaveAttribute('aria-pressed', 'true');
    await expect(app.tracks().first()).toContainText('Take 100');
    expect(await first(app, 3)).toEqual(['Take 100', 'Take 99', 'Take 98']);

    await sortBy(app, 'A to Z');
    await expect(app.tracks().first()).toContainText('Coda 11');
    expect(await first(app, 4)).toEqual(['Coda 11', 'Coda 14', 'Coda 17', 'Coda 2']);
    // By artist, then record, then disc and track: Ada Brass's Hollow Pines, then her Long Player.
    await sortBy(app, 'By artist');
    await expect(app.tracks().first()).toContainText('Opening 13');
    expect(await first(app, 6)).toEqual(['Opening 13', 'Second Wind 13', 'Middle Distance 13', 'Late Call 13', 'Take 1', 'Take 2']);
    // Played tracks only.
    await sortBy(app, 'Most played');
    await expect(app.tracks()).toHaveCount(3);
    expect(await app.titles()).toEqual(['Second Wind 3', 'Opening 5', 'Opening 2']);
    await sortBy(app, 'Recently played');
    await expect(app.tracks().first()).toContainText('Opening 5');
    expect(await app.titles()).toEqual(['Opening 5', 'Opening 2', 'Second Wind 3']);

    // Random pages share one seed; choosing Random again draws anew.
    await sortBy(app, 'Random');
    await expect(app.tracks().first()).not.toContainText('Opening 5');
    const draw = await first(app, 5);
    expect(draw).not.toEqual(['Take 100', 'Take 99', 'Take 98', 'Take 97', 'Take 96']);
    const seeds = () => fake.nativeQueries.filter(query => query.get('_sort') === 'random').map(query => query.get('seed'));
    await app.main.evaluate(main => main.scrollTo(0, main.scrollHeight));
    await expect.poll(() => seeds().length).toBe(2);
    expect(new Set(seeds()).size).toBe(1);
    await sortBy(app, 'Newest');
    await sortBy(app, 'Random');
    await expect.poll(() => new Set(seeds()).size).toBe(2);

    // One sign-in for all of it, and each query as Navidrome names its sorts.
    expect(fake.logins).toBe(1);
    expect([...new Set(fake.nativeQueries.map(query => `${query.get('_sort')} ${query.get('_order')}`))])
      .toEqual(['recently_added desc', 'title asc', 'artist asc', 'play_count desc', 'play_date desc', 'random asc']);
  });

  test('the sort and the place in the list survive Back', async ({ app, fake, page }) => {
    await app.section('Tracks').click();
    await expect(app.tracks().first()).toContainText('Take 100');
    await sortBy(app, 'A to Z');
    await expect(app.tracks().first()).toContainText('Coda 11');
    await app.main.evaluate(main => main.scrollTo(0, 3000));
    const deep = app.main.locator('ol.tracks > li[data-index="70"] .title .name');
    const title = await deep.textContent();
    await expect(app.row(title!)).toBeInViewport();
    const asked = fake.nativeQueries.length;

    await app.section('Records').click();
    await expect(app.heading).toHaveText('Records');
    await page.goBack();
    await expect(app.heading).toHaveText('Tracks');
    await expect(sorts(app).getByRole('button', { name: 'A to Z' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => app.main.evaluate(main => Math.round(main.scrollTop))).toBe(3000);
    await expect(app.row(title!)).toBeInViewport();
    expect(fake.nativeQueries.length).toBe(asked);
    // Changing the sort replaces the place rather than adding one: Back leaves Tracks.
    await page.goBack();
    await expect(app.heading).toHaveText('Records');
  });

  test('pages as the list scrolls, and a click plays from the tracks loaded', async ({ app, fake }) => {
    await app.section('Tracks').click();
    await expect(app.tracks().first()).toContainText('Take 100');
    expect(fake.callsTo('tracks').map(call => call.args)).toEqual([['newest', 0, 200, '']]);
    // Only the rows near the viewport are in the page.
    expect(await app.tracks().count()).toBeLessThan(100);

    // Nearing the end asks for the next page; a short page is the last.
    await app.main.evaluate(main => main.scrollTo(0, main.scrollHeight));
    await expect.poll(() => fake.callsTo('tracks').map(call => call.args)).toEqual([['newest', 0, 200, ''], ['newest', 200, 200, '']]);
    await app.main.evaluate(main => main.scrollTo(0, main.scrollHeight));
    await expect(app.row('Long Run').locator('.n')).toHaveText(String(allTracks.length));
    await expect(app.row('Long Run')).toContainText('Test Pressing');

    await app.main.evaluate(main => main.scrollTo(0, 0));
    await app.rowButton(app.row('Take 99')).click();
    await app.expectPlaying('Take 99');
    await app.openQueue();
    await expect(app.main.getByText(`${allTracks.length - 2} songs up next`)).toBeVisible();
  });

  test('signs in to Navidrome again when its session has ended', async ({ app, fake }) => {
    await app.section('Tracks').click();
    await expect(app.tracks().first()).toContainText('Take 100');
    fake.expireSessions();
    await sortBy(app, 'Most played');
    await expect(app.tracks()).toHaveCount(3);
    expect(fake.logins).toBe(2);
  });

  test('without Navidrome\'s own API, tracks come in the server\'s order and the sorts are hidden', async ({ app, fake, page }) => {
    fake.nativeApi = false;
    await app.section('Tracks').click();
    await expect(app.tracks().first()).toContainText('Long Run');
    expect(await first(app, 3)).toEqual(['Long Run', 'Lyric Line', 'Short Stop']);
    await expect(sorts(app)).toHaveCount(0);
    await expect(app.main.getByRole('button', { name: 'Shuffle', exact: true })).toBeVisible();
    expect(fake.logins).toBe(0);
    await app.rowButton(app.row('Lyric Line')).click();
    await app.expectPlaying('Lyric Line');
    await page.goBack();
    await expect(app.heading).toHaveText('Records');
  });

  test('says so while the first page loads, and Shuffle draws from the whole library', async ({ app, fake }) => {
    fake.delay('tracks', 1000);
    await app.section('Tracks').click();
    await expect(app.main.getByText('Gathering tracks')).toBeVisible();
    await expect(app.tracks().first()).toContainText('Take 100');

    await app.main.getByRole('button', { name: 'Shuffle', exact: true }).click();
    await expect.poll(() => fake.callsTo('randomSongs').map(call => call.args)).toEqual([[{ size: 500 }]]);
    await expect(app.deck.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  });

  test('Go to tracks runs from Ctrl+K, and G then T goes there too', async ({ app, page }) => {
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Commands' });
    await expect(palette.getByRole('option', { name: /^Go to tracks/ })).toContainText('G then T');
    await palette.getByRole('combobox').fill('go to tracks');
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(app.heading).toHaveText('Tracks');

    await app.section('Records').click();
    await expect(app.heading).toHaveText('Records');
    await app.main.focus();
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await expect(app.heading).toHaveText('Tracks');
  });
});
