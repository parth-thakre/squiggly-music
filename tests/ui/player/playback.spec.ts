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
  test('is offered once when nothing plays, and resumes paused at its song and position', async ({ app, page, fake }) => {
    fake.saved = { tracks: ['tr-1-4', 'tr-1-1', 'tr-1-5'].map(id => ({ ...trackOfId(id) })), currentIndex: 1, positionSeconds: 17, changed: null, changedBy: 'phone' };
    await app.signIn();
    await expect(app.deck.getByText(/Pick up where you left off: Long Run by Ada Brass, at 0:17 \(from phone\)/)).toBeVisible();
    await app.deck.getByRole('button', { name: 'Resume' }).click();
    await expect(app.deck.getByRole('heading', { level: 2 })).toHaveText('Long Run');
    await expect(app.deck.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect(app.clock).toHaveText('0:17');
    await app.deck.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(18);
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
