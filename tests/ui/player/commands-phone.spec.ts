import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';

// On a phone the palette is a bottom sheet, opened from the top bar, closed by the back gesture.
const commands = (page: Page) => page.getByRole('button', { name: 'Commands', exact: true }).filter({ visible: true });

test.describe('phone', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('the command palette is a bottom sheet that runs a command', async ({ app, page }) => {
    await commands(page).tap();
    const palette = page.getByRole('dialog', { name: 'Commands' });
    await expect(palette).toBeVisible();
    await expect(palette).toHaveClass(/\bsheet\b/);
    const viewport = page.viewportSize()!;
    await expect.poll(async () => { const box = (await palette.boundingBox())!; return Math.round(box.y + box.height); }).toBe(viewport.height);
    expect((await palette.boundingBox())!.width).toBeGreaterThanOrEqual(viewport.width - 1);
    // The keyboard stays down until the field is tapped.
    await expect(palette.getByRole('combobox')).not.toBeFocused();

    await palette.getByRole('option', { name: /^Go to playlists/ }).tap();
    await expect(palette).toBeHidden();
    await expect(app.heading).toHaveText('Playlists');
    // The sheet's history entry was used up, so Back leaves Playlists.
    await page.goBack();
    await expect(app.heading).toHaveText('Records');
  });

  test('the back gesture closes the palette sheet', async ({ app, page }) => {
    await commands(page).tap();
    const palette = page.getByRole('dialog', { name: 'Commands' });
    await expect(palette).toBeVisible();
    await page.goBack();
    await expect(palette).toBeHidden();
    await expect(app.heading).toHaveText('Records');
  });

  test('Open now playing is a phone command, and the sheet it opens hides the rest', async ({ app, page }) => {
    await app.play('Test Pressing', 'Long Run');
    await commands(page).tap();
    const palette = page.getByRole('dialog', { name: 'Commands' });
    // Nothing is highlighted on a touch screen until the keyboard is used.
    await expect(palette.locator('.palette-item[aria-selected="true"]')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await palette.getByRole('option', { name: /^Open now playing/ }).tap();
    await expect(palette).toBeHidden();
    await expect(app.deck).toHaveClass(/\bopen\b/);
    await page.goBack();
    await expect(app.deck).not.toHaveClass(/\bopen\b/);
    await expect(app.heading).toHaveText('Test Pressing');
  });
});
