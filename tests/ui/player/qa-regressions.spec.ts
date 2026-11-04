import { expect, test } from '../fixtures/test';

// Regressions from the exploratory QA pass on 25 September 2026.
test.describe('QA regressions', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('phones list artists in a single column', async ({ app, page }, info) => {
    test.skip(info.project.name !== 'phone', 'phone layout');
    await page.locator('.sections').getByRole('button', { name: 'Artists' }).tap();
    const rows = app.main.locator('.artist-list .name-row');
    await expect(rows.first()).toBeVisible();
    // Every row holds exactly one artist, and names have the full width to themselves.
    for (const row of await rows.all()) await expect(row.locator('li')).toHaveCount(1);
    const list = (await app.main.locator('.artist-list').boundingBox())!;
    const slot = (await rows.first().locator('li').first().boundingBox())!;
    expect(slot.width).toBeGreaterThan(list.width * .6);
  });

  test('the back gesture closes a phone menu sheet before leaving the page', async ({ app, page }, info) => {
    test.skip(info.project.name !== 'phone', 'phone layout');
    await app.openAlbum('Test Pressing');
    await app.main.getByRole('button', { name: 'More' }).tap();
    await expect(app.menu).toBeVisible();
    await page.goBack();
    await expect(app.menu).toBeHidden();
    await expect(app.heading).toHaveText('Test Pressing');
  });

  test('an action chosen from a phone menu sheet navigates, and Back returns', async ({ app, page }, info) => {
    test.skip(info.project.name !== 'phone', 'phone layout');
    await app.openAlbum('Test Pressing');
    await app.main.getByRole('button', { name: 'More' }).tap();
    await app.menu.getByRole('menuitem', { name: 'Go to artist' }).tap();
    await expect(app.menu).toBeHidden();
    await expect(app.heading).not.toHaveText('Test Pressing');
    await page.goBack();
    await expect(app.heading).toHaveText('Test Pressing');
  });

  test('radio says it is finding songs while the server works', async ({ app, fake }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop layout');
    fake.delay('similarSongs', 1500);
    await app.openAlbum('Test Pressing');
    await app.main.getByRole('button', { name: 'Radio' }).click();
    await expect(app.deck.getByRole('status')).toHaveText(/Finding songs like Test Pressing/);
    await expect(app.deck.getByText(/Radio from Test Pressing/)).toBeVisible({ timeout: 10_000 });
    await expect(app.deck.getByRole('status')).toBeHidden();
  });

  test('the squiggle is a wave from the first second', async ({ app, page }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop layout');
    await app.play('Test Pressing', 'Long Run');
    await app.pause();
    await page.locator('.deck .squiggle-rail input').first().evaluate((input: HTMLInputElement) => {
      input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Sample the canvas: a flat line has one ink row; a wave spans several.
    const rows = await page.locator('.deck .squiggle-rail canvas').first().evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d')!;
      const { width, height } = canvas;
      const data = context.getImageData(0, 0, Math.min(width, Math.round(24 * devicePixelRatio)), height).data;
      const inked = new Set<number>();
      for (let y = 0; y < height; y++) for (let x = 0; x < Math.min(width, Math.round(24 * devicePixelRatio)); x++) {
        if (data[(y * Math.min(width, Math.round(24 * devicePixelRatio)) + x) * 4 + 3] > 128) inked.add(y);
      }
      return inked.size;
    });
    expect(rows).toBeGreaterThan(6 * (await page.evaluate(() => devicePixelRatio)));
  });
});
