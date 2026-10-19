import { installDesktopBridge } from '../fixtures/desktop';
import { lyricLines } from '../fixtures/library';
import { expect, test } from '../fixtures/test';

// The mini player's window, with a song playing whose lyrics are timed: a line every 3 s.
const song = { id: 'song-lyric', title: 'Lyric Line', artist: 'Ada Brass', album: 'Test Pressing', duration: 30, source: 'navidrome', coverArt: null };
type Line = { start: number | null; end?: number; text: string; words?: { start: number; end: number; text: string }[] };
async function playing(page: import('@playwright/test').Page, position: number, timed = true, given: Line[] = lyricLines, wordTiming: 'exact' | 'estimated' | null | 'left out' = null, moving = false) {
  await installDesktopBridge(page, { mini: true, player: { queue: [song], entryIds: ['entry-1'], currentIndex: 0, duration: 30, playing: moving, position } });
  // The fake bridge has no lyrics; this song's are the fixture library's.
  await page.addInitScript(({ lines, timed, wordTiming, given }) => {
    const bridge = (window as unknown as { squiggly: { library: Record<string, unknown> } }).squiggly;
    const library = bridge.library;
    bridge.library = new Proxy(library, { get: (target, method: string) => method === 'lyrics'
      ? async () => ({ ok: true, value: { synced: timed, lines, ...(given ? {} : { wordTiming }), source: 'server' } })
      : (target as Record<string, unknown>)[method] });
  }, { lines: given.map(line => ({ ...line, start: timed ? line.start : null })), timed, wordTiming: wordTiming === 'left out' ? null : wordTiming, given: wordTiming === 'left out' });
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

  test('without room beside the song, the line takes a row of its own under it', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 112 });
    await playing(page, 4);
    await page.goto('/');
    const mini = page.locator('.mini');
    const line = mini.locator('.mini-lyric');
    await expect(line).toHaveText('Line 2 of the lyric');
    await expect(line).toHaveClass(/\bbelow\b/);
    // Under the song and the buttons, above the squiggle, across the width.
    const [title, controls, squiggle, box] = await Promise.all(['.mini-title', '.mini-controls', '.squiggle', '.mini-lyric'].map(async selector => (await mini.locator(selector).boundingBox())!));
    expect(box.y).toBeGreaterThanOrEqual(Math.max(title.y + title.height, controls.y + controls.height) - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(squiggle.y + 1);
    expect(box.x).toBeCloseTo(title.x, 0);
    expect(box.x + box.width).toBeGreaterThan(controls.x);
    // Elsewhere the system's frame resizes the window: no handles of its own.
    await expect(mini.locator('.mini-edge')).toHaveCount(0);
    // Wider, it moves beside the song.
    await page.setViewportSize({ width: 700, height: 112 });
    await expect(line).not.toHaveClass(/\bbelow\b/);
    // As wide but tall, the sleeve takes the room beside it: below again.
    await page.setViewportSize({ width: 640, height: 240 });
    await expect(line).toHaveClass(/\bbelow\b/);
    await page.setViewportSize({ width: 900, height: 240 });
    await expect(line).not.toHaveClass(/\bbelow\b/);
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

  test('every size the window allows leaves the song, the squiggle, and every button room', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 112 });
    await playing(page, 4);
    await page.goto('/');
    const mini = page.locator('.mini');
    await expect(mini.locator('.mini-title')).toHaveText('Lyric Line');
    // The window's limits (main/index.ts): 320 to 900 wide, 96 to 240 tall, and between.
    for (const [width, height] of [[320, 96], [320, 240], [380, 240], [420, 240], [420, 112], [570, 108], [640, 240], [900, 96], [900, 240]] as const) {
      await page.setViewportSize({ width, height });
      const sizes = await mini.evaluate(element => {
        const box = (selector: string) => element.querySelector(selector)?.getBoundingClientRect() ?? null;
        const buttons = [...element.querySelectorAll('button')].filter(button => button.checkVisibility() && button.closest('[aria-hidden="true"]') === null)
          .map(button => { const r = button.getBoundingClientRect(); return { name: button.getAttribute('aria-label') ?? button.textContent, right: r.right, bottom: r.bottom, width: r.width }; });
        const line = box('.mini-lyric');
        return { title: box('.mini-title')?.width ?? 0, rail: box('.squiggle-rail')?.width ?? 0, buttons, line: line && { width: line.width, bottom: line.bottom } };
      });
      expect(sizes.title, `title at ${width}x${height}`).toBeGreaterThanOrEqual(40);
      expect(sizes.rail, `squiggle at ${width}x${height}`).toBeGreaterThanOrEqual(30);
      // The sung line shows at every size, inside the window.
      expect(sizes.line?.width ?? 0, `lyric at ${width}x${height}`).toBeGreaterThanOrEqual(100);
      expect(sizes.line?.bottom ?? Infinity, `lyric at ${width}x${height}`).toBeLessThanOrEqual(height + 0.5);
      for (const button of sizes.buttons) {
        expect(button.width, `${button.name} at ${width}x${height}`).toBeGreaterThan(0);
        expect(button.right, `${button.name} at ${width}x${height}`).toBeLessThanOrEqual(width + 0.5);
        expect(button.bottom, `${button.name} at ${width}x${height}`).toBeLessThanOrEqual(height + 0.5);
      }
    }
  });

  test('with word times, the line goes once it has been sung, through a break, until the next starts', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 140 });
    // Line 2 is sung from 3 s to 3.5 s, word by word; the next starts at 6 s.
    const sung = (start: number) => [{ start, end: start + .5, text: 'sung' }];
    await playing(page, 4, true, lyricLines.map(line => ({ ...line, end: (line.start ?? 0) + .5, words: sung(line.start ?? 0) })), 'exact');
    await page.goto('/');
    await expect(page.locator('.mini .mini-title')).toHaveText('Lyric Line');
    await expect(page.locator('.mini .mini-lyric')).toHaveText('');
  });

  test('with only line times, a line stays until the next starts, however short its estimated end', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 140 });
    // As timeWords estimates them: line 2 "ends" at 3.5 s, long before a slow song moves on at 6 s.
    await playing(page, 4, true, lyricLines.map(line => ({ ...line, end: (line.start ?? 0) + .5 })), 'estimated');
    await page.goto('/');
    await expect(page.locator('.mini .mini-lyric')).toHaveText('Line 2 of the lyric');
  });

  test('a long line wraps rather than being cut short, and moves nothing else', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 140 });
    const long = 'And every word of this one carries on past where one line stops';
    await playing(page, 4, true, lyricLines.map((line, i) => i === 1 ? { ...line, text: long } : line));
    await page.goto('/');
    const mini = page.locator('.mini');
    const line = mini.locator('.mini-lyric span');
    await expect(line).toHaveText(long);
    // Whole: more than one line, with nothing hidden past its edge.
    const fits = await line.evaluate(element => ({ lines: Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)), hidden: element.scrollHeight > element.clientHeight + 1 }));
    expect(fits.lines).toBeGreaterThan(1);
    expect(fits.hidden).toBe(false);
    // Without the line, the song, the squiggle, and the buttons stay where they were.
    const where = () => mini.evaluate(element => ['.mini-title', '.squiggle', '.mini-controls'].map(selector => { const r = element.querySelector(selector)!.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
    const before = await where();
    await page.addStyleTag({ content: '.mini-lyric span { display: none !important; }' });
    expect(await where()).toEqual(before);
  });

  test('a line with word times fills word by word, as the lyric sheet does', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 140 });
    // Line 2, from 3 s: "sung" from 3 to 3.4, "half" from 3.4 to 4.4, "later" from 6 to 7. Paused at
    // 3.8 s (read 0.1 s ahead, as the sheet does), "sung" is full, "half" halfway, "later" not begun.
    const words = [{ start: 3, end: 3.4, text: 'sung ' }, { start: 3.4, end: 4.4, text: 'half ' }, { start: 6, end: 7, text: 'later' }];
    await playing(page, 3.8, true, lyricLines.map((line, i) => i === 1 ? { ...line, end: 8, text: 'sung half later', words } : line));
    await page.goto('/');
    const spans = page.locator('.mini .mini-lyric .word');
    await expect(spans).toHaveText(['sung', 'half', 'later']);
    // Shown, in reading order on the line, inside it (each word laid out on its own, not over the others).
    const boxes = await spans.evaluateAll(elements => elements.map(element => { const r = element.getBoundingClientRect(); return { x: r.x, width: r.width, height: r.height }; }));
    const line = (await page.locator('.mini .mini-lyric').boundingBox())!;
    for (const box of boxes) { expect(box.width).toBeGreaterThan(10); expect(box.height).toBeGreaterThan(10); }
    expect(boxes[0].x).toBeLessThan(boxes[1].x);
    expect(boxes[1].x).toBeLessThan(boxes[2].x);
    expect(boxes[0].x).toBeGreaterThanOrEqual(line.x - 4);
    await expect(spans.first()).toBeVisible();
    const fill = await spans.evaluateAll(elements => elements.map(element => Number(element.style.getPropertyValue('--p') || 0)));
    expect(fill[0]).toBe(1);
    expect(fill[1]).toBeGreaterThan(0.3);
    expect(fill[1]).toBeLessThan(0.7);
    expect(fill[2]).toBe(0);
  });

  test('on Windows, with no system frame, the window resizes from its own edges', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 112 });
    await playing(page, 4);
    await page.addInitScript(() => {
      const shell = (window as unknown as { squiggly: { window: Record<string, unknown> }; resized: object[] });
      shell.resized = [];
      shell.squiggly.window.ownResize = true;
      shell.squiggly.window.resizeMini = async (bounds: object) => { shell.resized.push(bounds); return { ok: true, value: undefined }; };
    });
    await page.goto('/');
    const edge = page.locator('.mini-edge.e');
    await expect(page.locator('.mini-edge')).toHaveCount(8);
    const box = (await edge.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 82, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    const last = await page.evaluate(() => (window as unknown as { resized: { width: number; height: number }[] }).resized.at(-1));
    expect(last?.width).toBeGreaterThan(470);
    expect(last?.height).toBe(await page.evaluate(() => window.outerHeight));
  });

  test('lyrics as LRCLIB gives them, line times only, show as words the page times itself', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 140 });
    // No word times and no wordTiming: the page estimates words (timeWords), as for most lyrics.
    await playing(page, 4, true, lyricLines, 'left out');
    await page.goto('/');
    const line = page.locator('.mini .mini-lyric');
    await expect(line).toHaveText('Line 2 of the lyric');
    await expect(line.locator('.word')).toHaveCount(5);
    for (const word of await line.locator('.word').all()) await expect(word).toBeVisible();
    const [first, last] = await Promise.all([line.locator('.word').first().boundingBox(), line.locator('.word').last().boundingBox()]);
    expect(last!.x).toBeGreaterThan(first!.x + 40);
  });

  test('a new line scrolls in as the last one scrolls out, which then goes', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 140 });
    // Playing from 5.7 s: line 3 starts at 6 s.
    await playing(page, 5.7, true, lyricLines, null, true);
    // Every line seen leaving, with how it left.
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { left: string[] }).left = seen;
      new MutationObserver(() => {
        for (const element of document.querySelectorAll<HTMLElement>('.mini-lyric > .leaving')) {
          const entry = `${element.textContent}|${getComputedStyle(element).animationName}`;
          if (!seen.includes(entry)) seen.push(entry);
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/');
    const line = page.locator('.mini .mini-lyric');
    await expect(line.locator('span:not(.leaving)')).toHaveText('Line 3 of the lyric', { timeout: 3000 });
    // On its way out, the last line rises and fades; the new one rises in.
    const names = await line.evaluate(element => [...element.children].map(child => [child.className, child.textContent, getComputedStyle(child).animationName]));
    expect(names).toContainEqual(['', 'Line 3 of the lyric', 'lyric-in']);
    expect(await page.evaluate(() => (window as unknown as { left: string[] }).left)).toEqual(['Line 2 of the lyric|lyric-out']);
    // Once out, it's gone.
    await expect(line.locator('.leaving')).toHaveCount(0, { timeout: 2000 });
    await expect(line).toHaveText('Line 3 of the lyric');
  });
});
