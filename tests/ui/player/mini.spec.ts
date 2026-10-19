import { installDesktopBridge } from '../fixtures/desktop';
import { lyricLines } from '../fixtures/library';
import { expect, test } from '../fixtures/test';

// The mini player's window, with a song playing whose lyrics are timed: a line every 3 s.
const song = { id: 'song-lyric', title: 'Lyric Line', artist: 'Ada Brass', album: 'Test Pressing', duration: 30, source: 'navidrome', coverArt: null };
async function playing(page: import('@playwright/test').Page, position: number, timed = true) {
  await installDesktopBridge(page, { mini: true, player: { queue: [song], entryIds: ['entry-1'], currentIndex: 0, duration: 30, playing: false, position } });
  // The fake bridge has no lyrics; this song's are the fixture library's.
  await page.addInitScript(({ lines, timed }) => {
    const bridge = (window as unknown as { squiggly: { library: Record<string, unknown> } }).squiggly;
    const library = bridge.library;
    bridge.library = new Proxy(library, { get: (target, method: string) => method === 'lyrics'
      ? async () => ({ ok: true, value: { synced: timed, lines, wordTiming: null, source: 'server' } })
      : (target as Record<string, unknown>)[method] });
  }, { lines: lyricLines.map(line => ({ ...line, start: timed ? line.start : null })), timed });
}

test.describe('mini player', () => {
  test('a wide window shows the line being sung between the song and the buttons', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 140 });
    await playing(page, 4);
    await page.goto('/');
    const mini = page.locator('.mini');
    const line = mini.locator('.mini-lyric');
    await expect(line).toHaveText('Line 2 of the lyric');
    // Only to glance at: assistive tech isn't told every line.
    await expect(line).toHaveAttribute('aria-hidden', 'true');
    const title = (await mini.locator('.mini-title').boundingBox())!;
    const box = (await line.boundingBox())!;
    const controls = (await mini.locator('.mini-controls').boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(title.x + 10);
    expect(box.x + box.width).toBeLessThanOrEqual(controls.x);
  });

  test('a narrow window shows no line, and a wider one does', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 112 });
    await playing(page, 4);
    await page.goto('/');
    const mini = page.locator('.mini');
    await expect(mini.locator('.mini-title')).toHaveText('Lyric Line');
    await expect(mini.locator('.mini-lyric')).toHaveCount(0);
    // Wider, it comes.
    await page.setViewportSize({ width: 700, height: 112 });
    await expect(mini.locator('.mini-lyric')).toHaveText('Line 2 of the lyric');
  });

  test('lyrics without times show no line', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 140 });
    await playing(page, 4, false);
    await page.goto('/');
    await expect(page.locator('.mini .mini-title')).toHaveText('Lyric Line');
    await page.waitForTimeout(300);
    await expect(page.locator('.mini .mini-lyric')).toHaveCount(0);
  });

  test('shuffle and repeat sit on the bottom line, and give way in a narrow window', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 112 });
    await playing(page, 4);
    await page.goto('/');
    const mini = page.locator('.mini');
    const shuffle = mini.getByRole('button', { name: 'Shuffle' });
    const repeat = mini.getByRole('button', { name: 'Repeat' });
    await expect(shuffle).toBeVisible();
    await expect(repeat).toBeVisible();
    const squiggle = (await mini.locator('.squiggle').boundingBox())!;
    const pin = (await mini.getByRole('button', { name: 'Keep on top' }).boundingBox())!;
    const box = (await shuffle.boundingBox())!;
    // Between the squiggle and the window's buttons, on their line.
    expect(box.x).toBeGreaterThanOrEqual(squiggle.x + squiggle.width);
    expect(box.x + box.width).toBeLessThanOrEqual(pin.x);
    expect(Math.abs(box.y + box.height / 2 - (pin.y + pin.height / 2))).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 340, height: 96 });
    await expect(shuffle).toBeHidden();
    await expect(repeat).toBeHidden();
    await expect(mini.getByRole('button', { name: 'Keep on top' })).toBeVisible();
  });

  test('the window frame takes the room\'s ground, for the strip Windows keeps along its edges', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 112 });
    await playing(page, 4);
    await page.goto('/');
    await expect(page.locator('.mini .mini-title')).toHaveText('Lyric Line');
    const ground = await page.locator('.mini').evaluate(element => getComputedStyle(element).backgroundColor);
    const hex = '#' + (ground.match(/\d+/g) ?? []).slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
    await expect.poll(() => page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls.filter(call => call.startsWith('tint:')).at(-1))).toMatch(new RegExp(`:${hex}$`));
  });
});
