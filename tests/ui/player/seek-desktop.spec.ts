import type { Page } from '@playwright/test';
import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test, trackOf } from '../fixtures/test';

// The desktop deck's seek squiggle against host snapshots. On Windows the range input's change
// event for a release arrives late, after a frame has put the playing position back in the input.

const song = trackOf('tr-1-1');
const seeks = (page: Page) => page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls
  .filter(call => call.startsWith('command:{"type":"seek"')).map(call => (JSON.parse(call.slice(8)) as { seconds: number }).seconds));
const push = (page: Page, patch: object) => page.evaluate(value => (window as unknown as { pushPlayer(p: object): void }).pushPlayer(value), patch);

async function playing(page: Page) {
  await installDesktopBridge(page, { commands: true });
  await page.goto('/');
  await push(page, { queue: [song], entryIds: ['e.1'], currentIndex: 0, duration: 360, playId: 'p.1', playing: true, position: 100, audio: { buffering: false } });
}

test('after a click, the squiggle follows playback, and leaving it seeks nothing more', async ({ page }) => {
  await playing(page);
  const seek = page.getByRole('slider', { name: /^Position in/ });
  const box = (await seek.boundingBox())!;
  await page.mouse.click(box.x + box.width * .5, box.y + box.height / 2);
  await page.waitForTimeout(50);
  await seek.evaluate((input: HTMLInputElement) => input.dispatchEvent(new Event('change', { bubbles: true })));
  // The host lands the seek and plays on; the thumb and clock go with it.
  for (const position of [180, 181, 182]) { await push(page, { position }); await page.waitForTimeout(150); }
  await expect(seek).toHaveAttribute('aria-valuetext', /^3:0[2-3] of 6:00$/);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(200);
  const sent = await seeks(page);
  expect(sent).toHaveLength(1);
  expect(Math.abs(sent[0] - 180)).toBeLessThan(4);
});

test('the keyboard seeks once its key is let go, and assistive tech setting the value seeks at once', async ({ page }) => {
  await playing(page);
  const seek = page.getByRole('slider', { name: /^Position in/ });
  await seek.focus();
  await page.keyboard.press('End');
  await expect.poll(() => seeks(page)).toEqual([360]);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await push(page, { position: 50 });
  // As a screen reader's increment: an input event with no key or press.
  // Through the element's own setter, as the browser sets it, so React sees a change.
  await seek.evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '75');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => seeks(page)).toEqual([360, 75]);
});

test('the position waits at a seek until the host reports it, and goes back if it never does', async ({ page }) => {
  await playing(page);
  const seek = page.getByRole('slider', { name: /^Position in/ });
  const box = (await seek.boundingBox())!;
  await page.mouse.click(box.x + box.width * .5, box.y + box.height / 2);
  // Snapshots still from before the seek: the thumb doesn't go back to them.
  for (const position of [100.25, 100.5]) {
    await push(page, { position }); await page.waitForTimeout(100);
    await expect(seek).toHaveAttribute('aria-valuetext', /^3:0\d of 6:00$/);
  }
  await push(page, { position: 180.2 });
  await expect(seek).toHaveAttribute('aria-valuetext', /^3:0\d of 6:00$/);
  // A seek the host never carries out: its snapshots keep the old position, and after a moment
  // the thumb shows it.
  await push(page, { playing: false, position: 180 });
  const right = (await seek.boundingBox())!;
  await page.mouse.click(right.x + right.width * .9, right.y + right.height / 2);
  await expect(seek).toHaveAttribute('aria-valuetext', /^5:2\d of 6:00$/);
  for (let i = 0; i < 10; i++) { await push(page, { playing: false, position: 180 }); await page.waitForTimeout(250); }
  await expect(seek).toHaveAttribute('aria-valuetext', '3:00 of 6:00');
});

test('a lyric line seeks there and stays current while the host catches up', async ({ page, app }) => {
  await installDesktopBridge(page, { commands: true, server: true });
  const response = await page.request.post('/api/session', { data: { password: 'squiggly test password' }, headers: { origin: app.url } });
  expect(response.status()).toBe(200);
  await page.goto('/');
  await push(page, { queue: [trackOf('tr-1-2')], entryIds: ['e.2'], currentIndex: 0, duration: 30, playId: 'p.2', playing: true, position: 1, audio: { buffering: false } });
  await page.getByRole('complementary', { name: 'Now playing' }).getByRole('button', { name: 'Lyrics', exact: true }).click();
  const current = page.locator('.lyric-lines li.current');
  await expect(current).toHaveText('Line 1 of the lyric');
  await page.locator('.lyric-lines li').filter({ hasText: 'Line 6 of the lyric' }).getByRole('button').click();
  await expect.poll(() => seeks(page)).toHaveLength(1);
  // The host still reports where the song was for a moment: the line doesn't go back.
  for (const position of [1.25, 1.5]) {
    await push(page, { position }); await page.waitForTimeout(120);
    await expect(current).toHaveText('Line 6 of the lyric');
  }
  await push(page, { position: (await seeks(page))[0] + .3 });
  await expect(current).toHaveText('Line 6 of the lyric');
});
