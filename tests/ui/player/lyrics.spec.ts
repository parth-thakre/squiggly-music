import type { Locator, Page } from '@playwright/test';
import { expect, special, test, trackOf, wordLines } from '../fixtures/test';

// The room's --accent-text, and the ink, as the browser resolves them (rgb(...)).
const resolved = (page: Page, variable: string) => page.locator('.room').evaluate((room, name) => {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  room.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, variable);
const colorOf = (line: Locator) => line.evaluate(element => getComputedStyle(element).color);

test.describe('lyrics', () => {
  test.beforeEach(async ({ app }) => {
    await app.signIn();
    await app.play('Test Pressing', 'Lyric Line');
    await app.deck.getByRole('button', { name: 'Lyrics', exact: true }).click();
    await expect(app.main.getByRole('heading', { level: 1 })).toHaveText('Lyric Line');
  });

  test('the current synced line is in ink, never the accent, and advances with the song', async ({ app, page }) => {
    const current = app.main.locator('.lyric-lines li.current');
    await expect(current).toHaveText('Line 1 of the lyric');
    // The palette comes from the cover once it loads; wait until the room has taken its colours.
    await expect.poll(() => resolved(page, '--accent-text')).not.toBe('rgb(26, 26, 24)');
    const ink = await resolved(page, '--ink');
    const accentText = await resolved(page, '--accent-text');
    await expect.poll(() => colorOf(current)).toBe(ink);

    await expect(current).toHaveText('Line 2 of the lyric', { timeout: 6_000 });
    await expect.poll(() => colorOf(current)).toBe(ink);
    const past = app.main.locator('.lyric-lines li.past').first();
    await expect(past).toHaveText('Line 1 of the lyric');
    // Past lines settle to soft; upcoming ones are dimmer still.
    const soft = await resolved(page, '--soft');
    await expect.poll(() => colorOf(past)).toBe(soft);
    const upcoming = await colorOf(app.main.locator('.lyric-lines li:not(.current):not(.past)').first());
    expect([ink, soft]).not.toContain(upcoming);
    for (const line of await app.main.locator('.lyric-lines li').all()) expect(await colorOf(line)).not.toBe(accentText);
    await expect(app.main.locator('.lyric-lines li.current')).toHaveCount(1);
    // Line-timed lyrics get estimated words, and say so.
    await expect(current.locator('.word')).toHaveCount(5);
    await expect(app.main.locator('.lyrics-source')).toBeEmpty();
  });

  test('each line lights as its time arrives, not a report later', async ({ app, page }) => {
    // The player's audio elements aren't in the page; note whichever one plays next.
    await page.evaluate(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) { (window as unknown as { __audio: HTMLMediaElement }).__audio = this; return play.call(this); };
    });
    await app.pause();
    await app.deck.getByRole('button', { name: 'Play', exact: true }).click();
    await app.expectPlaying('Lyric Line');
    // Record the audio clock at every change of the current line, for three lines.
    const changes = await page.evaluate(async () => {
      const audio = (window as unknown as { __audio: HTMLMediaElement }).__audio;
      const list = document.querySelector('.lyric-lines')!;
      const seen: { text: string; at: number }[] = [];
      let last = list.querySelector('li.current')?.textContent ?? '';
      await new Promise<void>(done => {
        const observer = new MutationObserver(() => {
          const now = list.querySelector('li.current')?.textContent ?? '';
          if (now !== last) { last = now; seen.push({ text: now, at: audio.currentTime }); if (seen.length >= 3) { observer.disconnect(); done(); } }
        });
        observer.observe(list, { subtree: true, attributes: true, attributeFilter: ['class'] });
        setTimeout(() => { observer.disconnect(); done(); }, 12_000);
      });
      return seen;
    });
    expect(changes.length).toBeGreaterThanOrEqual(3);
    for (const change of changes) {
      const line = Number(/Line (\d+)/.exec(change.text)![1]);
      const start = (line - 1) * 3;
      // Lines light 0.1 s early by design; allow a frame or two either side.
      expect(change.at).toBeGreaterThan(start - .2);
      expect(change.at).toBeLessThan(start + .12);
    }
  });

  test('clicking a line seeks to it', async ({ app }) => {
    await app.main.getByRole('button', { name: 'Line 8 of the lyric' }).click();
    await expect(app.main.locator('.lyric-lines li.current')).toHaveText('Line 8 of the lyric');
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(21);
    expect(await app.seconds()).toBeLessThan(26);
    await expect(app.seek).toHaveAttribute('aria-valuetext', /^0:2\d of 0:30$/);
    await app.expectPlaying('Lyric Line');
  });

  test('clicking a line while paused seeks and plays', async ({ app }) => {
    await app.pause();
    await app.main.getByRole('button', { name: 'Line 5 of the lyric' }).click();
    await expect(app.main.locator('.lyric-lines li.current')).toHaveText('Line 5 of the lyric');
    await app.expectPlaying('Lyric Line');
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(13);
  });
});

// Word by Word has exact word times (tests/ui/fixtures/library.ts): a line every 4 s from 1 s.
type Sample = { line: number; t: number; p: (number | null)[] };
const LEAD = .1;
// The current line's word progress, with the audio clock, on every animation frame for `ms`.
async function sampleWords(page: Page, ms: number): Promise<Sample[]> {
  return page.evaluate(async ms => {
    const audio = (window as unknown as { __audio: HTMLMediaElement }).__audio;
    const out: Sample[] = [];
    const until = performance.now() + ms;
    await new Promise<void>(done => {
      const tick = () => {
        const li = document.querySelector<HTMLElement>('.lyric-lines li.current');
        if (li) out.push({ line: Number(li.dataset.line), t: audio.currentTime, p: [...li.querySelectorAll<HTMLElement>('.word')].map(word => word.dataset.progress === undefined ? null : Number(word.dataset.progress)) });
        if (performance.now() < until) requestAnimationFrame(tick); else done();
      };
      tick();
    });
    return out;
  }, ms);
}
// Progress a word should show at audio time t (with the sheet's lead), under exact timing.
const expected = (word: { start: number; end: number }, t: number) => Math.min(1, Math.max(0, (t + LEAD - word.start) / (word.end - word.start)));

test.describe('word by word', () => {
  const title = trackOf(special.wordByWord).title, album = trackOf(special.wordByWord).album;
  test.beforeEach(async ({ page }) => {
    // The player's audio elements aren't in the page; note whichever one plays.
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) { (window as unknown as { __audio: HTMLMediaElement }).__audio = this; return play.call(this); };
    });
  });

  test('words fill in order as they are sung, and the last is full before the next line', async ({ app, page }) => {
    await app.signIn();
    await app.play(album, title);
    await app.deck.getByRole('button', { name: 'Lyrics', exact: true }).click();
    await expect(app.main.locator('.lyric-lines li.current')).toHaveText(wordLines[0].text);
    await expect(app.main.locator('.lyrics-source')).toBeEmpty();
    // Lines 1 to 3 (1 s to about 12 s).
    const samples = (await sampleWords(page, 10_500)).filter(sample => sample.p.every(p => p !== null)) as { line: number; t: number; p: number[] }[];
    const lines = [...new Set(samples.map(sample => sample.line))];
    expect(lines.length).toBeGreaterThanOrEqual(3);
    let partial = 0;
    samples.forEach((sample, i) => {
      const words = wordLines[sample.line].words;
      expect(sample.p).toHaveLength(words.length);
      sample.p.forEach((p, k) => {
        // In order: a word starts only once the one before is full.
        if (k > 0 && p > 0) expect(sample.p[k - 1], `line ${sample.line} word ${k} at ${sample.t}`).toBe(1);
        // Never goes back while the line is current.
        const before = samples[i - 1];
        if (before?.line === sample.line) expect(p).toBeGreaterThanOrEqual(before.p[k]);
        // And follows the audio clock, give or take a frame or two.
        expect(p).toBeGreaterThanOrEqual(expected(words[k], sample.t - .06) - .001);
        expect(p).toBeLessThanOrEqual(expected(words[k], sample.t + .06) + .001);
        if (p > 0 && p < 1) partial++;
      });
      // The wipe reaches the last word before the next line takes over.
      const next = samples[i + 1];
      if (next && next.line !== sample.line) expect(sample.p.every(p => p === 1), `line ${sample.line} ended at ${sample.p}`).toBe(true);
    });
    // A soft wipe inside words, not whole-word switches.
    expect(partial).toBeGreaterThan(20);
    // Only the current line carries progress.
    await expect(app.main.locator('.lyric-lines li:not(.current) .word[data-progress]')).toHaveCount(0);
  });

  test('reduced motion lights whole words and drops the blur', async ({ app, page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.signIn();
    await app.play(album, title);
    await app.deck.getByRole('button', { name: 'Lyrics', exact: true }).click();
    await expect(app.main.locator('.lyric-lines li.current')).toHaveText(wordLines[0].text);
    const samples = (await sampleWords(page, 5_000)).filter(sample => sample.p.every(p => p !== null)) as { line: number; t: number; p: number[] }[];
    expect(samples.length).toBeGreaterThan(50);
    for (const sample of samples) {
      for (const [k, p] of sample.p.entries()) {
        expect([0, 1]).toContain(p);
        // Each word lights when it starts (with the lead), give or take a frame or two.
        const start = wordLines[sample.line].words[k].start;
        if (sample.t + LEAD > start + .06) expect(p).toBe(1);
        if (sample.t + LEAD < start - .06) expect(p).toBe(0);
      }
    }
    // Some samples caught a line part-way: whole words switching, one after another.
    expect(samples.some(sample => sample.p.includes(0) && sample.p.includes(1))).toBe(true);
    const far = app.main.locator('.lyric-lines li.far').first();
    await expect(far).toBeAttached();
    expect(await far.evaluate(element => getComputedStyle(element).filter)).toBe('none');
  });
});
