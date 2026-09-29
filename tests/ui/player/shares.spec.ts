import { expect, playlistIds, test } from '../fixtures/test';
import { sharingOff } from '../fixtures/library';

// Shares: public links the server makes. Share… on songs, records, and playlists opens a small
// dialog; Settings lists the links with Copy and Delete.

const DAY = 86_400_000;

test.describe('shares', () => {
  test.beforeEach(async ({ app, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await app.signIn();
  });

  test('Share… on a record makes a link, copies it, and Settings lists and deletes it', async ({ app, page, fake }) => {
    await app.openAlbum('Quiet Harbor');
    await app.main.getByRole('button', { name: 'More', exact: true }).click();
    await app.menu.getByRole('menuitem', { name: 'Share…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share “Quiet Harbor”' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: '1 week' })).toBeChecked();
    await dialog.getByRole('radio', { name: '1 day' }).check();
    await dialog.getByRole('textbox', { name: 'Description' }).fill('For the drive');
    const before = Date.now();
    await dialog.getByRole('button', { name: 'Create' }).click();

    const link = dialog.getByRole('textbox', { name: 'Link' });
    await expect(link).toHaveValue('https://music.example.com/share/sh-1');
    await expect(dialog.getByText(/^It expires on /)).toBeVisible();
    const [ids, description, expiresAt] = fake.callsTo('createShare')[0].args as [string[], string, number];
    expect(ids).toEqual(['al-2']);
    expect(description).toBe('For the drive');
    expect(expiresAt).toBeGreaterThanOrEqual(before + DAY - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + DAY + 1000);

    await dialog.getByRole('button', { name: 'Copy' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Copied the link.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://music.example.com/share/sh-1');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();

    await app.openSettings();
    const shares = app.main.getByRole('region', { name: 'Shares' });
    await expect(shares.getByText('For the drive')).toBeVisible();
    await expect(shares.getByText(/Made on .+\. It expires on .+\. Not opened yet\./)).toBeVisible();
    await expect(shares.getByText('https://music.example.com/share/sh-1')).toBeVisible();
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await shares.getByRole('button', { name: 'Copy' }).click();
    await expect(shares.getByRole('status')).toHaveText('Copied the link to For the drive.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://music.example.com/share/sh-1');

    await shares.getByRole('button', { name: 'Delete' }).click();
    await expect(shares.getByText('Delete this link? Anyone who has it can no longer listen.')).toBeVisible();
    await shares.getByRole('button', { name: 'Delete' }).click();
    await expect(shares).toBeHidden();
    expect(fake.shareList).toEqual([]);
    expect(fake.callsTo('deleteShare').map(call => call.args)).toEqual([['sh-1']]);
  });

  test('Share… on selected songs and on a playlist shares their ids, and Never sends no expiry', async ({ app, page, fake }) => {
    await app.openAlbum('Quiet Harbor');
    await app.rowButton(app.row('Opening 2')).click({ modifiers: ['ControlOrMeta'] });
    await app.rowButton(app.row('Coda 2')).click({ modifiers: ['ControlOrMeta'] });
    await app.openMenuOn(app.row('Coda 2'));
    await app.menu.getByRole('menuitem', { name: 'Share…' }).click();
    const songs = page.getByRole('dialog', { name: 'Share “2 songs”' });
    await songs.getByRole('radio', { name: 'Never' }).check();
    await songs.getByRole('button', { name: 'Create' }).click();
    await expect(songs.getByText('It doesn\'t expire.')).toBeVisible();
    expect(fake.callsTo('createShare')[0].args).toEqual([['tr-2-1', 'tr-2-5'], null, null]);
    await page.keyboard.press('Escape');
    await expect(songs).toBeHidden();

    await app.openPlaylist('Road Mix');
    await app.main.getByRole('button', { name: 'More', exact: true }).click();
    await app.menu.getByRole('menuitem', { name: 'Share…' }).click();
    const playlist = page.getByRole('dialog', { name: 'Share “Road Mix”' });
    await playlist.getByRole('button', { name: 'Create' }).click();
    await expect(playlist.getByRole('textbox', { name: 'Link' })).toHaveValue('https://music.example.com/share/sh-2');
    expect((fake.callsTo('createShare')[1].args as unknown[])[0]).toEqual([playlistIds.road]);
    await playlist.getByRole('button', { name: 'Done' }).click();

    // Without a description, a link is named by what it holds.
    await app.openSettings();
    const shares = app.main.getByRole('region', { name: 'Shares' });
    await expect(shares.getByText('Opening 2 and 1 more')).toBeVisible();
    await expect(shares.getByText('Road Mix', { exact: true })).toBeVisible();
  });

  test('A server that doesn\'t share says so plainly, and Settings has no Shares section', async ({ app, page, fake }) => {
    fake.sharing = false;
    await app.openAlbum('Quiet Harbor');
    await app.main.getByRole('button', { name: 'More', exact: true }).click();
    await app.menu.getByRole('menuitem', { name: 'Share…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share “Quiet Harbor”' });
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(sharingOff);
    await expect(dialog.getByRole('textbox', { name: 'Link' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    await app.openSettings();
    await expect(app.main.getByRole('heading', { name: 'Theme' }).or(app.main.getByRole('heading', { name: 'Lyrics' })).first()).toBeVisible();
    await expect.poll(() => fake.callsTo('shares').length).toBeGreaterThan(0);
    await expect(app.main.getByRole('heading', { name: 'Shares' })).toHaveCount(0);
  });
});

// On a phone the dialog is a bottom sheet, and Back closes it as it closes the menu. Android's
// MainActivity steps back with this script whenever the page has history behind it.
const STEP_BACK = '(function(){var s=history.state;if(s&&typeof s.depth===\'number\'&&s.depth>0){history.back();return true}return false})()';

test.describe('shares on a phone', () => {
  test.use({ viewport: { width: 412, height: 860 } });
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('Back closes the share sheet and leaves the page behind it where it was', async ({ app, page }) => {
    await app.openAlbum('Quiet Harbor');
    const dialog = page.getByRole('dialog', { name: 'Share “Quiet Harbor”' });
    const share = async () => {
      await app.main.getByRole('button', { name: 'More', exact: true }).click();
      await app.menu.getByRole('menuitem', { name: 'Share…' }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveClass(/\bsheet\b/);
    };

    await share();
    await page.goBack();
    await expect(dialog).toBeHidden();
    await expect(app.heading).toHaveText('Quiet Harbor');

    // Android's Back gesture.
    await share();
    expect(await page.evaluate(STEP_BACK)).toBe(true);
    await expect(dialog).toBeHidden();
    await expect(app.heading).toHaveText('Quiet Harbor');

    // Cancel uses up the sheet's history entry, so the next Back leaves the record.
    await share();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(app.heading).toHaveText('Quiet Harbor');
    await page.goBack();
    await expect(app.heading).toHaveText('Records');
  });
});
