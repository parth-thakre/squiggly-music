import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test, trackOf } from '../fixtures/test';

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
    await expect(app.upNext).toContainText('Tail Light');
    await app.chooseFromMenu(app.row('Short Stop'), 'Add to queue');
    await app.openQueue();
    expect(await app.titles()).toEqual(['Long Run', 'Tail Light', 'Lyric Line', 'Short Stop', 'Thirty Two', 'Tail Light', 'Short Stop']);
    await expect(app.tracks().nth(0)).toHaveClass(/\bnow\b/);
    await expect(app.main.getByText('6 songs to come')).toBeVisible();
  });

  test('Alt+ArrowDown moves the focused song and focus follows it', async ({ app, page }) => {
    await app.openQueue();
    const lyric = app.rowButton(app.row('Lyric Line'));
    await lyric.focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => app.titles()).toEqual(['Long Run', 'Short Stop', 'Lyric Line', 'Thirty Two', 'Tail Light']);
    await expect(app.tracks().nth(2).locator('button.track-play')).toBeFocused();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => app.titles()).toEqual(['Long Run', 'Short Stop', 'Thirty Two', 'Lyric Line', 'Tail Light']);
    await expect(app.tracks().nth(3).locator('button.track-play')).toBeFocused();
    await expect(app.main.getByText('Moved Lyric Line to position 4 of 5.')).toBeAttached();
    // Moving songs around it leaves the playing song playing.
    await expect(app.tracks().nth(0)).toHaveClass(/\bnow\b/);
    await app.expectPlaying('Long Run');
  });

  test('Delete removes a selected song that is not playing, and never the playing one', async ({ app, page }) => {
    await app.openQueue();
    // The playing song heads the page; its row stays in the list, out of sight.
    await expect(app.main.getByRole('heading', { level: 2, name: 'Long Run' })).toBeVisible();
    await expect(app.row('Long Run')).toBeHidden();
    await app.rowButton(app.row('Short Stop')).click({ modifiers: ['ControlOrMeta'] });
    await expect(app.row('Short Stop')).toHaveClass(/\bselected\b/);
    await page.keyboard.press('Delete');
    await expect.poll(() => app.titles()).toEqual(['Long Run', 'Lyric Line', 'Thirty Two', 'Tail Light']);

    // Everything selected, the playing song with it: Delete leaves only the playing song.
    await app.rowButton(app.row('Lyric Line')).focus();
    await page.keyboard.press('ControlOrMeta+a');
    await expect(app.row('Thirty Two')).toHaveClass(/\bselected\b/);
    await page.keyboard.press('Delete');
    await expect.poll(() => app.titles()).toEqual(['Long Run']);
    await app.expectPlaying('Long Run');
    await expect(app.main.getByText('This is the last song.')).toBeVisible();
  });

  test('with a song queued twice, clicking the second copy plays that copy', async ({ app }) => {
    await app.chooseFromMenu(app.row('Tail Light'), 'Add to queue');
    await app.openQueue();
    expect(await app.titles()).toEqual([...album, 'Tail Light']);
    await app.rowButton(app.tracks().nth(5)).click();
    await app.expectPlaying('Tail Light');
    await expect(app.tracks().nth(5)).toHaveClass(/\bnow\b/);
    await expect(app.tracks().nth(4)).not.toHaveClass(/\bnow\b/);

    // The first copy has played, so it is folded away until asked for; the playing copy heads the page.
    await expect(app.tracks().nth(4)).toBeHidden();
    await expect(app.tracks().nth(5)).toBeHidden();
    await app.main.getByRole('button', { name: 'Show played' }).click();
    await expect(app.main.getByRole('button', { name: 'Hide played' })).toHaveAttribute('aria-expanded', 'true');
    await expect(app.tracks().nth(5)).toBeVisible();
    await app.rowButton(app.tracks().nth(4)).click();
    await expect(app.tracks().nth(4)).toHaveClass(/\bnow\b/);
    await expect(app.tracks().nth(5)).not.toHaveClass(/\bnow\b/);
    await expect(app.main.getByText('1 song to come')).toBeVisible();
  });

  test('radio from the playing song keeps it playing, with the station after it', async ({ app }) => {
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(2);
    const before = await app.seconds();
    await app.chooseFromMenu(app.row('Long Run'), 'Start radio');
    await expect(app.deck.getByText(/Radio from Long Run/)).toBeVisible();
    await app.expectPlaying('Long Run');
    expect(await app.seconds()).toBeGreaterThanOrEqual(before);
    await app.openQueue();
    await expect(app.tracks().nth(0)).toHaveClass(/\bnow\b/);
    const titles = await app.titles();
    expect(titles[0]).toBe('Long Run');
    expect(titles.length).toBeGreaterThan(1);
    // The rest of the record made way for the station.
    expect(titles.slice(1)).not.toContain('Lyric Line');
    expect(await app.seconds()).toBeGreaterThanOrEqual(before);
  });

  test('the playing song moves from its heading\'s menu and with Alt and the arrows, as its row would', async ({ app, page }) => {
    await app.openQueue();
    const now = app.main.locator('header.queue-now');
    // First in the queue: it can go down, not up.
    await app.openMenuOn(now);
    await expect(app.menu.getByRole('menuitem', { name: 'Move up', exact: true })).toHaveCount(0);
    await app.menu.getByRole('menuitem', { name: 'Move down', exact: true }).click();
    await expect.poll(() => app.titles()).toEqual(['Lyric Line', 'Long Run', 'Short Stop', 'Thirty Two', 'Tail Light']);
    await app.expectPlaying('Long Run');
    await now.getByRole('button', { name: 'Long Run' }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => app.titles()).toEqual(['Lyric Line', 'Short Stop', 'Long Run', 'Thirty Two', 'Tail Light']);
    await page.keyboard.press('Alt+ArrowUp');
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => app.titles()).toEqual(['Long Run', 'Lyric Line', 'Short Stop', 'Thirty Two', 'Tail Light']);
    await app.expectPlaying('Long Run');
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

// Stopped with songs still queued (the desktop's engine at the end of a queue, or before one
// starts): the queue lists them all, with no song at its head.
test('a stopped queue still lists its songs, with its count and actions', async ({ page }) => {
  await installDesktopBridge(page, { commands: true, player: {
    queue: [trackOf('tr-1-1'), trackOf('tr-1-2'), trackOf('tr-2-1')], entryIds: ['e1', 'e2', 'e3'], currentIndex: -1, playing: false,
  } });
  await page.goto('/');
  await page.locator('main').focus();
  await page.keyboard.press('g');
  await page.keyboard.press('q');
  const main = page.locator('main');
  await expect(main.locator('ol.tracks > li[data-index]')).toHaveCount(3);
  await expect(main).not.toContainText('Nothing queued.');
  await expect(main.locator('header.queue-now')).toHaveCount(0);
  // Two songs from one record share a heading; a song alone from another has none.
  await expect(main.locator('li.group-record .queue-record-name')).toHaveText(['Test Pressing']);
  await expect(main.getByText('3 songs to come')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Save as playlist' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Clear' })).toBeEnabled();
});
