import { expect, test } from '../fixtures/test';

// The command palette, key bindings, and themes, as a keyboard user meets them.
test.describe('commands', () => {
  test('Ctrl+K opens the palette, filters, runs a command, and gives focus back', async ({ app, page }) => {
    await app.signIn();
    await app.section('Artists').click();
    await expect(app.heading).toHaveText('Artists');
    await expect(app.section('Artists')).toBeFocused();

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Commands' });
    const field = palette.getByRole('combobox', { name: 'Find a command' });
    await expect(palette).toBeVisible();
    await expect(field).toBeFocused();
    // Unfiltered, every command is listed with its keys.
    await expect(palette.getByRole('option', { name: /^Go to records/ })).toContainText('G then R');

    // Escape closes it and focus goes back where it was.
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(app.section('Artists')).toBeFocused();

    await page.keyboard.press('Control+k');
    await field.fill('playlists');
    const options = palette.getByRole('option');
    await expect(options.first()).toHaveAccessibleName(/^Go to playlists/);
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await field.fill('xyzzy');
    await expect(palette.getByRole('status')).toHaveText('Nothing matches “xyzzy”.');
    await field.fill('go');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await field.fill('go to playlists');
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(app.heading).toHaveText('Playlists');
    await expect(app.section('Artists')).toBeFocused();

    // Ctrl+K works from the search field too, and a second press closes the palette.
    await page.getByRole('searchbox', { name: 'Search your library' }).focus();
    await page.keyboard.press('Control+k');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(palette).toBeHidden();
    await expect(page.getByRole('searchbox', { name: 'Search your library' })).toBeFocused();
  });

  test('the palette lists commands, not the library, and recent commands come first', async ({ app, page }) => {
    await app.signIn();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Commands' });
    // Records and artists are found with the search in the bar.
    await palette.getByRole('combobox').fill('test press');
    await expect(palette.getByRole('status')).toHaveText('Nothing matches “test press”.');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('go to favorites');
    await page.keyboard.press('Enter');
    await expect(app.heading).toHaveText('Favorites');
    await page.keyboard.press('Control+k');
    await expect(palette.getByRole('group', { name: 'Recent' }).getByRole('option').first()).toHaveAccessibleName(/^Go to favorites/);
  });

  test('default keys, chords, and Space outside buttons', async ({ app, page }) => {
    await app.signIn();
    await app.play('Test Pressing', 'Long Run');
    await app.main.focus();
    await page.keyboard.press('Space');
    await expect(app.deck.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(app.deck.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await page.keyboard.press('g');
    await page.keyboard.press('a');
    await expect(app.heading).toHaveText('Artists');
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(app.heading).toHaveText('Test Pressing');
    // Typing in a field types; it doesn't run commands.
    const search = page.getByRole('searchbox', { name: 'Search your library' });
    await page.keyboard.press('/');
    await expect(search).toBeFocused();
    await page.keyboard.type('g a');
    await expect(search).toHaveValue('g a');
    await expect(app.heading).not.toHaveText('Artists');
  });

  test('a key binding stored in this browser replaces a default', async ({ app, page }) => {
    await page.addInitScript(() => localStorage.setItem('squiggly.keybindings', JSON.stringify([
      { key: 'shift+p', command: 'builtin:toggle' },
      { key: 'space', command: '-builtin:toggle' },
    ])));
    await app.signIn();
    await app.play('Test Pressing', 'Long Run');
    await app.main.focus();
    await page.keyboard.press('Space');
    await expect(app.deck.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await page.keyboard.press('Shift+P');
    await expect(app.deck.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

    await app.openSettings();
    const row = app.main.getByRole('row', { name: /^Play or pause/ });
    await expect(row).toContainText('Shift+P');
    await expect(row).toContainText('yours');
    await expect(row).not.toContainText('Space');
  });

  test('Settings lists problems with the stored bindings in plain words', async ({ app }) => {
    await app.signIn();
    await app.openSettings();
    const editor = app.main.getByLabel('Your key bindings');
    await editor.fill('[{ "key": "ctrl+kk", "command": "builtin:palette" }, { "key": "m", "command": "builtin:go-records" }]');
    await app.main.getByRole('button', { name: 'Save keys' }).click();
    await expect(app.main.getByRole('alert')).toContainText('Entry 1: “kk” in “ctrl+kk” isn\'t a key this app knows.');
    await expect(app.main.getByText('M is bound to “Go to records” and “Mute or unmute”.')).toBeVisible();
    await editor.fill('[{ "key": ');
    await app.main.getByRole('button', { name: 'Save keys' }).click();
    await expect(app.main.getByRole('status').filter({ hasText: 'isn\'t valid JSON' })).toBeVisible();
    await app.main.getByRole('button', { name: 'Use the default keys' }).click();
    await expect(app.main.getByText('Back to the default keys.')).toBeVisible();
    await expect(app.main.getByRole('alert')).toBeHidden();
  });

  test('picking a theme changes the room at once and is remembered', async ({ app, page }) => {
    await app.signIn();
    await app.openSettings();
    const room = page.locator('.room');
    const variable = (name: string) => room.evaluate((element, n) => getComputedStyle(element).getPropertyValue(n).trim(), name);
    await expect(app.main.getByRole('radio', { name: /^Cover/ })).toBeChecked();

    await app.main.getByRole('radio', { name: /^Night/ }).check();
    await expect.poll(() => variable('--ground')).toBe('#121620');
    expect(await variable('--accent')).toBe('#eda43a');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'builtin:night');
    expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#121620');

    await app.main.getByRole('radio', { name: /^Studio/ }).check();
    await expect.poll(() => variable('--ground')).toBe('#e2e5e9');
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    expect(await page.locator('html').evaluate(element => getComputedStyle(element).getPropertyValue('--radius').trim())).toBe('2px');
    // Headings take the theme's display type.
    expect(await app.heading.evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/^"?Familjen Grotesk Variable/);

    await page.reload();
    await expect(app.heading).toHaveText('Settings');
    await expect.poll(() => variable('--ground')).toBe('#e2e5e9');

    // Themes are commands too.
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'Commands' }).getByRole('combobox').fill('plain');
    await page.keyboard.press('Enter');
    await expect.poll(() => variable('--ground')).toBe('#ffffff');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'none');
    await expect(app.main.getByRole('radio', { name: /^Plain/ })).toBeChecked();
  });
});
