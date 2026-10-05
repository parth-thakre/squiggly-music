import type { Page } from '@playwright/test';
import { expect, test, toSeconds, trackOf as trackOfId, type App } from '../fixtures/test';

// A picture of the deck's squiggle canvas, to tell whether it is still being redrawn.
const squigglePixels = (page: Page) => page.locator('.deck .squiggle canvas').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());

// Presses the pointer on the squiggle at a fraction of its width and returns the page's
// mouse, still held down, so a spec can look at the deck mid-drag.
async function pressSeek(app: App, fraction: number) {
  const box = (await app.seek.boundingBox())!;
  await app.page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2);
  await app.page.mouse.down();
  return app.page.mouse;
}
const valueText = async (app: App) => (await app.seek.getAttribute('aria-valuetext')) ?? '';

test.describe('playback', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('plays an album song, the position advances, and pause holds it', async ({ app }) => {
    await app.play('Test Pressing', 'Long Run');
    await expect(app.deck.locator('.squiggle-time').last()).toHaveText('0:45');
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(2);
    await expect(app.seek).toHaveAttribute('aria-valuetext', /^0:0[2-9] of 0:45$/);
    // The playing row in the list says so.
    await expect(app.row('Long Run').getByRole('button', { name: 'Pause Long Run' })).toBeVisible();

    await app.pause();
    const held = await app.seconds();
    await expect(app.row('Long Run').getByRole('button', { name: 'Resume Long Run' })).toBeVisible();
    // Nothing to wait for but time itself: a paused clock must not move over a second or so.
    await app.page.waitForTimeout(1200);
    expect(await app.seconds()).toBe(held);
  });

  test('the squiggle keeps animating while paused', async ({ app, page }) => {
    await app.play('Test Pressing', 'Long Run');
    // Half way in, so the played part of the squiggle is long enough to show its wave.
    await (await pressSeek(app, .5)).up();
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(20);
    await app.pause();
    const first = await squigglePixels(page);
    await expect.poll(() => squigglePixels(page), { message: 'the paused squiggle is redrawn with a moving wave' }).not.toBe(first);
  });

  test('paused scrubbing moves the clock and aria-valuetext before release, and the seek lands', async ({ app }) => {
    await app.play('Test Pressing', 'Long Run');
    await app.pause();
    const paused = await app.seconds();
    expect(paused).toBeLessThan(10);

    const mouse = await pressSeek(app, .5);
    // Mid-drag, before release: the clock and the spoken value already follow the pointer.
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(20);
    expect(await app.seconds()).toBeLessThanOrEqual(25);
    await expect.poll(() => valueText(app)).toMatch(/^0:2[0-5] of 0:45$/);
    const box = (await app.seek.boundingBox())!;
    await mouse.move(box.x + box.width * .8, box.y + box.height / 2);
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(33);
    await expect.poll(() => valueText(app)).toMatch(/^0:3[3-9] of 0:45$/);
    const dropped = await app.seconds();
    await mouse.up();

    // Released while paused: it stays paused at the new place...
    await expect(app.deck.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    expect(Math.abs(await app.seconds() - dropped)).toBeLessThanOrEqual(1);
    // ...and playing continues from there, not from where it was paused.
    await app.deck.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(dropped + 1);
    expect(await app.seconds()).toBeLessThan(45);
    expect(toSeconds((await valueText(app)).split(' of ')[0])).toBeGreaterThan(dropped);
  });

  test('a click seeks to the spot drawn under it, near either end', async ({ app }) => {
    await app.play('Test Pressing', 'Long Run');
    await app.pause();
    const box = (await app.seek.boundingBox())!;
    const length = Number(await app.seek.getAttribute('max'));
    for (const fraction of [.15, .85]) {
      await (await pressSeek(app, fraction)).up();
      // The canvas draws the song from 2px in at each end (Squiggle.tsx).
      const drawn = (box.width * fraction - 2) / (box.width - 4) * length;
      expect(Math.abs(Number(await app.seek.inputValue()) - drawn), `seeking at ${fraction * 100}%`).toBeLessThan(.2);
    }
  });

  test('a seek while playing lands and playback continues from there', async ({ app }) => {
    await app.play('Test Pressing', 'Long Run');
    const mouse = await pressSeek(app, .6);
    await mouse.up();
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(26);
    const landed = await app.seconds();
    expect(landed).toBeLessThanOrEqual(30);
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(landed + 1);
    await expect(app.deck.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  });
});

test.describe('server-saved queue', () => {
  test('is offered once when nothing plays, and resumes playing from its song and position', async ({ app, page, fake }) => {
    fake.saved = { tracks: ['tr-1-4', 'tr-1-1', 'tr-1-5'].map(id => ({ ...trackOfId(id) })), currentIndex: 1, positionSeconds: 17, changed: null, changedBy: 'phone' };
    await app.signIn();
    await expect(app.deck.getByText('Pick up where you left off')).toBeVisible();
    await expect(app.deck.getByRole('heading', { level: 2 })).toHaveText('Long Run');
    await expect(app.deck.getByText('Ada Brass, at 0:17, from phone')).toBeVisible();
    await app.deck.getByRole('button', { name: 'Resume' }).click();
    await expect(app.deck.getByRole('heading', { level: 2 })).toHaveText('Long Run');
    // Resume plays; it doesn't leave the song waiting paused.
    await expect(app.deck.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(18);
    expect(await app.seconds()).toBeLessThan(30);
    await app.openQueue();
    expect(await app.titles()).toEqual(['Thirty Two', 'Long Run', 'Tail Light']);
    await expect(app.tracks().nth(1)).toHaveClass(/\bnow\b/);
    // Playing saves the queue back to the server.
    await expect.poll(() => fake.callsTo('saveQueue').length, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.reload();
    await expect(app.deck.getByText(/Pick up where you left off/)).toBeVisible();
  });
});

test.describe('playback with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('the squiggle is still while paused', async ({ app, page }) => {
    await app.signIn();
    await app.play('Test Pressing', 'Long Run');
    await (await pressSeek(app, .5)).up();
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(20);
    await app.pause();
    const first = await squigglePixels(page);
    // Give an animation every chance to show itself: a few dozen frames and half a second.
    await page.evaluate(() => new Promise<void>(done => {
      let frames = 0;
      const step = () => (++frames < 30 ? requestAnimationFrame(step) : setTimeout(done, 500));
      requestAnimationFrame(step);
    }));
    expect(await squigglePixels(page)).toBe(first);
  });
});

test.describe('one click to play, then what is playing', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('a record plays from its cover without opening it', async ({ app }) => {
    const card = app.main.getByRole('listitem').filter({ has: app.page.getByRole('button', { name: 'Play Quiet Harbor' }) });
    await card.hover();
    await card.getByRole('button', { name: 'Play Quiet Harbor' }).click();
    await app.expectPlaying('Opening 2');
    // Playing a whole record shows the queue, with the sleeve in the deck beside it.
    await expect(app.heading).toHaveText('Queue');
  });

  test("a record page's Play and Shuffle show the queue; a song from its list doesn't", async ({ app }) => {
    await app.openAlbum('Quiet Harbor');
    await app.main.getByRole('button', { name: 'Play', exact: true }).click();
    await app.expectPlaying('Opening 2');
    await expect(app.heading).toHaveText('Queue');
    await app.page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(app.heading).toHaveText('Quiet Harbor');
    await app.rowButton(app.row('Second Wind 2')).click();
    await app.expectPlaying('Second Wind 2');
    await expect(app.heading).toHaveText('Quiet Harbor');
  });

  test('an artist plays from beside their name', async ({ app }) => {
    await app.section('Artists').click();
    const row = app.main.getByRole('listitem').filter({ has: app.page.getByRole('button', { name: 'Play Bell Tower' }) });
    await row.hover();
    await row.getByRole('button', { name: 'Play Bell Tower' }).click();
    await app.expectPlaying('Opening 2');
    await expect(app.heading).toHaveText('Queue');
  });
});

test.describe('one sleeve', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test("the playing record's page folds its cover away, since the deck shows it; other records keep theirs", async ({ app }) => {
    await app.play('Test Pressing', 'Long Run');
    const head = app.main.locator('header.head');
    await expect(head).toHaveClass(/\bon-deck\b/);
    await expect(head.locator('.head-cover')).toHaveCSS('opacity', '0');
    await app.openAlbum('Quiet Harbor');
    await expect(head).not.toHaveClass(/\bon-deck\b/);
    await expect(head.locator('.head-cover')).toHaveCSS('opacity', '1');
  });
});

test.describe('repeat and shuffle', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });
  const repeat = (app: App) => app.deck.getByRole('button', { name: /^Repeat/ });
  const shuffle = (app: App) => app.deck.getByRole('button', { name: 'Shuffle', exact: true });

  test('repeat all wraps from the last song to the first, and repeat one plays a song again', async ({ app, page }) => {
    await app.play('Test Pressing', 'Tail Light');
    await expect(repeat(app)).toHaveAccessibleName('Repeat');
    await expect(repeat(app)).toHaveAttribute('aria-pressed', 'false');
    await repeat(app).click();
    await expect(repeat(app)).toHaveAccessibleName('Repeat all');
    await expect(repeat(app)).toHaveAttribute('aria-pressed', 'true');
    // The last song now has a next: the first.
    await expect(app.deck.getByText('Next:')).toContainText('Long Run');
    await (await pressSeek(app, .95)).up();
    await app.expectPlaying('Long Run', { timeout: 10_000 });

    // The r key goes on to repeat one: a finished song starts over.
    await page.keyboard.press('r');
    await expect(repeat(app)).toHaveAccessibleName('Repeat one');
    await (await pressSeek(app, .97)).up();
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(42);
    await expect.poll(() => app.seconds(), { timeout: 10_000 }).toBeLessThan(5);
    await app.expectPlaying('Long Run');
    // Next still moves on.
    await app.deck.getByRole('button', { name: 'Next', exact: true }).click();
    await app.expectPlaying('Lyric Line');
    await page.keyboard.press('r');
    await expect(repeat(app)).toHaveAccessibleName('Repeat');
    await expect(repeat(app)).toHaveAttribute('aria-pressed', 'false');
  });

  test('Next stops at the last song with repeat off and wraps to the first with repeat all', async ({ app }) => {
    await app.play('Test Pressing', 'Tail Light');
    const next = app.deck.getByRole('button', { name: 'Next', exact: true });
    await next.click();
    // Nothing to wait for but time itself: the last song must not change.
    await app.page.waitForTimeout(500);
    await app.expectPlaying('Tail Light');
    await repeat(app).click();
    await next.click();
    await app.expectPlaying('Long Run');
  });

  test('shuffle keeps the playing song and the ones before it, reorders the rest, and off leaves that order', async ({ app, page }) => {
    await app.play('Long Player', 'Take 3');
    const album = await app.titles();
    await app.openQueue();
    expect(await app.titles()).toEqual(album);
    await shuffle(app).click();
    await expect(shuffle(app)).toHaveAttribute('aria-pressed', 'true');
    await expect(app.main.getByText('Shuffled.')).toBeVisible();
    const shuffled = await app.titles();
    expect(shuffled.slice(0, 3)).toEqual(album.slice(0, 3));
    expect(shuffled.slice(3)).not.toEqual(album.slice(3));
    expect([...shuffled].sort()).toEqual([...album].sort());
    await app.expectPlaying('Take 3');

    // The s key turns it off, and the queue stays as it is.
    await page.keyboard.press('s');
    await expect(shuffle(app)).toHaveAttribute('aria-pressed', 'false');
    await expect(app.main.getByText('Shuffled.')).toBeHidden();
    expect(await app.titles()).toEqual(shuffled);
  });

  test('with shuffle on, a record plays from the chosen song with the rest in random order, and the modes last across visits', async ({ app, page }) => {
    await app.play('Long Player', 'Take 1');
    await shuffle(app).click();
    await repeat(app).click();
    // A new visit: the route comes back from the address, the queue doesn't.
    await page.reload();
    await expect(app.heading).toHaveText('Long Player');
    // Nothing plays: the deck offers the queue the play saved, or, before it's saved, a way to start.
    await expect(app.deck.getByText(/^(Pick a record, playlist, or song to start\.|Pick up where you left off)$/)).toBeVisible();
    await app.play('Long Player', 'Take 2');
    await expect(shuffle(app)).toHaveAttribute('aria-pressed', 'true');
    await expect(repeat(app)).toHaveAccessibleName('Repeat all');
    await app.openQueue();
    const queue = await app.titles();
    expect(queue.slice(0, 2)).toEqual(['Take 1', 'Take 2']);
    expect(queue.slice(2, 12)).not.toEqual(Array.from({ length: 10 }, (_, i) => `Take ${i + 3}`));
    await expect(app.main.getByText('Shuffled, and the queue repeats.')).toBeVisible();
  });

  test('turning repeat on stops radio', async ({ app }) => {
    await app.play('Test Pressing', 'Long Run');
    await app.chooseFromMenu(app.row('Long Run'), 'Start radio');
    await expect(app.deck.getByText(/^Radio from /)).toBeVisible();
    await repeat(app).click();
    await expect(app.deck.getByText(/^Radio from /)).toBeHidden();
    await expect(repeat(app)).toHaveAccessibleName('Repeat all');
  });

  test('turning repeat on while a station is on its way cancels it, and repeat stays on', async ({ app, page }) => {
    await app.play('Test Pressing', 'Long Run');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/similarSongs', async route => { await held; await route.continue(); });
    await app.chooseFromMenu(app.row('Long Run'), 'Start radio');
    await expect(app.deck.getByText(/^Finding songs like /)).toBeVisible();
    await repeat(app).click();
    await expect(repeat(app)).toHaveAccessibleName('Repeat all');
    const answered = page.waitForResponse('**/api/similarSongs');
    release();
    await answered;
    await expect(app.deck.getByText(/^Finding songs like /)).toBeHidden();
    await expect(app.deck.getByText(/^Radio from /)).toBeHidden();
    await expect(repeat(app)).toHaveAccessibleName('Repeat all');
    await app.expectPlaying('Long Run');
  });
});
