import { expect, test, type App } from '../fixtures/test';

// An artist's biography and similar artists (from the server's agents, shown only when there are
// some), and a record on more than one disc, grouped by disc in one song list.
async function openArtist(app: App, name: string) {
  await app.section('Artists').click();
  await expect(app.heading).toHaveText('Artists');
  await app.main.getByRole('button', { name: new RegExp(`^${name}`) }).first().click();
  await expect(app.heading).toHaveText(name);
}

test.describe('artist and record pages', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('an artist\'s biography is plain text, a few sentences first, with similar artists to follow', async ({ app, page }) => {
    await openArtist(app, 'Ada Brass');
    const bio = app.main.getByRole('region', { name: 'About' });
    await expect(bio).toHaveText('Ada Brass is a brass quartet from the coast. They formed in 2009 & toured every harbour town. Their records are slow and warm. More');
    // The server's HTML never reaches the page: no bold, no link to Last.fm.
    await expect(bio.locator('b, a')).toHaveCount(0);
    await expect(bio).not.toContainText('Read more on Last.fm');
    await bio.getByRole('button', { name: 'More' }).click();
    await expect(bio).toContainText('Critics compare them to foghorns. They still rehearse in a boathouse.');
    await expect(bio.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true');

    const similar = app.main.getByRole('region', { name: 'Similar artists' });
    await expect(similar.getByRole('button')).toHaveText(['Bell Tower']);
    await similar.getByRole('button', { name: 'Bell Tower' }).click();
    await expect(app.heading).toHaveText('Bell Tower');
    // Nothing known about Bell Tower: no biography, no similar artists, no placeholders.
    await expect(app.main.getByRole('heading', { name: 'Records' })).toBeVisible();
    await expect(app.main.getByRole('region', { name: 'About' })).toHaveCount(0);
    await expect(app.main.getByRole('heading', { name: 'Similar artists' })).toHaveCount(0);
    await page.goBack();
    await expect(app.heading).toHaveText('Ada Brass');
  });

  test('a biography of broken HTML shows as text, with no tag left in it', async ({ app }) => {
    await openArtist(app, 'Cinder Lane');
    const bio = app.main.getByRole('region', { name: 'About' });
    await expect(bio).toHaveText('Cinder Lane began as a duo in a alert(1) garage. They sing about weather & tides.');
    expect(await bio.textContent()).not.toContain('<');
    await expect(bio.locator('b, i, a, script')).toHaveCount(0);
  });

  test('a record on two discs has a heading per disc, one numbering per disc, and one list', async ({ app, page }) => {
    await app.openAlbum('Quiet Harbor');
    // One disc: no headings.
    await expect(app.main.locator('.group-head')).toHaveCount(0);

    await app.openAlbum('Low Tide Radio');
    await expect(app.main.locator('.group-head')).toHaveText(['Disc 1', 'Night Side']);
    const rows = app.main.locator('ol.tracks > li[data-index]');
    await expect(rows.locator('.n')).toHaveText(['1', '2', '3', '1', '2']);
    await expect(app.main.getByRole('heading', { level: 2, name: 'Night Side' })).toBeVisible();

    // Selection runs across discs, as in any one list.
    await app.rowButton(app.row('Second Wind 8')).click({ modifiers: ['ControlOrMeta'] });
    await app.rowButton(app.row('Coda 8')).click({ modifiers: ['Shift'] });
    await expect(app.main.locator('ol.tracks > li.selected')).toHaveCount(4);
    await page.keyboard.press('Escape');
    await expect(app.main.locator('ol.tracks > li.selected')).toHaveCount(0);

    // Playing a song on the second disc queues the whole record from there.
    await app.rowButton(app.row('Late Call 8')).click();
    await app.expectPlaying('Late Call 8');
    await app.openQueue();
    expect(await app.titles()).toEqual(['Opening 8', 'Second Wind 8', 'Middle Distance 8', 'Late Call 8', 'Coda 8']);
  });

  test('a long record windows its songs, and its disc heading and selection hold up past the first window', async ({ app, fake, page }) => {
    fake.large = true;
    // The last of the records: from its artist, as the grid of all of them windows too.
    await openArtist(app, 'Cinder Lane');
    await app.main.getByRole('button', { name: /^Two Nights Live/ }).first().click();
    await expect(app.heading).toHaveText('Two Nights Live');
    const heads = app.main.locator('.group-head');
    // 210 songs: only the rows near the viewport are in the page, so only the first heading is.
    await expect(heads).toHaveText(['Disc 1']);
    await expect(app.row('Night Two 1')).toHaveCount(0);
    const title = 'Live at the Royal Albert Hall, London, 1971';
    const second = app.main.getByRole('heading', { level: 2, name: title });
    await app.main.evaluate(main => main.scrollBy(0, 100 * 44));
    await expect(second).toBeVisible();

    // Selection runs across the heading.
    await app.rowButton(app.row('Night One 109')).click({ modifiers: ['ControlOrMeta'] });
    await app.rowButton(app.row('Night Two 2')).click({ modifiers: ['Shift'] });
    expect(await app.main.locator('ol.tracks > li.selected .title .name').allTextContents()).toEqual(['Night One 109', 'Night One 110', 'Night Two 1', 'Night Two 2']);
    // The heading has a row of its own between the discs.
    const box = async (locator: typeof second) => (await locator.boundingBox())!;
    const before = await box(app.row('Night One 110')), head = await box(heads.filter({ hasText: title })), after = await box(app.row('Night Two 1'));
    expect(head.y).toBeGreaterThanOrEqual(before.y + before.height - 1);
    expect(after.y).toBeGreaterThanOrEqual(head.y + head.height - 1);

    // On a narrow phone the long title stays on one line inside its row; the tooltip has all of it.
    await page.setViewportSize({ width: 320, height: 780 });
    await second.scrollIntoViewIfNeeded();
    await expect(second).toHaveAttribute('title', title);
    const row = await box(heads.filter({ hasText: title })), text = await box(second);
    expect(text.y).toBeGreaterThanOrEqual(row.y - 0.5);
    expect(text.y + text.height).toBeLessThanOrEqual(row.y + row.height + 0.5);
    expect(await second.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  });
});
