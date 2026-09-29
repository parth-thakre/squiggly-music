import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compileEntry } from '../../../apps/desktop/main/extensions/compile';
import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test } from '../fixtures/test';

// The window's extension runtime with a real compiled example. The stand-in bridge
// (fixtures/desktop.ts) lists the extensions, and their modules are served from this origin
// in place of squiggly-ext://. What runs in the page is the app's own runtime and context.
const examples = resolve('examples/extensions');
let sleepTimer = '';
test.beforeAll(async () => { sleepTimer = (await compileEntry(join(examples, 'sleep-timer/src/index.ts'), join(examples, 'sleep-timer'))).code; });

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.tags.includes('@slots')) return;
  await page.route('**/__extensions/*.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: route.request().url().endsWith('/broken.js') ? 'export default { activate() { throw new Error("boom"); } };' : sleepTimer,
  }));
  await installDesktopBridge(page, { extensions: [
    { id: 'sleep-timer', name: 'Sleep timer example', url: '/__extensions/sleep-timer.js' },
    { id: 'broken', name: 'Broken', url: '/__extensions/broken.js' },
    { id: 'typo', name: 'Typo', url: '/__extensions/typo.js', error: 'src/index.ts:1:17: Expected "}" but found end of file' },
  ] });
});

test('an extension adds commands to the palette, and they run', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Commands' });
  await palette.getByRole('combobox').fill('sleep');
  const start = palette.getByRole('option', { name: /^Start the example sleep timer/ });
  await expect(start).toContainText('Sleep timer example');
  await start.click();
  await expect(page.getByText('Pausing in 30 minutes.')).toBeVisible();
  // Its `when` now lets the cancel command show.
  await page.keyboard.press('Control+k');
  await palette.getByRole('combobox').fill('cancel the example');
  await expect(palette.getByRole('option', { name: /^Cancel the example sleep timer/ })).toBeVisible();
});

test('Settings lists extensions with their errors, and turning one off takes its commands away', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.locator('.extensions-settings');
  await expect(section.getByText('extensions/sleep-timer · sleep-timer')).toBeVisible();
  // A compile error from the main process, and an activate() that threw in this window.
  await expect(section.getByRole('alert').filter({ hasText: 'Expected "}"' })).toBeVisible();
  await expect(section.getByRole('alert').filter({ hasText: 'The renderer entry failed to start: boom' })).toBeVisible();

  await section.getByRole('checkbox', { name: /^Sleep timer example/ }).uncheck();
  await expect(section.getByRole('status')).toHaveText('Turned off Sleep timer example.');
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: 'Commands' }).getByRole('combobox').fill('sleep');
  await expect(page.getByRole('dialog', { name: 'Commands' }).getByRole('status')).toHaveText('Nothing matches “sleep”.');
  await page.keyboard.press('Escape');

  // Remove asks first, then moves the folder to the trash.
  await section.getByRole('listitem').filter({ hasText: 'Sleep timer example' }).getByRole('button', { name: 'Remove' }).click();
  await expect(section.getByText('Move this folder to the trash? Its settings are removed too.')).toBeVisible();
  await section.getByRole('listitem').filter({ hasText: 'Sleep timer example' }).getByRole('button', { name: 'Remove' }).click();
  await expect(section.getByRole('status')).toHaveText('Moved Sleep timer example to the trash.');
  await expect(section.getByText('extensions/sleep-timer · sleep-timer')).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { bridgeCalls: string[] }).bridgeCalls)).toContain('remove:sleep-timer');
});

// Deck slots and Playlists sections, from the deck-note example and a test extension in two
// versions: Reload all serves the second, as saving an edit would.
const decker = (version: 1 | 2) => `
import { defineExtension } from '@squiggly/extension-api';
export default defineExtension({
  activate(ctx) {
    ${version === 1 ? `
    ctx.deck.register({ id: 'hello', placement: 'under-title', component: ({ track }) => <p>Hello from the deck, {track.title}.</p> });
    ctx.deck.register({ id: 'broken', placement: 'under-controls', component: () => { throw new Error('slot boom'); } });
    ctx.navigation.registerSection({ id: 'broken', title: 'Broken shelf', component: () => { throw new Error('section boom'); } });
    ` : `
    ctx.deck.register({ id: 'tall', placement: 'under-controls', component: () => <div>{Array.from({ length: 20 }, (_, i) => <p key={i}>Second version, line {i + 1}.</p>)}</div> });
    `}
    ctx.navigation.registerSection({ id: 'shelf', title: 'From the shelf', component: () => <p>Three records to hear next.</p> });
    ctx.navigation.registerPage({ id: 'page', title: 'Shelf page', component: () => <p>The whole shelf.</p> });
    ctx.commands.register({ id: 'mark', title: 'Mark the song', keys: ['ctrl+alt+m'], run: () => ctx.notify('Marked in the ' + ctx.window + ' window.') });
  },
});`;
// Three quiet lines, one of them long, for the mini player's small window.
const lines = `
import { defineExtension } from '@squiggly/extension-api';
export default defineExtension({
  activate(ctx) {
    ctx.deck.register({ id: 'one', placement: 'quiet-line', component: () => <span>First quiet line.</span> });
    ctx.deck.register({ id: 'two', placement: 'quiet-line', component: () => <span>Second quiet line, which goes on well past the edge of the window.</span> });
    ctx.deck.register({ id: 'three', placement: 'quiet-line', component: () => <span>Third.</span> });
  },
});`;
// Runs in both windows: its slot throws in the mini player only, and its settings are handed to
// the test.
const twin = `
import { defineExtension } from '@squiggly/extension-api';
export default defineExtension({
  activate(ctx) {
    (globalThis as { extensionSettings?: unknown }).extensionSettings = ctx.settings;
    ctx.deck.register({ id: 'window', placement: 'quiet-line', component: () => {
      if (ctx.window === 'mini') throw new Error('mini boom');
      return <span>Fine in the main window.</span>;
    } });
  },
});`;
const bundles: Record<string, string> = {};
test.beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'squiggly-slots-'));
  try {
    const sources: Record<string, string> = { 'decker-1': decker(1), 'decker-2': decker(2), lines, twin };
    for (const [name, source] of Object.entries(sources)) {
      await writeFile(join(dir, `${name}.tsx`), source);
      bundles[name] = (await compileEntry(join(dir, `${name}.tsx`), dir)).code;
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  bundles['deck-note'] = (await compileEntry(join(examples, 'deck-note/src/index.tsx'), join(examples, 'deck-note'))).code;
});
const song = {
  id: 'song-1', title: 'Dawn Chorus', artist: 'The Larks', album: 'Morning', duration: 200, source: 'navidrome',
  sourceFormat: 'flac', sourceSampleRate: 44100, sourceBitDepth: 16, year: 1977, albumId: 'album-1', artistId: 'artist-1', coverArt: null,
};
const names: Record<string, string> = { 'deck-note': 'Deck note', decker: 'Decker', lines: 'Lines', twin: 'Twin' };
const withSlots = async (page: import('@playwright/test').Page, mini = false, ids = ['deck-note', 'decker']) => {
  await page.route(/\/__extensions\//, route => {
    const url = new URL(route.request().url());
    const name = url.pathname.split('/').pop()!.replace(/\.js$/, '');
    const body = name === 'decker' ? bundles[url.searchParams.has('v') ? 'decker-2' : 'decker-1'] : bundles[name];
    return body ? route.fulfill({ contentType: 'text/javascript', body }) : route.fulfill({ status: 404 });
  });
  await installDesktopBridge(page, {
    mini, player: { queue: [song], entryIds: ['entry-1'], currentIndex: 0, duration: 200 },
    extensions: ids.map(id => ({ id, name: names[id]!, url: `/__extensions/${id}.js` })),
  });
};

test.describe('deck slots and sections', { tag: '@slots' }, () => {
  test('slots show in the deck within their bounds, a throwing one shows nothing, and a reload replaces them', async ({ page }) => {
    await withSlots(page);
    await page.goto('/');
    const deck = page.getByRole('complementary', { name: 'Now playing' });
    // deck-note's quiet line: the song carries a year.
    await expect(deck.locator('.deck-slot.quiet-line')).toHaveText('From 1977.');
    await expect(deck.locator('.deck-text').getByText('Hello from the deck, Dawn Chorus.')).toBeVisible();
    await expect(deck.locator('[data-slot="decker:broken"]')).toBeEmpty();
    // The rest of the deck carries on.
    await expect(deck.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.locator('.extensions-settings');
    await expect(settings.getByRole('alert').filter({ hasText: 'The deck slot “decker:broken” failed: slot boom' })).toBeVisible();

    await settings.getByRole('button', { name: 'Reload all' }).click();
    await expect(settings.getByRole('status')).toHaveText('Reloaded every extension.');
    await expect(deck.getByText('Hello from the deck, Dawn Chorus.')).toHaveCount(0);
    await expect(deck.locator('[data-slot="decker:broken"]')).toHaveCount(0);
    const tall = deck.locator('[data-slot="decker:tall"]');
    await expect(tall).toContainText('Second version, line 1.');
    // Twenty lines are cut to the box; the quiet line stays one line.
    expect((await tall.boundingBox())!.height).toBeLessThan(100);
    expect((await deck.locator('.deck-slot.quiet-line').boundingBox())!.height).toBeLessThan(26);
    await expect(deck.locator('.deck-slot.quiet-line')).toHaveText('From 1977.');
    // The fixed version starts clean.
    await expect(settings.getByRole('alert').filter({ hasText: 'slot boom' })).toHaveCount(0);
  });

  test('sections and extension pages are listed on the Playlists page', async ({ page }) => {
    await withSlots(page);
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Library' }).getByRole('button', { name: 'Playlists', exact: true }).click();
    const main = page.locator('main.page');
    const shelf = main.getByRole('region', { name: 'From the shelf' });
    await expect(shelf.getByText('Three records to hear next.')).toBeVisible();
    await expect(main.getByRole('region', { name: 'Broken shelf' }).getByRole('alert')).toHaveText('This section stopped working: section boom');
    const pages = main.getByRole('region', { name: 'Extensions' });
    await pages.getByRole('button', { name: /^Shelf page/ }).click();
    await expect(main.getByText('The whole shelf.')).toBeVisible();

    // Turned off, its section and page go.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.extensions-settings').getByRole('checkbox', { name: /^Decker/ }).uncheck();
    await page.getByRole('navigation', { name: 'Library' }).getByRole('button', { name: 'Playlists', exact: true }).click();
    await expect(main.getByRole('heading', { name: 'Automatic' })).toBeVisible();
    await expect(main.getByRole('region', { name: 'From the shelf' })).toHaveCount(0);
    await expect(main.getByRole('region', { name: 'Extensions' })).toHaveCount(0);
  });

  test('the mini player runs extensions: their quiet lines show, and their keys work', async ({ page }) => {
    await withSlots(page, true);
    await page.goto('/');
    const mini = page.locator('.mini');
    await expect(mini.getByText('Dawn Chorus')).toBeVisible();
    await expect(mini.locator('.deck-slot.quiet-line')).toHaveText('From 1977.');
    // The other placements need the full deck.
    await expect(mini.getByText('Hello from the deck, Dawn Chorus.')).toHaveCount(0);
    await page.keyboard.press('Control+Alt+m');
    await expect(page.getByText('Marked in the mini window.')).toBeVisible();
  });

  test('quiet lines in the mini player leave the song, the squiggle, and the window buttons their room', async ({ page }) => {
    await withSlots(page, true, ['deck-note', 'lines']);
    const mini = page.locator('.mini');
    const box = async (locator: import('@playwright/test').Locator) => (await locator.boundingBox())!;
    // The window's default size, then its smallest.
    for (const [width, height] of [[420, 112], [320, 96]] as const) {
      await page.setViewportSize({ width, height });
      if (page.url() === 'about:blank') await page.goto('/');
      const slots = mini.locator('.deck-slot.quiet-line');
      await expect(slots).toHaveCount(4);
      await expect(mini.getByText('From 1977.')).toBeVisible();
      const title = await box(mini.locator('.mini-title'));
      const squiggle = await box(mini.locator('.squiggle'));
      const pin = await box(mini.getByRole('button', { name: 'Pin' }));
      expect(title.y).toBeGreaterThanOrEqual(0);
      if (width === 420) expect(squiggle.y + squiggle.height).toBeLessThanOrEqual(pin.y);
      // The slots share the window buttons' line, left of them and inside the window.
      const line = await box(mini.locator('.mini-slots'));
      expect(line.y).toBeGreaterThanOrEqual(pin.y - 1);
      expect(line.y + line.height).toBeLessThanOrEqual(Math.min(pin.y + pin.height + 1, height));
      expect(line.x + line.width).toBeLessThanOrEqual(pin.x);
      // Taking the slots away moves nothing else: they took no room from the song.
      await page.addStyleTag({ content: '.mini .deck-slot { display: none !important; }' });
      expect(await box(mini.locator('.mini-title'))).toEqual(title);
      expect(await box(mini.locator('.squiggle'))).toEqual(squiggle);
      expect(await box(mini.getByRole('button', { name: 'Pin' }))).toEqual(pin);
      await page.evaluate(() => document.head.lastElementChild!.remove());
    }
  });

  test('a slot that fails in the mini player alone is reported in Settings in the main window', async ({ page }) => {
    await withSlots(page, false, ['twin']);
    await page.goto('/');
    const deck = page.getByRole('complementary', { name: 'Now playing' });
    await expect(deck.locator('[data-slot="twin:window"]')).toHaveText('Fine in the main window.');
    const miniPage = await page.context().newPage();
    await withSlots(miniPage, true, ['twin']);
    await miniPage.goto('/');
    await expect(miniPage.locator('.mini-title')).toHaveText('Dawn Chorus');
    await expect(miniPage.locator('[data-slot="twin:window"]')).toBeEmpty();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.extensions-settings').getByRole('alert'))
      .toHaveText('In the mini player: The deck slot “twin:window” failed: mini boom');
    // The main window's own copy carries on.
    await expect(deck.locator('[data-slot="twin:window"]')).toHaveText('Fine in the main window.');
    // A new version starts clean: the report was about the last one.
    await page.locator('.extensions-settings').getByRole('button', { name: 'Reload all' }).click();
    await expect(page.locator('.extensions-settings').getByRole('status')).toHaveText('Reloaded every extension.');
    await expect(page.locator('.extensions-settings').getByRole('alert')).toHaveCount(0);
  });

  test('settings saved in both windows at the same moment keep both changes', async ({ page }) => {
    type Store = { set(key: string, value: unknown): Promise<void>; all(): Record<string, unknown> };
    const miniPage = await page.context().newPage();
    for (const [target, mini] of [[page, false], [miniPage, true]] as const) {
      await withSlots(target, mini, ['twin']);
      await target.goto('/');
      await target.waitForFunction(() => 'extensionSettings' in globalThis);
    }
    const settingsOf = (target: import('@playwright/test').Page) => target.evaluate(() => (globalThis as unknown as { extensionSettings: Store }).extensionSettings.all());
    for (let round = 0; round < 5; round++) {
      await Promise.all([
        page.evaluate(n => (globalThis as unknown as { extensionSettings: Store }).extensionSettings.set(`minutes-${n}`, n), round),
        miniPage.evaluate(n => (globalThis as unknown as { extensionSettings: Store }).extensionSettings.set(`enabled-${n}`, true), round),
      ]);
    }
    const expected = Object.fromEntries(Array.from({ length: 5 }, (_, n) => [[`minutes-${n}`, n], [`enabled-${n}`, true]]).flat());
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('squiggly.extension.twin')!))).toEqual(expected);
    await expect.poll(() => settingsOf(page)).toEqual(expected);
    await expect.poll(() => settingsOf(miniPage)).toEqual(expected);
  });
});
