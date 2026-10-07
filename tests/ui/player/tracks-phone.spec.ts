import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';

// Whether a page move's transition is still running.
const sliding = (page: Page) => page.evaluate(() => document.getAnimations().some(animation => (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition')));

// The tabs along the bottom: all six on one line, none cut off, however narrow the phone.
async function expectTabsFit(page: Page) {
  const tabs = page.getByRole('navigation', { name: 'Library' }).getByRole('button');
  await expect(tabs).toHaveText(['Records', 'Artists', 'Tracks', 'Playlists', 'Favorites', 'Genres']);
  const width = page.viewportSize()!.width;
  const boxes = await tabs.evaluateAll(buttons => buttons.map(button => {
    const box = button.getBoundingClientRect();
    return { top: Math.round(box.top), left: box.left, right: box.right, clipped: button.scrollWidth > button.clientWidth };
  }));
  expect(new Set(boxes.map(box => box.top)).size).toBe(1);
  for (const box of boxes) {
    expect(box.clipped).toBe(false);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
  }
}

test.describe('phone', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('Tracks is a tab with the Records sorts, and a tap plays a track', async ({ app, page }) => {
    await expectTabsFit(page);
    await app.section('Tracks').tap();
    await expect(app.heading).toHaveText('Tracks');
    await expect(app.section('Tracks')).toHaveAttribute('aria-current', 'page');
    const sorts = app.main.getByRole('group', { name: 'Sort tracks' });
    await expect(sorts.getByRole('button')).toHaveText(['Newest', 'A to Z', 'By artist', 'Most played', 'Recently played', 'Random', 'Top rated']);
    await sorts.getByRole('button', { name: 'Most played' }).tap();
    await expect(app.tracks()).toHaveCount(3);
    await app.rowButton(app.row('Opening 5')).tap();
    await app.expectPlaying('Opening 5');
  });

  test('a song tapped while its record is still sliding in plays on that tap', async ({ app, page }) => {
    // A slow sleeve, so the tap surely lands while it travels.
    await page.addStyleTag({ content: '::view-transition-group(sleeve) { animation-duration: 3s !important; }' });
    await app.section('Records').tap();
    await app.main.getByRole('list').first().getByRole('button', { name: /^Test Pressing/ }).tap();
    const first = app.tracks().first();
    await first.waitFor();
    // The page has faded in; the sleeve is still on its way.
    await page.waitForTimeout(300);
    expect(await sliding(page)).toBe(true);
    const title = (await first.locator('.title .name').textContent())!;
    const box = (await first.boundingBox())!;
    await page.touchscreen.tap(box.x + 100, box.y + box.height / 2);
    await app.expectPlaying(title);
  });

  test('a second tap right after opening a record goes nowhere, rather than onto a song', async ({ app, page }) => {
    await app.section('Records').tap();
    const cover = app.main.getByRole('list').first().getByRole('button', { name: /^Test Pressing/ });
    const box = (await cover.boundingBox())!;
    // A quick double tap: the second lands where the record's first songs will be drawn.
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(app.heading).toHaveText('Test Pressing');
    await page.waitForTimeout(600);
    await expect(app.deck.getByRole('heading', { level: 2 })).toHaveCount(0);
  });

  test('one tap anywhere on a song row plays it, with the record as the queue', async ({ app, page }) => {
    await app.openAlbum('Test Pressing');
    await expect.poll(() => sliding(page)).toBe(false);
    const titles = await app.titles();
    // The song's length, outside the row's button.
    await app.row('Short Stop').scrollIntoViewIfNeeded();
    const length = (await app.row('Short Stop').locator('.figure').boundingBox())!;
    await page.touchscreen.tap(length.x + length.width / 2, length.y + length.height / 2);
    await app.expectPlaying('Short Stop');
    // The row's edge, in the padding beside the number.
    await app.row('Long Run').scrollIntoViewIfNeeded();
    const row = (await app.row('Long Run').boundingBox())!;
    await page.touchscreen.tap(row.x + 3, row.y + row.height / 2);
    await app.expectPlaying('Long Run');
    await app.openQueue();
    expect(await app.titles()).toEqual(titles);
  });

  test('a tap on a song row\'s star stars it and doesn\'t play it', async ({ app }) => {
    await app.openAlbum('Test Pressing');
    await app.row('Short Stop').getByRole('button', { name: 'Add Short Stop to favorites' }).tap();
    await expect(app.row('Short Stop').getByRole('button', { name: 'Remove Short Stop from favorites' })).toBeVisible();
    await expect(app.deck.getByRole('heading', { level: 2 })).toHaveCount(0);
  });

  test('the six tabs fit a 320px screen, even with the largest theme text', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await expectTabsFit(page);
    // A theme's text size of 20px, the most it allows.
    await page.evaluate(() => document.documentElement.style.setProperty('--text', String(20 / 15)));
    await expectTabsFit(page);
    await page.setViewportSize({ width: 412, height: 860 });
    await expectTabsFit(page);
  });
});
