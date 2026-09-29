import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';

// The tabs along the bottom: all five on one line, none cut off, however narrow the phone.
async function expectTabsFit(page: Page) {
  const tabs = page.getByRole('navigation', { name: 'Library' }).getByRole('button');
  await expect(tabs).toHaveText(['Records', 'Artists', 'Tracks', 'Playlists', 'Favorites']);
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

  test('the five tabs fit a 320px screen, even with the largest theme text', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 780 });
    await expectTabsFit(page);
    // A theme's text size of 20px, the most it allows.
    await page.evaluate(() => document.documentElement.style.setProperty('--text', String(20 / 15)));
    await expectTabsFit(page);
    await page.setViewportSize({ width: 412, height: 860 });
    await expectTabsFit(page);
  });
});
