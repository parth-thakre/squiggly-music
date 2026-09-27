import { test as base, expect, type Locator, type Page } from '@playwright/test';
import type { FakeNavidrome } from './library';
import { startPreview, webPassword } from './server';

export { expect };
export { webPassword };
export { special, playlistIds, lyricLines, trackOf } from './library';

type Preview = Awaited<ReturnType<typeof startPreview>>;

// Every worker runs its own preview server and fake account, so tests in different workers
// never share state. Within a worker the account is reset before each test.
export const test = base.extend<{ fake: FakeNavidrome; app: App }, { preview: Preview }>({
  preview: [async ({}, use) => {
    const server = await startPreview();
    await use(server);
    await server.close();
  }, { scope: 'worker' }],
  baseURL: async ({ preview }, use) => { await use(preview.url); },
  fake: [async ({ preview }, use) => { preview.fake.reset(); await use(preview.fake); }, { auto: true }],
  app: async ({ page, preview }, use) => { await use(new App(page, preview.url)); },
});

// Locators and steps shared by the specs. They only use what a listener sees: roles, names, text.
export class App {
  constructor(readonly page: Page, readonly url: string) {}

  get deck() { return this.page.getByRole('complementary', { name: 'Now playing' }); }
  get main() { return this.page.locator('main.page'); }
  get heading() { return this.main.getByRole('heading', { level: 1 }); }
  get menu() { return this.page.getByRole('menu'); }
  get seek() { return this.deck.getByRole('slider', { name: /^Position in / }); }
  /** The squiggle's running clock (the first of its two time labels). */
  get clock() { return this.deck.locator('.squiggle-time').first(); }
  get signInPassword() { return this.page.getByLabel('Password'); }
  tracks(scope: Locator = this.main) { return scope.locator('ol.tracks > li'); }
  row(title: string, scope: Locator = this.main) { return this.tracks(scope).filter({ has: this.page.getByRole('button', { name: new RegExp(`^(Play|Pause|Resume) ${escape(title)}$`) }) }); }
  rowButton(row: Locator) { return row.locator('button.track'); }
  section(name: 'Records' | 'Artists' | 'Playlists' | 'Favorites') { return this.page.getByRole('navigation', { name: 'Library' }).getByRole('button', { name, exact: true }); }

  /** Signs in the way a browser does: the session cookie lands in this page's context. */
  async signIn() {
    const response = await this.page.request.post('/api/session', { data: { password: webPassword }, headers: { origin: this.url } });
    expect(response.status()).toBe(200);
    await this.page.goto('/');
    await expect(this.heading).toHaveText('Records');
  }
  async openAlbum(name: string) {
    await this.section('Records').click();
    await expect(this.heading).toHaveText('Records');
    await this.main.getByRole('list').first().getByRole('button', { name: new RegExp(escape(name)) }).click();
    await expect(this.heading).toHaveText(name);
  }
  async openPlaylist(name: string) {
    await this.section('Playlists').click();
    await expect(this.heading).toHaveText('Playlists');
    await this.main.getByRole('button', { name: new RegExp(escape(name)) }).click();
    await expect(this.heading).toHaveText(name);
  }
  /** Plays a song from its record page and waits until the browser is really playing it. */
  async play(album: string, title: string) {
    if ((await this.heading.textContent()) !== album) await this.openAlbum(album);
    await this.rowButton(this.row(title)).click();
    await this.expectPlaying(title);
  }
  async expectPlaying(title: string, { timeout }: { timeout?: number } = {}) {
    await expect(this.deck.getByRole('heading', { level: 2 })).toHaveText(title, { timeout });
    await expect(this.deck.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  }
  async pause() {
    await this.deck.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(this.deck.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  }
  /** Seconds shown by the deck's clock. */
  async seconds() { return toSeconds(await this.clock.textContent()); }
  async openMenuOn(target: Locator) {
    await target.click({ button: 'right' });
    await expect(this.menu).toBeVisible();
    return this.menu;
  }
  async chooseFromMenu(target: Locator, ...path: string[]) {
    await this.openMenuOn(target);
    for (const item of path) await this.menu.getByRole('menuitem', { name: item, exact: true }).click();
    await expect(this.menu).toBeHidden();
  }
  /** Phones show the deck as a strip; its controls live in the sheet it opens. */
  async openSheetIfNeeded(control: Locator) {
    if (await control.isVisible()) return;
    await this.deck.getByRole('button', { name: /^Open now playing: / }).click();
    await expect(this.deck).toHaveClass(/\bopen\b/);
  }
  async openQueue() {
    const queue = this.deck.getByRole('button', { name: 'Queue', exact: true });
    await this.openSheetIfNeeded(queue);
    await queue.click();
    await expect(this.heading).toHaveText('Queue');
  }
  async openSettings() {
    const settings = this.deck.getByRole('button', { name: 'Settings', exact: true });
    await this.openSheetIfNeeded(settings);
    await settings.click();
    await expect(this.heading).toHaveText('Settings');
  }
  /** The lyric sheet: a page on desktop, the now-playing sheet's lyrics on a phone. Returns its current line. */
  async openLyrics() {
    const lyrics = this.deck.getByRole('button', { name: 'Lyrics', exact: true });
    await this.openSheetIfNeeded(lyrics.first());
    await lyrics.filter({ visible: true }).click();
    const current = this.page.locator('.lyric-lines li.current');
    await expect(current).toBeVisible();
    return current;
  }
  /** The titles in the current song list, in order. */
  async titles(scope: Locator = this.main) { return this.tracks(scope).locator('.title .name').allTextContents(); }
}

export const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function toSeconds(clock: string | null) {
  const match = /^(\d+):(\d\d)$/.exec(clock?.trim() ?? '');
  if (!match) throw new Error(`Not a clock: ${clock}`);
  return Number(match[1]) * 60 + Number(match[2]);
}
