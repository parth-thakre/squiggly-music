import { allTracks, expect, test } from '../fixtures/test';

// Songs: every song on the server, a page at a time, played like any other song list.
test.describe('songs', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('lists every song a page at a time, and a click plays from the songs loaded', async ({ app, fake, page }) => {
    await app.section('Songs').click();
    await expect(app.heading).toHaveText('Songs');
    await expect(app.section('Songs')).toHaveAttribute('aria-current', 'page');
    await expect(app.row('Long Run')).toBeVisible();
    expect(fake.callsTo('songs').map(call => call.args)).toEqual([[0, 200]]);
    // Only the rows near the viewport are in the page.
    expect(await app.tracks().count()).toBeLessThan(100);

    // Nearing the end asks for the next page; a short page is the last.
    const last = allTracks[allTracks.length - 1];
    await app.main.evaluate(main => main.scrollTo(0, main.scrollHeight));
    await expect.poll(() => fake.callsTo('songs').map(call => call.args)).toEqual([[0, 200], [200, 200]]);
    await app.main.evaluate(main => main.scrollTo(0, main.scrollHeight));
    await expect(app.row(last.title).locator('.n')).toHaveText(String(allTracks.length));
    await expect(app.row(last.title)).toContainText(last.album);

    await app.main.evaluate(main => main.scrollTo(0, 0));
    await app.rowButton(app.row('Lyric Line')).click();
    await app.expectPlaying('Lyric Line');
    await app.openQueue();
    await expect(app.main.getByText(`${allTracks.length - 2} songs up next`)).toBeVisible();
    // Back returns to the same place in the list without asking the server again.
    await page.goBack();
    await expect(app.heading).toHaveText('Songs');
    expect(fake.callsTo('songs')).toHaveLength(2);
  });

  test('Back returns to where the list was left', async ({ app, page }) => {
    const deep = allTracks[70].title;
    await app.section('Songs').click();
    await expect(app.row('Long Run')).toBeVisible();
    await app.main.evaluate(main => main.scrollTo(0, 3000));
    await expect(app.row(deep)).toBeInViewport();
    await app.section('Records').click();
    await expect(app.heading).toHaveText('Records');
    await page.goBack();
    await expect(app.heading).toHaveText('Songs');
    await expect.poll(() => app.main.evaluate(main => Math.round(main.scrollTop))).toBe(3000);
    await expect(app.row(deep)).toBeInViewport();
  });

  test('says so while the first page loads, and Shuffle draws from the whole library', async ({ app, fake }) => {
    fake.delay('songs', 1000);
    await app.section('Songs').click();
    await expect(app.main.getByText('Gathering songs')).toBeVisible();
    await expect(app.row('Long Run')).toBeVisible();

    await app.main.getByRole('button', { name: 'Shuffle', exact: true }).click();
    await expect.poll(() => fake.callsTo('randomSongs').map(call => call.args)).toEqual([[{ size: 500 }]]);
    await expect(app.deck.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  });

  test('Go to songs runs from Ctrl+K, and G then T goes there too', async ({ app, page }) => {
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Commands' });
    await expect(palette.getByRole('option', { name: /^Go to songs/ })).toContainText('G then T');
    await palette.getByRole('combobox').fill('go to songs');
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(app.heading).toHaveText('Songs');

    await app.section('Records').click();
    await expect(app.heading).toHaveText('Records');
    await app.main.focus();
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await expect(app.heading).toHaveText('Songs');
  });
});
