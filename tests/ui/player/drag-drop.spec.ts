import type { Locator, Page } from '@playwright/test';
import { installDesktopBridge } from '../fixtures/desktop';
import { escape, expect, playlistIds, test, trackOf, type App } from '../fixtures/test';

// Drag and drop (drag.ts), dispatched as the browser does it: dragstart on the source, then
// dragenter, dragover, and drop on the target, all carrying one DataTransfer. It waits on window
// between steps, so a drag can start on one page and land on another as the test navigates.
type Dragging = Window & { dragData?: DataTransfer };
async function dragStart(source: Locator) {
  await source.evaluate(element => {
    const data = new DataTransfer();
    (window as Dragging).dragData = data;
    element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
}
async function dragOver(target: Locator) {
  await target.evaluate(element => {
    const dataTransfer = (window as Dragging).dragData!;
    for (const type of ['dragenter', 'dragover']) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
  });
}
async function drop(target: Locator) {
  await target.evaluate(element => {
    const dataTransfer = (window as Dragging).dragData!;
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    document.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
  });
}
// Files from the computer, as the system hands them to a drop.
async function dropFiles(page: Page, names: string[], shiftKey = false) {
  return page.evaluate(({ names, shiftKey }) => {
    const dataTransfer = new DataTransfer();
    for (const name of names) dataTransfer.items.add(new File(['x'], name, { type: 'audio/flac' }));
    const target = document.querySelector('main.page')!;
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
    target.dispatchEvent(over);
    const dropped = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, shiftKey });
    target.dispatchEvent(dropped);
    return { overTaken: over.defaultPrevented, dropTaken: dropped.defaultPrevented, effect: dataTransfer.dropEffect };
  }, { names, shiftKey });
}

const sleeve = (app: App, name: string) => app.main.getByRole('list').first().getByRole('button', { name: new RegExp(`^${escape(name)}`) });
const playlistRow = (app: App, name: string) => app.main.locator('ul.rows > li').filter({ has: app.page.getByRole('button', { name: new RegExp(`^${escape(name)}`) }) });
const queueButton = (app: App) => app.deck.getByRole('button', { name: 'Queue', exact: true });
const notice = (app: App) => app.page.locator('.extension-notice');
const amber = ['Opening 3', 'Second Wind 3', 'Middle Distance 3'];
const record = ['Long Run', 'Lyric Line', 'Short Stop', 'Thirty Two', 'Tail Light'];

test.describe('drag and drop', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('a sleeve dropped on the Queue button joins the end, and one dropped on a queued song goes before it', async ({ app }) => {
    await app.play('Test Pressing', 'Long Run');
    await app.section('Records').click();
    await dragStart(sleeve(app, 'Amber Field'));
    await dragOver(queueButton(app));
    await expect(queueButton(app)).toHaveClass(/\bdrop-over\b/);
    await drop(queueButton(app));
    await expect(queueButton(app)).not.toHaveClass(/\bdrop-over\b/);
    await expect(notice(app)).toContainText('Added 3 songs to the queue.');
    await app.openQueue();
    await expect.poll(() => app.titles()).toEqual([...record, ...amber]);

    // Onto a row: before it, with the reorder line showing where.
    await app.section('Records').click();
    await dragStart(sleeve(app, 'Amber Field'));
    await queueButton(app).click();
    await expect(app.heading).toHaveText('Queue');
    const target = app.row('Short Stop');
    await dragOver(target);
    await expect(target).toHaveClass(/\bdrop-before\b/);
    await drop(target);
    await expect.poll(() => app.titles()).toEqual(['Long Run', 'Lyric Line', ...amber, 'Short Stop', 'Thirty Two', 'Tail Light', ...amber]);
    await expect(app.tracks().nth(0)).toHaveClass(/\bnow\b/);
    await app.expectPlaying('Long Run');
  });

  test('with the mouse, a sleeve drags onto the Queue button and queued songs still drag to reorder', async ({ app }) => {
    await app.play('Test Pressing', 'Long Run');
    await app.section('Records').click();
    await sleeve(app, 'Amber Field').dragTo(queueButton(app));
    await app.openQueue();
    await expect.poll(() => app.titles()).toEqual([...record, ...amber]);
    await app.row('Tail Light').dragTo(app.row('Lyric Line'));
    await expect.poll(() => app.titles()).toEqual(['Long Run', 'Tail Light', 'Lyric Line', 'Short Stop', 'Thirty Two', ...amber]);
  });

  test('the queue’s own reorder drag doesn’t light up the Queue button', async ({ app }) => {
    await app.play('Test Pressing', 'Long Run');
    await app.openQueue();
    await dragStart(app.row('Short Stop'));
    await dragOver(queueButton(app));
    await expect(queueButton(app)).not.toHaveClass(/\bdrop-over\b/);
    await expect(app.main.locator('.drop-area')).not.toHaveClass(/\bdrop-over\b/);
    await drop(queueButton(app));
    expect(await app.titles()).toEqual(record);
  });

  test('selected songs dropped on a playlist row are added to it, with a note', async ({ app, fake }) => {
    await app.openAlbum('Quiet Harbor');
    await app.rowButton(app.row('Opening 2')).click({ modifiers: ['ControlOrMeta'] });
    await app.rowButton(app.row('Coda 2')).click({ modifiers: ['ControlOrMeta'] });
    await dragStart(app.row('Coda 2'));
    await app.section('Playlists').click();
    await expect(app.heading).toHaveText('Playlists');
    const road = playlistRow(app, 'Road Mix');
    await dragOver(road);
    await expect(road).toHaveClass(/\bdrop-over\b/);
    await drop(road);
    await expect(notice(app)).toContainText('Added 2 songs to Road Mix.');
    await expect(road).not.toHaveClass(/\bdrop-over\b/);
    await expect.poll(() => fake.playlist(playlistIds.road)?.trackIds).toEqual(['tr-2-1', 'tr-2-2', 'tr-3-1', 'tr-2-1', 'tr-3-2', 'tr-2-1', 'tr-2-5']);
    await expect(road).toContainText('7 songs');
  });

  test('a sleeve dropped into an open playlist lands where it was dropped', async ({ app, fake }) => {
    await app.section('Records').click();
    await dragStart(sleeve(app, 'Amber Field'));
    await app.openPlaylist('Road Mix');
    const target = app.tracks().nth(1);
    await dragOver(target);
    await expect(target).toHaveClass(/\bdrop-before\b/);
    await drop(target);
    const expected = ['tr-2-1', 'tr-3-1', 'tr-3-2', 'tr-3-3', 'tr-2-2', 'tr-3-1', 'tr-2-1', 'tr-3-2'];
    await expect.poll(() => app.titles()).toEqual(expected.map(id => trackOf(id).title));
    await expect.poll(() => fake.playlist(playlistIds.road)?.trackIds).toEqual(expected);
    await expect(app.main.getByText('Saving changes')).toHaveCount(0);
    await expect(notice(app)).toContainText('Added 3 songs to Road Mix.');
  });

  test('a playlist the server manages refuses a drop and says why', async ({ app, fake }) => {
    await app.section('Records').click();
    await dragStart(sleeve(app, 'Amber Field'));
    await app.section('Playlists').click();
    const picks = playlistRow(app, 'Server Picks');
    await dragOver(picks);
    await expect(picks).not.toHaveClass(/\bdrop-over\b/);
    await drop(picks);
    await expect(notice(app)).toContainText('Songs can’t be added to Server Picks. Managed by the server.');
    await expect(notice(app)).toHaveCount(1);
    expect(fake.callsTo('addToPlaylist')).toEqual([]);
    expect(fake.playlist(playlistIds.readonly)?.trackIds).toEqual(['tr-4-1', 'tr-4-2', 'tr-5-1']);
  });

  test('the browser build ignores files dropped from the computer', async ({ app, page }) => {
    const url = page.url();
    const result = await dropFiles(page, ['a.flac']);
    // Taken, so the browser doesn't open the file in place of the app, but refused.
    expect(result).toEqual({ overTaken: true, dropTaken: true, effect: 'none' });
    expect(page.url()).toBe(url);
    await expect(app.heading).toHaveText('Records');
  });
});

test.describe('files dropped on the desktop window', () => {
  test.beforeEach(async ({ page }) => { await installDesktopBridge(page); });

  const calls = (page: Page) => page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls);
  test('go to the preload as the Files themselves, to play', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.deck')).toBeVisible();
    const result = await dropFiles(page, ['a.flac', 'b.mp3'], true);
    expect(result.dropTaken).toBe(true);
    await expect.poll(() => calls(page)).toContain('open-dropped:2:["a.flac","b.mp3"]:play');
  });

  test('more than a full queue go on whole, to be refused, not cut short', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.deck')).toBeVisible();
    await dropFiles(page, Array.from({ length: 1001 }, (_, i) => `${i + 1}.flac`));
    await expect.poll(() => calls(page)).toContain('open-dropped:1001:["1.flac","2.flac","3.flac"]:play');
    await expect(page.getByRole('alert')).toContainText('Drop up to 1,000 files at a time.');
  });
});
