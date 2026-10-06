import type { Page } from '@playwright/test';
import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test, trackOf } from '../fixtures/test';

// The desktop deck's seek squiggle against host snapshots. On Windows the range input's change
// event for a release arrives late, after a frame has put the playing position back in the input.

const song = trackOf('tr-1-1');
const seeks = (page: Page) => page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls
  .filter(call => call.startsWith('command:{"type":"seek"')).map(call => (JSON.parse(call.slice(8)) as { seconds: number }).seconds));
const push = (page: Page, patch: object) => page.evaluate(value => (window as unknown as { pushPlayer(p: object): void }).pushPlayer(value), patch);

test.beforeEach(async ({ page }) => {
  await installDesktopBridge(page, { commands: true });
  await page.goto('/');
  await push(page, { queue: [song], entryIds: ['e.1'], currentIndex: 0, duration: 360, playId: 'p.1', playing: true, position: 100, audio: { buffering: false } });
});

test('after a click, the squiggle follows playback, and leaving it seeks nothing more', async ({ page }) => {
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
