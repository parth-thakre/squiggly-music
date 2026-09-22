import { expect, test } from '@playwright/test';

test('Ledger selects the clicked song and its duration, not the first song on its album', async ({ page }) => {
  await page.goto('/mocks-2.html?view=ledger');
  const row = page.locator('#ledger-track-0-1');
  await row.click();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.ledger-track-row[aria-selected="true"]')).toHaveCount(1);
  await expect(page.locator('#ledger-track-0-0')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('.ledger-player .mini-track strong')).toHaveText('Weather in the glass');
  await expect(page.locator('.ledger-wave .progress-times span').last()).toHaveText(await row.locator('time').innerText());
});

test('Ledger activates the row reached by Tab', async ({ page }) => {
  await page.goto('/mocks-2.html?view=ledger');
  const firstRow = page.locator('#ledger-track-0-0');
  await firstRow.focus();
  await expect(firstRow).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#ledger-track-0-1')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.ledger-player .mini-track strong')).toHaveText('Weather in the glass');
  await expect(page.locator('#ledger-track-0-1')).toHaveAttribute('aria-selected', 'true');
});

test('Bench contains its signal chain at intermediate desktop widths', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/mocks-2.html?view=bench');
  const sizes = await page.locator('.bench-chain-wrap').evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));
  expect(sizes.overflowX).toBe('auto');
  expect(sizes.scrollWidth).toBeGreaterThan(sizes.clientWidth);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
});

test('Ledger transport remains reachable in a short desktop window', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 });
  await page.goto('/mocks-2.html?view=ledger');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(500);
  const player = page.locator('.ledger-player');
  await player.scrollIntoViewIfNeeded();
  await expect(player).toBeVisible();
  await expect(player.getByRole('button', { name: 'Preview play' })).toBeVisible();
});

test('Sleeve notes keeps audio inspection reachable on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/mocks-2.html?view=sleeve-notes');
  const inspect = page.locator('.compact-signal-trigger');
  await expect(inspect).toBeVisible();
  await inspect.click();
  await expect(page.getByRole('dialog', { name: 'Audio path information' })).toBeVisible();
});

test('Ledger keyboard selection and filtering preserve the selected song', async ({ page }) => {
  await page.goto('/mocks-2.html?view=ledger');
  const table = page.getByRole('grid');
  await table.focus();
  await table.press('ArrowDown');
  await table.press('Enter');
  await expect(page.locator('.ledger-player .mini-track strong')).toHaveText('Weather in the glass');
  await page.getByRole('textbox', { name: 'Filter sample songs' }).fill('Last table open');
  await table.focus();
  await table.press('Enter');
  await expect(page.locator('.ledger-player .mini-track strong')).toHaveText('Last table open');
  await expect(page.locator('#ledger-track-2-3')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('textbox', { name: 'Filter sample songs' }).fill('');
  await expect(page.locator('#ledger-track-2-3')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.ledger-track-row[aria-selected="true"]')).toHaveCount(1);
});

test('track transport and study changes keep track identity consistent', async ({ page }) => {
  await page.goto('/mocks-2.html?view=ledger');
  await page.locator('#ledger-track-0-1').click();
  await page.getByRole('button', { name: 'Next sample track', exact: true }).click();
  await expect(page.locator('.ledger-player .mini-track strong')).toHaveText('A quieter shore');
  await expect(page.locator('#ledger-track-0-2')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Previous sample track', exact: true }).click();
  await expect(page.locator('#ledger-track-0-1')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('navigation', { name: 'UI directions' }).getByRole('button', { name: /Sleeve notes$/ }).click();
  await expect(page.locator('.bottom-player .mini-track strong')).toHaveText('Weather in the glass');
  await expect(page.getByRole('button', { name: /Weather in the glass/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Open Soft focus', exact: true }).click();
  await expect(page.locator('.bottom-player .mini-track strong')).toHaveText('Sunday, slowly');
  await expect(page.locator('.sleeve-track-select[aria-pressed="true"]')).toHaveCount(1);
});

test('Sleeve notes inline seeking works with mouse and keyboard without selecting or starting a track', async ({ page }) => {
  await page.goto('/mocks-2.html?view=sleeve-notes');
  const track = page.getByRole('button', { name: /Weather in the glass/ });
  await track.click();
  await expect(page.locator('.bottom-player .mini-track strong')).toHaveText('Weather in the glass');
  await expect(page.locator('.bottom-player .progress-times span').last()).toHaveText(await track.locator('time').innerText());
  await page.getByRole('button', { name: 'Preview pause', exact: true }).click();
  const inline = page.locator('.inline-wave').getByRole('slider');
  const footer = page.locator('.bottom-player').getByRole('slider', { name: 'Sample playback position' });
  await expect(page.locator('.sleeve-tracklist button input')).toHaveCount(0);
  await inline.click();
  await expect.poll(async () => Number(await inline.inputValue())).toBeGreaterThan(0);
  await expect(footer).toHaveValue(await inline.inputValue());
  await inline.press('End');
  await expect(inline).toHaveValue('100');
  await expect(footer).toHaveValue('100');
  await inline.press('ArrowLeft');
  await expect(inline).toHaveValue('99');
  await expect(track).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Preview play', exact: true })).toBeVisible();
});
