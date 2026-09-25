import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures/test';

// The room's --accent-text, and the ink, as the browser resolves them (rgb(...)).
const resolved = (page: Page, variable: string) => page.locator('.room').evaluate((room, name) => {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  room.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, variable);
const colorOf = (line: Locator) => line.evaluate(element => getComputedStyle(element).color);

test.describe('lyrics', () => {
  test.beforeEach(async ({ app }) => {
    await app.signIn();
    await app.play('Test Pressing', 'Lyric Line');
    await app.deck.getByRole('button', { name: 'Lyrics', exact: true }).click();
    await expect(app.main.getByRole('heading', { level: 1 })).toHaveText('Lyric Line');
  });

  test('the current synced line is in the accent text colour and advances with the song', async ({ app, page }) => {
    const current = app.main.locator('.lyric-lines li.current');
    await expect(current).toHaveText('Line 1 of the lyric');
    // The palette comes from the cover once it loads; wait until the room has taken its colours.
    await expect.poll(() => resolved(page, '--accent-text')).not.toBe('rgb(26, 26, 24)');
    const accentText = await resolved(page, '--accent-text');
    expect(accentText).not.toBe(await resolved(page, '--ink'));
    await expect.poll(() => colorOf(current)).toBe(accentText);

    await expect(current).toHaveText('Line 2 of the lyric', { timeout: 6_000 });
    await expect.poll(() => colorOf(current)).toBe(accentText);
    const past = app.main.locator('.lyric-lines li.past').first();
    await expect(past).toHaveText('Line 1 of the lyric');
    expect(await colorOf(past)).not.toBe(accentText);
    await expect(app.main.locator('.lyric-lines li.current')).toHaveCount(1);
  });

  test('clicking a line seeks to it', async ({ app }) => {
    await app.main.getByRole('button', { name: 'Line 8 of the lyric' }).click();
    await expect(app.main.locator('.lyric-lines li.current')).toHaveText('Line 8 of the lyric');
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(21);
    expect(await app.seconds()).toBeLessThan(26);
    await expect(app.seek).toHaveAttribute('aria-valuetext', /^0:2\d of 0:30$/);
    await app.expectPlaying('Lyric Line');
  });

  test('clicking a line while paused seeks and plays', async ({ app }) => {
    await app.pause();
    await app.main.getByRole('button', { name: 'Line 5 of the lyric' }).click();
    await expect(app.main.locator('.lyric-lines li.current')).toHaveText('Line 5 of the lyric');
    await app.expectPlaying('Lyric Line');
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(13);
  });
});
