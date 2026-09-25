import { expect, test } from '../fixtures/test';

// Playing "Long Run" from its record queues the whole record from there:
// Long Run (45 s, playing), Lyric Line, Short Stop, Thirty Two, Tail Light.
const album = ['Long Run', 'Lyric Line', 'Short Stop', 'Thirty Two', 'Tail Light'];

test.describe('queue', () => {
  test.beforeEach(async ({ app }) => {
    await app.signIn();
    await app.play('Test Pressing', 'Long Run');
  });

  test('Add to queue and Play next from the right-click menu show up in the queue', async ({ app }) => {
    await app.chooseFromMenu(app.row('Tail Light'), 'Play next');
    await expect(app.deck.getByText('Next:')).toContainText('Tail Light');
    await app.chooseFromMenu(app.row('Short Stop'), 'Add to queue');
    await app.openQueue();
    expect(await app.titles()).toEqual(['Long Run', 'Tail Light', 'Lyric Line', 'Short Stop', 'Thirty Two', 'Tail Light', 'Short Stop']);
    await expect(app.tracks().nth(0)).toHaveClass(/\bnow\b/);
    await expect(app.main.getByText('6 songs up next')).toBeVisible();
  });

  test('Alt+ArrowDown moves the focused song and focus follows it', async ({ app, page }) => {
    await app.openQueue();
    const lyric = app.rowButton(app.row('Lyric Line'));
    await lyric.focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => app.titles()).toEqual(['Long Run', 'Short Stop', 'Lyric Line', 'Thirty Two', 'Tail Light']);
    await expect(app.tracks().nth(2).locator('button.track')).toBeFocused();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => app.titles()).toEqual(['Long Run', 'Short Stop', 'Thirty Two', 'Lyric Line', 'Tail Light']);
    await expect(app.tracks().nth(3).locator('button.track')).toBeFocused();
    await expect(app.main.getByText('Moved Lyric Line to position 4 of 5.')).toBeAttached();
    // Moving songs around it leaves the playing song playing.
    await expect(app.tracks().nth(0)).toHaveClass(/\bnow\b/);
    await app.expectPlaying('Long Run');
  });

  test('Delete removes a selected song that is not playing, and never the playing one', async ({ app, page }) => {
    await app.openQueue();
    await app.rowButton(app.row('Short Stop')).click({ modifiers: ['ControlOrMeta'] });
    await expect(app.row('Short Stop')).toHaveClass(/\bselected\b/);
    await page.keyboard.press('Delete');
    await expect.poll(() => app.titles()).toEqual(['Long Run', 'Lyric Line', 'Thirty Two', 'Tail Light']);

    await app.rowButton(app.row('Long Run')).click({ modifiers: ['ControlOrMeta'] });
    await page.keyboard.press('Delete');
    await expect.poll(() => app.titles()).toEqual(['Long Run', 'Lyric Line', 'Thirty Two', 'Tail Light']);
    await app.expectPlaying('Long Run');
  });

  test('with a song queued twice, clicking the second copy plays that copy', async ({ app }) => {
    await app.chooseFromMenu(app.row('Tail Light'), 'Add to queue');
    await app.openQueue();
    expect(await app.titles()).toEqual([...album, 'Tail Light']);
    await app.rowButton(app.tracks().nth(5)).click();
    await app.expectPlaying('Tail Light');
    await expect(app.tracks().nth(5)).toHaveClass(/\bnow\b/);
    await expect(app.tracks().nth(4)).not.toHaveClass(/\bnow\b/);
    await expect(app.main.getByText('This is the last song.')).toBeVisible();

    await app.rowButton(app.tracks().nth(4)).click();
    await expect(app.tracks().nth(4)).toHaveClass(/\bnow\b/);
    await expect(app.tracks().nth(5)).not.toHaveClass(/\bnow\b/);
    await expect(app.main.getByText('1 song up next')).toBeVisible();
  });

  test('a selection survives position updates while a song plays', async ({ app }) => {
    await app.openQueue();
    await app.rowButton(app.row('Thirty Two')).click({ modifiers: ['ControlOrMeta'] });
    await app.rowButton(app.row('Lyric Line')).click({ modifiers: ['ControlOrMeta'] });
    const start = await app.seconds();
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(start + 2);
    await expect(app.row('Thirty Two')).toHaveClass(/\bselected\b/);
    await expect(app.row('Lyric Line')).toHaveClass(/\bselected\b/);
    await expect(app.rowButton(app.row('Thirty Two'))).toHaveAttribute('aria-pressed', 'true');
    await expect(app.rowButton(app.row('Short Stop'))).toHaveAttribute('aria-pressed', 'false');
  });
});
