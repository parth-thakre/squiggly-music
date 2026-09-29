import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, test, trackOf } from '../fixtures/test';

// The Galaxy Z Flip's cover screen (the cover-flip6 and cover-flip7 projects): its own view of
// what's playing, with the queue and lyrics a tap away and nothing to press by the cameras.

// Where the cameras sit, as shares of the screen held upright, with a little room to spare. The
// Flip 5 and 6 screen steps up to make room for them in its bottom right: from about 45% of the
// width, the bottom 9% of the height. The Flip 7's flash and lenses are inside the screen along
// the bottom: Android reports the cutout as x ≥ 45%, the bottom 21%, and the flash starts near 43%.
const cameras = (project: string) => project.startsWith('cover-flip7') ? { left: .42, top: .785 } : { left: .43, top: .89 };

const screen = (page: Page) => page.getByRole('main');
const title = (page: Page) => screen(page).getByRole('heading', { level: 1 });

async function violations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(node => node.target.join(' ')).join(', ')}`);
}

// The controls whose visible part (clipped by any scrolling list they're in) reaches the cameras.
async function underCameras(page: Page, info: TestInfo) {
  const zone = cameras(info.project.name);
  return page.evaluate(({ left, top }) => {
    const width = innerWidth, height = innerHeight;
    const camera = { left: left * width, right: width, top: top * height, bottom: height };
    const hits: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex]:not([tabindex="-1"])')) {
      let box = element.getBoundingClientRect();
      if (!box.width || !box.height || getComputedStyle(element).visibility === 'hidden') continue;
      let rect = { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (getComputedStyle(node).overflow === 'visible') continue;
        box = node.getBoundingClientRect();
        rect = { left: Math.max(rect.left, box.left), right: Math.min(rect.right, box.right), top: Math.max(rect.top, box.top), bottom: Math.min(rect.bottom, box.bottom) };
      }
      if (rect.right <= rect.left || rect.bottom <= rect.top) continue;
      if (rect.left < camera.right && rect.right > camera.left && rect.top < camera.bottom && rect.bottom > camera.top) hits.push(element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName);
    }
    return hits;
  }, zone);
}

async function signIn(page: Page, url: string) {
  const response = await page.request.post('/api/session', { data: { password: 'squiggly test password' }, headers: { origin: url } });
  expect(response.status()).toBe(200);
  await page.goto('/');
  await expect(title(page)).toHaveText('Nothing playing');
}
// The newest record is Test Pressing (the fake server has no listening history).
async function playTestPressing(page: Page) {
  await screen(page).getByRole('button', { name: 'Play Test Pressing by Ada Brass' }).tap();
  await expect(title(page)).toHaveText('Long Run');
  await expect(screen(page).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
}
async function swipe(target: Locator, dx: number) {
  const box = (await target.boundingBox())!;
  const y = box.y + box.height / 2, x0 = box.x + box.width / 2;
  await target.evaluate((element, { x0, y, dx }) => {
    const fire = (type: string, x: number) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y }));
    fire('pointerdown', x0);
    for (let i = 1; i <= 8; i++) fire('pointermove', x0 + dx * i / 8);
    fire('pointerup', x0 + dx);
  }, { x0, y, dx });
}

test.describe('cover screen', () => {
  test('shows what is playing, and the transport works', async ({ page, app }, info) => {
    await signIn(page, app.url);
    // No library tabs or search: the cover screen is for what's playing.
    await expect(page.getByRole('navigation', { name: 'Library' })).toHaveCount(0);
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    expect(await underCameras(page, info), 'nothing playing').toEqual([]);
    await playTestPressing(page);
    await expect(screen(page)).toHaveAccessibleName('Now playing');
    await expect(screen(page).getByText('Ada Brass', { exact: true })).toBeVisible();
    await expect(screen(page).getByRole('slider', { name: 'Position in Long Run' })).toBeVisible();
    expect(await underCameras(page, info), 'now playing').toEqual([]);

    await screen(page).getByRole('button', { name: 'Next' }).tap();
    await expect(title(page)).toHaveText('Lyric Line');
    await screen(page).getByRole('button', { name: 'Previous' }).tap();
    await expect(title(page)).toHaveText('Long Run');
    await screen(page).getByRole('button', { name: 'Pause', exact: true }).tap();
    await expect(screen(page).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await screen(page).getByRole('button', { name: 'Play', exact: true }).tap();
    await expect(screen(page).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    // Every control is on screen and at least 48px across.
    for (const name of ['Previous', 'Pause', 'Next', 'Queue', 'Lyrics']) {
      await expect(screen(page).getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
      const box = (await screen(page).getByRole('button', { name, exact: true }).boundingBox())!;
      expect(Math.min(box.width, box.height), name).toBeGreaterThanOrEqual(48);
    }
  });

  test('the queue opens and closes, and a tap plays a song from it', async ({ page, app }, info) => {
    await signIn(page, app.url);
    await playTestPressing(page);
    await screen(page).getByRole('button', { name: 'Queue' }).tap();
    await expect(screen(page)).toHaveAccessibleName('Queue');
    await expect(screen(page).getByRole('button', { name: /^Long Run/ })).toHaveAttribute('aria-current', 'true');
    await expect(screen(page).getByText('4 songs up next')).toBeVisible();
    expect(await underCameras(page, info), 'queue').toEqual([]);
    for (const name of ['Back', 'Pause']) await expect(screen(page).getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
    expect(await violations(page), 'queue').toEqual([]);
    await screen(page).getByRole('button', { name: /^Short Stop/ }).tap();
    await expect(screen(page).getByRole('button', { name: /^Short Stop/ })).toHaveAttribute('aria-current', 'true');
    await screen(page).getByRole('button', { name: 'Back' }).tap();
    await expect(title(page)).toHaveText('Short Stop');

    // The back gesture closes it too.
    await screen(page).getByRole('button', { name: 'Queue' }).tap();
    await expect(screen(page)).toHaveAccessibleName('Queue');
    await page.goBack();
    await expect(title(page)).toHaveText('Short Stop');
  });

  test('lyrics open and close', async ({ page, app }, info) => {
    await signIn(page, app.url);
    await playTestPressing(page);
    await screen(page).getByRole('button', { name: 'Next' }).tap();
    await expect(title(page)).toHaveText('Lyric Line');
    await screen(page).getByRole('button', { name: 'Lyrics' }).tap();
    await expect(screen(page)).toHaveAccessibleName('Lyrics');
    await expect(page.locator('.lyric-lines li.current')).toBeVisible();
    expect(await underCameras(page, info), 'lyrics').toEqual([]);
    expect(await violations(page), 'lyrics').toEqual([]);
    // Pausing from the lyrics.
    await screen(page).getByRole('button', { name: 'Pause', exact: true }).tap();
    await expect(screen(page).getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await screen(page).getByRole('button', { name: 'Back' }).tap();
    await expect(title(page)).toHaveText('Lyric Line');
    await screen(page).getByRole('button', { name: 'Lyrics' }).tap();
    await page.goBack();
    await expect(title(page)).toHaveText('Lyric Line');
  });

  test('nothing playing: the saved queue resumes', async ({ page, app, fake }, info) => {
    fake.saved = { tracks: ['tr-1-4', 'tr-1-1', 'tr-1-5'].map(id => ({ ...trackOf(id) })), currentIndex: 1, positionSeconds: 17, changed: null, changedBy: 'phone' };
    await signIn(page, app.url);
    await expect(screen(page).getByText(/Pick up Long Run by Ada Brass, at 0:17/)).toBeVisible();
    expect(await underCameras(page, info), 'resume').toEqual([]);
    expect(await violations(page), 'nothing playing').toEqual([]);
    await screen(page).getByRole('button', { name: 'Resume' }).tap();
    await expect(title(page)).toHaveText('Long Run');
    await expect(screen(page).locator('.squiggle-time').first()).toHaveText('0:17');
    expect(await violations(page), 'now playing').toEqual([]);
  });

  test('nothing playing: Shuffle plays songs from anywhere', async ({ page, app, fake }) => {
    await signIn(page, app.url);
    await screen(page).getByRole('button', { name: 'Shuffle', exact: true }).tap();
    await expect(screen(page).getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect(title(page)).not.toHaveText('Nothing playing');
    expect(fake.callsTo('randomSongs').length).toBeGreaterThan(0);
  });

  test('swiping the sleeve changes songs', async ({ page, app }) => {
    await signIn(page, app.url);
    await playTestPressing(page);
    await swipe(screen(page).locator('.flip-sleeve'), -200);
    await expect(title(page)).toHaveText('Lyric Line');
    await swipe(screen(page).locator('.flip-sleeve'), 200);
    await expect(title(page)).toHaveText('Long Run');
  });

  test('unfolding opens the phone layout on the same song, with nothing left open', async ({ page, app }, info) => {
    await signIn(page, app.url);
    await playTestPressing(page);
    await screen(page).getByRole('button', { name: 'Queue' }).tap();
    await expect(screen(page)).toHaveAccessibleName('Queue');
    await page.setViewportSize({ width: 412, height: 860 });
    await app.expectPlaying('Long Run');
    await expect(app.heading).toHaveText('Records');
    await expect.poll(() => page.evaluate(() => (history.state as { overlay?: boolean }).overlay ?? false)).toBe(false);
    // Folding again returns to the cover view.
    await page.setViewportSize(info.project.use.viewport!);
    await expect(title(page)).toHaveText('Long Run');
    await expect(page.getByRole('navigation', { name: 'Library' })).toHaveCount(0);
  });
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('the sleeve settles in without moving', async ({ page, app }) => {
    await signIn(page, app.url);
    await playTestPressing(page);
    expect(await screen(page).locator('.flip-sleeve').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  });
});

// Everything else keeps its usual layout, whatever the project's own viewport.
const others = [
  { name: 'a phone', viewport: { width: 412, height: 860 } },
  { name: 'a phone on its side', viewport: { width: 915, height: 412 } },
  { name: 'a small phone on its side', viewport: { width: 640, height: 360 } },
  { name: 'a 4-inch phone on its side', viewport: { width: 568, height: 320 } },
  { name: 'split screen on a phone', viewport: { width: 412, height: 440 }, screen: { width: 412, height: 915 } },
  { name: "the Flip's main screen", viewport: { width: 360, height: 840 } },
  { name: 'a small phone', viewport: { width: 320, height: 520 }, screen: { width: 320, height: 568 } },
  { name: 'a small window on a computer', viewport: { width: 480, height: 480 }, screen: { width: 1920, height: 1080 }, mobile: false },
];
for (const other of others) {
  test.describe(`on ${other.name}`, () => {
    test.use({ viewport: other.viewport, contextOptions: other.screen ? { screen: other.screen } : {}, isMobile: other.mobile ?? true });
    test('the cover view stays away', async ({ page, app }, info) => {
      test.skip(info.project.name !== 'cover-flip6', 'Once is enough.');
      await app.signIn();
      await expect(page.locator('.flip-screen')).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Library' })).toBeVisible();
    });
  });
}
