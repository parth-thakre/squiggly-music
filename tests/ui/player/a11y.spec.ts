import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';

// An axe-core smoke check (WCAG 2.x A and AA rules) of the main screens, on desktop and phone.
async function violations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(node => node.target.join(' ')).join(', ')}`);
}

test.describe('accessibility smoke', () => {
  test('sign-in screen', async ({ page, app }) => {
    await page.goto('/');
    await expect(app.signInPassword).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('library, record, playlist, queue, lyrics, and settings with a song playing', async ({ page, app }) => {
    await app.signIn();
    await expect(app.main.locator('ul.grid img').first()).toBeVisible();
    expect(await violations(page), 'Records').toEqual([]);

    await app.play('Test Pressing', 'Lyric Line');
    await app.pause();
    expect(await violations(page), 'record page, deck').toEqual([]);

    await app.openPlaylist('Road Mix');
    expect(await violations(page), 'playlist').toEqual([]);

    await app.openQueue();
    expect(await violations(page), 'queue').toEqual([]);

    await app.openLyrics();
    expect(await violations(page), 'lyrics').toEqual([]);

    await app.openSettings();
    expect(await violations(page), 'settings').toEqual([]);
  });

  test('an open menu', async ({ page, app }) => {
    await app.signIn();
    await app.openAlbum('Test Pressing');
    await app.rowButton(app.row('Short Stop')).dispatchEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 });
    await expect(app.menu.getByRole('menuitem').first()).toBeFocused();
    expect(await violations(page)).toEqual([]);
  });
});
