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
});
