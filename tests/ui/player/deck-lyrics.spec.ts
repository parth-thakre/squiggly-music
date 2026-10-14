import { expect, test } from '../fixtures/test';

// The deck's lyrics (lyrics.tsx, DeckLyrics): the synced lines in the room under the controls,
// following the song, gone while the lyric sheet is open or without room.
test.describe('lyrics in the deck', () => {
  test('follow the song in the spare room, open the sheet, and step aside for it', async ({ app, page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await app.signIn();
    await app.play('Test Pressing', 'Lyric Line');
    const peek = app.deck.getByRole('button', { name: 'Open the lyrics' });
    await expect(peek).toBeVisible();
    await expect(peek.locator('li.current')).toHaveText('Line 1 of the lyric');
    await expect(peek.locator('li.current')).toHaveText('Line 2 of the lyric', { timeout: 6_000 });
    // The current line sits inside the room, not cut off by it.
    const room = (await peek.boundingBox())!, line = (await peek.locator('li.current').boundingBox())!;
    expect(line.y).toBeGreaterThan(room.y);
    expect(line.y + line.height).toBeLessThan(room.y + room.height);
    // The links stay at the foot of the deck, below the lyrics.
    expect((await app.deck.locator('.deck-links').boundingBox())!.y).toBeGreaterThanOrEqual(room.y + room.height);
    await page.screenshot({ path: test.info().outputPath('deck-lyrics.png') });
    await peek.click();
    await expect(app.main.getByRole('heading', { level: 1 })).toHaveText('Lyric Line');
    await expect(peek).toHaveCount(0);
  });

  test('take no room the deck hasn\'t got', async ({ app, page }) => {
    await page.setViewportSize({ width: 1280, height: 640 });
    await app.signIn();
    await app.play('Test Pressing', 'Lyric Line');
    await expect(app.deck.locator('.deck-lyrics')).toHaveClass(/no-room/);
    await expect(app.deck.getByRole('button', { name: 'Open the lyrics' })).toBeHidden();
    // The deck doesn't scroll for them.
    expect(await app.deck.evaluate(deck => deck.scrollHeight - deck.clientHeight)).toBeLessThanOrEqual(await app.deck.evaluate(deck => {
      const peek = deck.querySelector<HTMLElement>('.deck-lyrics')!; peek.style.display = 'none';
      const overflow = deck.scrollHeight - deck.clientHeight; peek.style.display = ''; return overflow;
    }));
  });
});
