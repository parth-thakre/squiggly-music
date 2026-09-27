import type { Locator } from '@playwright/test';
import { expect, test } from '../fixtures/test';

// A long-press, as the page sees it. On Android, Chrome turns a long-press into a contextmenu
// event at the touch point (that is what the app listens for). Chromium's headless shell doesn't
// run that gesture for synthesized touches (CDP Input.synthesizeTapGesture with a long duration
// and a held Input.dispatchTouchEvent both arrive as a plain tap), so the spec dispatches the
// event Chrome would send.
async function longPress(target: Locator) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await target.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 0 });
}

test.describe('phone', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('Settings is reachable from the open now-playing sheet', async ({ app, page }) => {
    await app.openAlbum('Test Pressing');
    await app.rowButton(app.row('Long Run')).tap();
    await app.expectPlaying('Long Run');
    // The strip hides the deck's links; the sheet shows them.
    await expect(app.deck.getByRole('button', { name: 'Settings' })).toBeHidden();
    await app.deck.getByRole('button', { name: 'Open now playing: Long Run' }).tap();
    await expect(app.deck).toHaveClass(/\bopen\b/);
    const settings = app.deck.getByRole('button', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await expect(settings).toBeInViewport();
    await settings.tap();
    await expect(app.deck).not.toHaveClass(/\bopen\b/);
    await expect(app.heading).toHaveText('Settings');
    await expect(app.main.getByRole('checkbox', { name: /Report what you play/ })).toBeVisible();
    // The sheet's history entry was replaced, so Back leaves Settings for the record.
    await page.goBack();
    await expect(app.heading).toHaveText('Test Pressing');
  });

  test('the sheet closes with Hide and with the back gesture', async ({ app, page }) => {
    await app.play('Test Pressing', 'Long Run');
    await app.deck.getByRole('button', { name: 'Open now playing: Long Run' }).tap();
    await expect(app.deck).toHaveClass(/\bopen\b/);
    await app.deck.getByRole('button', { name: 'Hide' }).tap();
    await expect(app.deck).not.toHaveClass(/\bopen\b/);
    await expect(app.heading).toHaveText('Test Pressing');

    await app.deck.getByRole('button', { name: 'Open now playing: Long Run' }).tap();
    await expect(app.deck).toHaveClass(/\bopen\b/);
    await page.goBack();
    await expect(app.deck).not.toHaveClass(/\bopen\b/);
    await expect(app.heading).toHaveText('Test Pressing');
  });

  test('a long-press opens the song menu as a bottom sheet', async ({ app, page }) => {
    await app.openAlbum('Test Pressing');
    await longPress(app.rowButton(app.row('Short Stop')));
    await expect(app.menu).toBeVisible();
    await expect(app.menu).toHaveClass(/\bsheet\b/);
    await expect(app.menu).toHaveAccessibleName('Short Stop');
    // Once its entrance has settled, the sheet spans the width and sits on the bottom edge.
    const viewport = page.viewportSize()!;
    await expect.poll(async () => { const box = (await app.menu.boundingBox())!; return Math.round(box.y + box.height); }).toBe(viewport.height);
    expect((await app.menu.boundingBox())!.width).toBeGreaterThanOrEqual(viewport.width - 1);
    await expect(app.menu.getByRole('menuitem', { name: 'Play', exact: true })).toBeFocused();

    await app.menu.getByRole('menuitem', { name: 'Add to queue' }).tap();
    await expect(app.menu).toBeHidden();
    await app.expectPlaying('Short Stop');
  });
});

// Swipes on the now-playing sleeve, as touch pointer events (the headless shell has no gesture API).
async function swipe(target: Locator, dx: number, stepMs = 0) {
  const box = (await target.boundingBox())!;
  const y = box.y + box.height / 2, x0 = box.x + box.width / 2;
  await target.evaluate(async (element, { x0, y, dx, stepMs }) => {
    const fire = (type: string, x: number) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
    fire('pointerdown', x0);
    for (let i = 1; i <= 8; i++) { fire('pointermove', x0 + dx * i / 8); if (stepMs) await new Promise(done => setTimeout(done, stepMs)); }
    fire('pointerup', x0 + dx);
  }, { x0, y, dx, stepMs });
}

test.describe('swiping songs', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('swiping the sleeve left and right moves through the queue, and stops at the ends', async ({ app, page }) => {
    await app.openAlbum('Test Pressing');
    const titles = await app.titles();
    await app.rowButton(app.row(titles[0])).tap();
    await app.expectPlaying(titles[0]);
    await app.deck.getByRole('button', { name: `Open now playing: ${titles[0]}` }).tap();
    const sleeve = app.deck.locator('.deck-cover');
    await swipe(sleeve, -260);
    await app.expectPlaying(titles[1]);
    await swipe(sleeve, 260);
    await app.expectPlaying(titles[0]);
    // Nothing before the first song: the sleeve springs back and the song stays.
    await swipe(sleeve, 260);
    await page.waitForTimeout(500);
    await app.expectPlaying(titles[0]);
    await expect.poll(() => app.deck.evaluate(deck => getComputedStyle(deck).getPropertyValue('--swipe-x').trim())).toBe('0px');
  });

  test('a short, slow drag springs back without changing songs', async ({ app, page }) => {
    await app.openAlbum('Test Pressing');
    const titles = await app.titles();
    await app.rowButton(app.row(titles[0])).tap();
    await app.expectPlaying(titles[0]);
    await swipe(app.deck.locator('.deck-cover'), -70, 40);
    await page.waitForTimeout(500);
    await app.expectPlaying(titles[0]);
    // The strip didn't open the sheet either.
    await expect(app.deck).not.toHaveClass(/\bopen\b/);
  });
});

test('the open now-playing sheet uses the full width', async ({ app }) => {
  await app.signIn();
  await app.play('Test Pressing', 'Long Run');
  await app.deck.getByRole('button', { name: 'Open now playing: Long Run' }).tap();
  const sheet = (await app.deck.boundingBox())!, sleeve = (await app.deck.locator('.deck-cover').boundingBox())!;
  expect(sleeve.width).toBeGreaterThan(sheet.width * .75);
});
