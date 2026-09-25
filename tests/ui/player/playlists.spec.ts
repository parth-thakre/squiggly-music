import { expect, playlistIds, test, trackOf, type App } from '../fixtures/test';
import type { FakeNavidrome } from '../fixtures/library';

// Road Mix on the server: Opening 2, Second Wind 2, Opening 3, Opening 2 (again), Second Wind 3.
const road = ['tr-2-1', 'tr-2-2', 'tr-3-1', 'tr-2-1', 'tr-3-2'];
const titlesOf = (ids: string[]) => ids.map(id => trackOf(id).title);
const serverTracks = (fake: FakeNavidrome, id: string = playlistIds.road) => () => fake.playlist(id)?.trackIds;

// The page shows the edit at once, the server ends up with the same list, and nothing is still saving.
async function settled(app: App, fake: FakeNavidrome, ids: string[]) {
  await expect.poll(() => app.titles()).toEqual(titlesOf(ids));
  await expect.poll(serverTracks(fake)).toEqual(ids);
  await expect(app.main.getByText('Saving changes')).toHaveCount(0);
}

test.describe('playlists', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('New playlist takes a name and opens the new playlist', async ({ app, page, fake }) => {
    await app.section('Playlists').click();
    await app.main.getByRole('button', { name: 'New playlist' }).click();
    const name = app.main.getByRole('textbox', { name: 'New playlist name' });
    await expect(name).toBeFocused();
    await page.keyboard.type('Night Drive');
    await page.keyboard.press('Enter');
    await expect(app.heading).toHaveText('Night Drive');
    await expect(app.main.getByText('This playlist is empty.')).toBeVisible();
    expect(fake.playlists.map(p => p.name)).toContain('Night Drive');
  });

  test('Rename edits the name in place and on the server', async ({ app, page, fake }) => {
    await app.openPlaylist('Road Mix');
    await app.main.getByRole('button', { name: 'Rename' }).click();
    const field = app.main.getByRole('textbox', { name: 'Playlist name' });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('Road Mix');
    await field.fill('Road Mix Deluxe');
    await page.keyboard.press('Enter');
    await expect(app.heading).toHaveText('Road Mix Deluxe');
    await expect.poll(() => fake.playlist(playlistIds.road)?.name).toBe('Road Mix Deluxe');
    await expect(app.main.getByRole('button', { name: 'Rename' })).toBeFocused();
  });

  test('Add to playlist from a song menu adds it, and the open playlist shows it', async ({ app, fake }) => {
    await app.openPlaylist('Road Mix');
    expect(await app.titles()).toEqual(titlesOf(road));
    await app.openAlbum('Quiet Harbor');
    await app.chooseFromMenu(app.row('Coda 2'), 'Add to playlist', 'Road Mix');
    await expect.poll(serverTracks(fake)).toEqual([...road, 'tr-2-5']);
    // The playlist page read before the edit must not come back stale.
    await app.openPlaylist('Road Mix');
    await expect.poll(() => app.titles()).toEqual(titlesOf([...road, 'tr-2-5']));
  });

  test('Remove from this playlist removes the copy that was chosen', async ({ app, fake }) => {
    await app.openPlaylist('Road Mix');
    await app.chooseFromMenu(app.tracks().nth(3), 'Remove from this playlist');
    await settled(app, fake, ['tr-2-1', 'tr-2-2', 'tr-3-1', 'tr-3-2']);
    expect(fake.callsTo('removeFromPlaylist').map(call => call.args[1])).toEqual([[3]]);
  });

  test('Alt+ArrowUp reorders by keyboard and focus follows the song', async ({ app, page, fake }) => {
    await app.openPlaylist('Road Mix');
    await app.rowButton(app.row('Opening 3')).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await settled(app, fake, ['tr-2-1', 'tr-3-1', 'tr-2-2', 'tr-2-1', 'tr-3-2']);
    await expect(app.tracks().nth(1).locator('button.track')).toBeFocused();
    await page.keyboard.press('Alt+ArrowUp');
    await settled(app, fake, ['tr-3-1', 'tr-2-1', 'tr-2-2', 'tr-2-1', 'tr-3-2']);
    await expect(app.tracks().nth(0).locator('button.track')).toBeFocused();
  });

  test('Move up from the menu reorders without dragging', async ({ app, fake }) => {
    await app.openPlaylist('Road Mix');
    await app.chooseFromMenu(app.row('Second Wind 3'), 'Move up');
    await settled(app, fake, ['tr-2-1', 'tr-2-2', 'tr-3-1', 'tr-3-2', 'tr-2-1']);
    await app.chooseFromMenu(app.row('Second Wind 3'), 'Move to top');
    await settled(app, fake, ['tr-3-2', 'tr-2-1', 'tr-2-2', 'tr-3-1', 'tr-2-1']);
  });

  test('rapid edits, with the server answering slowly and out of order, end in the right server state', async ({ app, page, fake }) => {
    // The first removal takes 900 ms on the server, the second answers at once, and the
    // reorder takes 400 ms. Sent together, the second removal would land first and remove
    // the wrong song; the page must send them one at a time, each against the server's list.
    fake.delay('removeFromPlaylist', 900, 0);
    fake.delay('reorderPlaylist', 400);
    await app.openPlaylist('Road Mix');

    await app.rowButton(app.row('Second Wind 2')).click({ modifiers: ['ControlOrMeta'] });
    await page.keyboard.press('Delete');
    await app.rowButton(app.row('Second Wind 3')).click({ modifiers: ['ControlOrMeta'] });
    await page.keyboard.press('Delete');
    await app.rowButton(app.row('Opening 3')).focus();
    await page.keyboard.press('Alt+ArrowUp');
    // All three show at once, while the first is still on its way.
    await expect.poll(() => app.titles()).toEqual(titlesOf(['tr-3-1', 'tr-2-1', 'tr-2-1']));
    expect(fake.playlist(playlistIds.road)?.trackIds).toEqual(road);

    await settled(app, fake, ['tr-3-1', 'tr-2-1', 'tr-2-1']);
    // Each removal named the song's position on the server at the time it was sent.
    expect(fake.callsTo('removeFromPlaylist').map(call => call.args[1])).toEqual([[1], [3]]);
    expect(fake.callsTo('reorderPlaylist').map(call => call.args[1])).toEqual([['tr-3-1', 'tr-2-1', 'tr-2-1']]);
    // A fresh load shows what the server holds.
    await page.reload();
    await expect(app.heading).toHaveText('Road Mix');
    await expect.poll(() => app.titles()).toEqual(titlesOf(['tr-3-1', 'tr-2-1', 'tr-2-1']));
  });

  test('a read-only playlist offers no editing', async ({ app, page, fake }) => {
    await app.openPlaylist('Server Picks');
    await expect(app.main.getByText('Managed by the server.')).toBeVisible();
    await expect(app.main.getByRole('button', { name: 'Rename' })).toHaveCount(0);
    await expect(app.main.getByText(/press Alt\+Up and Alt\+Down/)).toHaveCount(0);

    await app.openMenuOn(app.tracks().nth(1));
    await expect(app.menu.getByRole('menuitem', { name: 'Play', exact: true })).toBeVisible();
    for (const name of ['Remove from this playlist', 'Move up', 'Move down', 'Move to top', 'Move to bottom']) {
      await expect(app.menu.getByRole('menuitem', { name, exact: true })).toHaveCount(0);
    }
    await page.keyboard.press('Escape');
    await expect(app.menu).toBeHidden();

    await app.rowButton(app.tracks().nth(1)).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await app.rowButton(app.tracks().nth(1)).click({ modifiers: ['ControlOrMeta'] });
    await page.keyboard.press('Delete');
    expect(await app.titles()).toEqual(titlesOf(['tr-4-1', 'tr-4-2', 'tr-5-1']));

    await app.main.getByRole('button', { name: 'More', exact: true }).click();
    await expect(app.menu.getByRole('menuitem', { name: 'Play all' })).toBeFocused();
    await expect(app.menu.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);
    await expect(app.menu.getByRole('menuitem', { name: 'Delete playlist' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Nor is it offered as a place to add songs.
    await app.openAlbum('Quiet Harbor');
    await app.openMenuOn(app.row('Coda 2'));
    await app.menu.getByRole('menuitem', { name: 'Add to playlist' }).click();
    await expect(app.menu.getByRole('menuitem', { name: 'Road Mix' })).toBeVisible();
    await expect(app.menu.getByRole('menuitem', { name: 'Server Picks' })).toHaveCount(0);

    const edits = ['addToPlaylist', 'removeFromPlaylist', 'reorderPlaylist', 'updatePlaylist', 'deletePlaylist'];
    expect(fake.calls.filter(call => edits.includes(call.method))).toEqual([]);
  });
});
