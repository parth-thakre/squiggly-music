import { expect, test } from '../fixtures/test';

const caret = (field: import('@playwright/test').Locator) => field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]);

test.describe('menus', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('right-click focuses the first item, arrows move, Escape closes and focus returns', async ({ app, page }) => {
    await app.openAlbum('Test Pressing');
    const invoker = app.rowButton(app.row('Short Stop'));
    await app.openMenuOn(app.row('Short Stop'));
    await expect(app.menu).toHaveAccessibleName('Short Stop');
    const item = (name: string) => app.menu.getByRole('menuitem', { name, exact: true });
    await expect(item('Play')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item('Play next')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item('Add to queue')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(item('Play next')).toBeFocused();
    await page.keyboard.press('End');
    await expect(item('Share…')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item('Play')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(item('Share…')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(app.menu).toBeHidden();
    await expect(invoker).toBeFocused();
  });

  test('a text item takes typing: ArrowLeft moves the caret, Escape leaves the field, a second Escape closes', async ({ app, page }) => {
    await app.section('Playlists').click();
    const invoker = app.main.getByRole('button', { name: /^Road Mix/ });
    await app.openMenuOn(invoker);
    await expect(app.menu.getByRole('menuitem', { name: 'Play all' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(app.menu.getByRole('menuitem', { name: 'Share…' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(app.menu.getByRole('menuitem', { name: 'Export as M3U' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(app.menu.getByRole('menuitem', { name: 'Delete playlist' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    const rename = app.menu.getByRole('menuitem', { name: 'Rename', exact: true });
    await expect(rename).toBeFocused();
    await page.keyboard.press('Enter');

    const field = app.menu.getByRole('textbox', { name: 'New name' });
    await expect(field).toBeFocused();
    await page.keyboard.type('Weekend');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    expect(await caret(field)).toEqual([5, 5]);
    await page.keyboard.press('Home');
    expect(await caret(field)).toEqual([0, 0]);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('Weekend');

    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(rename).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(app.menu).toBeHidden();
    await expect(invoker).toBeFocused();
  });

  test('submenus: ArrowRight opens, a text field keeps ArrowLeft, Escape steps back one level at a time', async ({ app, page, fake }) => {
    await app.openAlbum('Test Pressing');
    const invoker = app.rowButton(app.row('Tail Light'));
    await app.openMenuOn(app.row('Tail Light'));
    const add = app.menu.getByRole('menuitem', { name: 'Add to playlist' });
    await add.focus();
    await page.keyboard.press('ArrowRight');
    await expect(app.menu).toHaveAccessibleName('Add to playlist');
    const create = app.menu.getByRole('menuitem', { name: 'New playlist' });
    await expect(create).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(add).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(create).toBeFocused();

    await page.keyboard.press('Enter');
    const field = app.menu.getByRole('textbox', { name: 'Name the new playlist' });
    await expect(field).toBeFocused();
    await page.keyboard.type('Tails');
    await page.keyboard.press('ArrowLeft');
    expect(await caret(field)).toEqual([4, 4]);
    // Still in the submenu, still typing.
    await expect(app.menu).toHaveAccessibleName('Add to playlist');
    await page.keyboard.press('Escape');
    await expect(create).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(add).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(app.menu).toBeHidden();
    await expect(invoker).toBeFocused();
    expect(fake.callsTo('createPlaylist')).toEqual([]);
  });

  test('a new playlist named from the menu is created with the song', async ({ app, page, fake }) => {
    await app.openAlbum('Test Pressing');
    await app.openMenuOn(app.row('Tail Light'));
    await app.menu.getByRole('menuitem', { name: 'Add to playlist' }).click();
    await app.menu.getByRole('menuitem', { name: 'New playlist' }).click();
    await page.keyboard.type('Tails');
    await page.keyboard.press('Enter');
    await expect(app.menu).toBeHidden();
    await expect.poll(() => fake.playlists.find(p => p.name === 'Tails')?.trackIds).toEqual(['tr-1-5']);
  });
});

test.describe('menus with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the menu appears without an entrance animation', async ({ app }) => {
    await app.signIn();
    await app.openAlbum('Test Pressing');
    await app.openMenuOn(app.row('Short Stop'));
    expect(await app.menu.evaluate(menu => getComputedStyle(menu).animationName)).toBe('none');
  });
});

test.describe('menus and the selection', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });
  test('right-clicking a song marks it only while its menu is open', async ({ app, page }) => {
    await app.openAlbum('Test Pressing');
    const row = app.row('Long Run');
    await app.openMenuOn(row);
    await expect(row).toHaveClass(/\bselected\b/);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(row).not.toHaveClass(/\bselected\b/);
  });
});

test.describe('credits with several artists', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });
  test('each artist the server names separately has its own link and menu entry', async ({ app, page }) => {
    await app.play('Quiet Harbor', 'Second Wind 2');
    const credit = app.deck.locator('.deck-sub');
    await expect(credit).toContainText('Bell Tower & Cinder Lane');
    await expect(credit.getByRole('button', { name: 'Bell Tower', exact: true })).toBeVisible();
    await app.openMenuOn(app.row('Second Wind 2'));
    await app.menu.getByRole('menuitem', { name: 'Go to artist' }).click();
    await expect(page.getByRole('menuitem', { name: 'Bell Tower', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await credit.getByRole('button', { name: 'Cinder Lane', exact: true }).click();
    await expect(app.heading).toHaveText('Cinder Lane');
  });
});

test.describe('ratings', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });
  test('a song rated from its menu shows the rating in Song details, and the rating clears', async ({ app, page, fake }) => {
    await app.openAlbum('Test Pressing');
    const row = app.row('Tail Light');
    await app.openMenuOn(row);
    await app.menu.getByRole('menuitem', { name: 'Rate', exact: true }).click();
    await expect(app.menu).toHaveAccessibleName('Rate');
    await expect(app.menu.getByRole('menuitem', { name: '1 star', exact: true })).toBeVisible();
    // Nothing to clear yet.
    await expect(app.menu.getByRole('menuitem', { name: 'Clear rating' })).toHaveCount(0);
    await app.menu.getByRole('menuitem', { name: '4 stars', exact: true }).click();
    await expect(app.menu).toBeHidden();
    await expect.poll(() => fake.ratings.get('tr-1-5')).toBe(4);
    expect(fake.callsTo('rate').map(call => call.args)).toEqual([['tr-1-5', 4]]);

    await app.openMenuOn(row);
    await app.menu.getByRole('menuitem', { name: 'Song details' }).click();
    await expect(app.menu.getByText('Rated 4 of 5', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await expect(app.menu).toBeHidden();

    await app.chooseFromMenu(row, 'Rate', 'Clear rating');
    await expect.poll(() => fake.ratings.has('tr-1-5')).toBe(false);
    await app.openMenuOn(row);
    await app.menu.getByRole('menuitem', { name: 'Song details' }).click();
    await expect(app.menu.getByText('Not rated', { exact: true })).toBeVisible();
  });

  test('a record rated from its page shows marks by its name and leads Top rated', async ({ app, fake }) => {
    await app.openAlbum('Quiet Harbor');
    await app.main.getByRole('button', { name: 'More', exact: true }).click();
    await app.menu.getByRole('menuitem', { name: 'Rate', exact: true }).click();
    await app.menu.getByRole('menuitem', { name: '3 stars', exact: true }).click();
    await expect(app.main.getByRole('img', { name: 'Rated 3 of 5' })).toBeVisible();
    await expect.poll(() => fake.ratings.get('al-2')).toBe(3);

    await app.section('Records').click();
    await app.main.getByRole('group', { name: 'Sort records' }).getByRole('button', { name: 'Top rated' }).click();
    const records = app.main.getByRole('list').first().getByRole('listitem');
    await expect(records).toHaveCount(1);
    await expect(records.first()).toContainText('Quiet Harbor');

    // Cleared on its page, the record has left Top rated when you come Back.
    await records.first().getByRole('button', { name: /^Quiet Harbor/ }).click();
    await expect(app.heading).toHaveText('Quiet Harbor');
    await app.main.getByRole('button', { name: 'More', exact: true }).click();
    await app.menu.getByRole('menuitem', { name: 'Rate', exact: true }).click();
    await app.menu.getByRole('menuitem', { name: 'Clear rating' }).click();
    await expect.poll(() => fake.ratings.has('al-2')).toBe(false);
    await app.page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(app.main.getByText('Nothing rated yet. Records you rate will collect here, best first.')).toBeVisible();
    await expect(records).toHaveCount(0);
  });

  test('a record cleared from its menu leaves Top rated while the list is showing', async ({ app, fake }) => {
    fake.ratings.set('al-2', 3);
    await app.section('Records').click();
    await app.main.getByRole('group', { name: 'Sort records' }).getByRole('button', { name: 'Top rated' }).click();
    const record = app.main.getByRole('list').first().getByRole('button', { name: /^Quiet Harbor/ });
    await expect(record).toBeVisible();
    await app.chooseFromMenu(record, 'Rate', 'Clear rating');
    await expect(app.main.getByText('Nothing rated yet. Records you rate will collect here, best first.')).toBeVisible();
  });
});
