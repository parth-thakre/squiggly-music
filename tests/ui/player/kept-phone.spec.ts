import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test, trackOf } from '../fixtures/test';

// The Kept page and the out-of-reach notice on a phone-sized window: accessible, and nothing
// wider than the screen.
async function violations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(node => node.target.join(' ')).join(', ')}`);
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test('the Kept page and the notice fit a phone and pass axe', async ({ page, app }) => {
  const tracks = ['tr-1-1', 'tr-1-2', 'tr-1-3', 'tr-1-4', 'tr-1-5'].map(trackOf);
  await installDesktopBridge(page, { server: true, away: true, kept: { seed: [
    { kind: 'album', id: 'al-1', name: 'Test Pressing', artist: 'Ada Brass', coverArt: 'al-1', tracks },
    { kind: 'playlist', id: 'pl-road', name: 'Road Mix', artist: null, coverArt: 'al-2', tracks: tracks.slice(0, 2) },
  ] } });
  const response = await page.request.post('/api/session', { data: { password: 'squiggly test password' }, headers: { origin: app.url } });
  expect(response.status()).toBe(200);
  await page.goto('/');
  await expect(app.heading).toHaveText('Kept');
  // Short lines: the totals, one line for the server, and who and how many for each record.
  await expect(app.main.locator('.head .byline')).toHaveText('5 songs, 5 MB of 4 GB');
  await expect(app.main.getByRole('status').filter({ hasText: /^Server out of reach since \d/ })).toBeVisible();
  const notice = app.main.locator('.offline-line');
  await expect(notice.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(await notice.evaluate(line => Math.round(line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight)))).toBe(1);
  const pressing = app.main.getByRole('button', { name: /^Test Pressing/ });
  // As shown: the size is left to wider screens.
  expect(await pressing.locator('.row-sub').innerText()).toBe('Ada Brass, 5 songs');
  expect(await app.main.getByRole('button', { name: /^Road Mix/ }).locator('.row-sub').innerText()).toBe('2 songs');
  await pressing.click();
  await expect(app.row('Long Run')).toBeVisible();
  // Everything here is kept, so no song carries the mark.
  await expect(app.main.locator('ol.tracks .kept-mark')).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await violations(page), 'Kept').toEqual([]);
  await app.section('Artists').click();
  await expect(app.heading).toHaveText('Your server is out of reach');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(await violations(page), 'notice').toEqual([]);
});
