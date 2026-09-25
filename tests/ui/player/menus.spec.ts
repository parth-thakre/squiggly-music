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
    await expect(item('Song details')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(item('Play')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(item('Song details')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(app.menu).toBeHidden();
    await expect(invoker).toBeFocused();
  });

  test('a text item takes typing: ArrowLeft moves the caret, Escape leaves the field, a second Escape closes', async ({ app, page }) => {
    await app.section('Playlists').click();
    const invoker = app.main.getByRole('button', { name: /Road Mix/ });
    await app.openMenuOn(invoker);
    await expect(app.menu.getByRole('menuitem', { name: 'Play all' })).toBeFocused();
    await page.keyboard.press('End');
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
