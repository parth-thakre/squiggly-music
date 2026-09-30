import type { Page } from '@playwright/test';
import { expect, test, trackOf, type App } from '../fixtures/test';

// Home: where the app opens. Shelves of records played lately, the newest, and the most played,
// the automatic playlists, the saved queue, and what other accounts are playing. Each shelf loads
// by itself, except that Your mixes waits for Most played, and is hidden when it has nothing to show.
const shelf = (app: App, name: string) => app.main.getByRole('region', { name, exact: true });
const sleeves = (app: App, name: string) => shelf(app, name).locator('ul.grid > li');
const seeAll = (app: App, name: string) => shelf(app, name).getByRole('button', { name: /^See all/ });
const wordmark = (page: Page) => page.getByRole('button', { name: 'Squiggly home' });

test.describe('home', () => {
  test('opens by default, with the newest records and the automatic playlists, and nothing else to show', async ({ app, fake, page }) => {
    await app.signIn({ home: true });
    await expect(wordmark(page)).toHaveAttribute('aria-current', 'page');
    // No Home tab: the six tabs are all the bar has room for, and none is lit here.
    await expect(page.getByRole('navigation', { name: 'Library' }).locator('button[aria-current]')).toHaveCount(0);
    await expect(sleeves(app, 'Newest')).toHaveCount(12);
    await expect(sleeves(app, 'Newest').first()).toContainText('Test Pressing');
    expect(fake.callsTo('albums').map(call => call.args)).toEqual(expect.arrayContaining([['recent', 0, 12], ['newest', 0, 12], ['frequent', 0, 12]]));
    // The mixes, as Playlists lists them, without history: no On repeat or Lately.
    await expect(shelf(app, 'Your mixes').locator('.grid-name')).toHaveText(['Everything, shuffled', 'Recently added', 'Rock', 'Folk', 'Ambient']);
    // Nothing played, no saved queue, nobody else listening: those shelves aren't there at all.
    await expect(app.main.getByRole('heading', { level: 2 })).toHaveText(['Newest', 'Your mixes']);
    await expect(app.main.getByText('Played lately')).toHaveCount(0);
    await expect(app.main.getByText('Playing elsewhere')).toHaveCount(0);
    // A tile draws its songs once in view, as on Playlists, but the decades aren't looked for.
    expect(fake.callsTo('randomSongs').filter(call => (call.args[0] as { fromYear?: number }).fromYear)).toEqual([]);
    expect(fake.callsTo('nowPlaying')).toHaveLength(1);
  });

  test('shelves from listening history open Records in their sort, and Back returns Home', async ({ app, fake, page }) => {
    fake.recent = ['al-5', 'al-2', 'al-9'];
    fake.frequent = ['al-3', 'al-5'];
    await app.signIn({ home: true });
    await expect(app.main.getByRole('heading', { level: 2 })).toHaveText(['Played lately', 'Newest', 'Most played', 'Your mixes']);
    await expect(sleeves(app, 'Played lately').locator('.grid-name')).toHaveText(['Glass Orchard', 'Quiet Harbor', 'Paper Lanterns']);
    await expect(sleeves(app, 'Most played').locator('.grid-name')).toHaveText(['Amber Field', 'Glass Orchard']);
    await expect(shelf(app, 'Your mixes').locator('.grid-name')).toContainText(['On repeat', 'Lately']);

    const sort = app.main.getByRole('group', { name: 'Sort records' });
    for (const [name, pressed] of [['Played lately', 'Recently played'], ['Most played', 'Most played'], ['Newest', 'Newest']] as const) {
      await seeAll(app, name).click();
      await expect(app.heading).toHaveText('Records');
      await expect(sort.getByRole('button', { name: pressed, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(app.section('Records')).toHaveAttribute('aria-current', 'page');
      await page.goBack();
      await expect(app.heading).toHaveText('Home');
    }
    await seeAll(app, 'Your mixes').click();
    await expect(app.heading).toHaveText('Mixes');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(app.heading).toHaveText('Home');
  });

  test('a sleeve opens its record, plays from its button, and has the record menu', async ({ app }) => {
    await app.signIn({ home: true });
    const quiet = sleeves(app, 'Newest').filter({ hasText: 'Quiet Harbor' });
    await app.openMenuOn(quiet.getByRole('button', { name: /^Quiet Harbor/ }));
    await expect(app.menu.getByRole('menuitem', { name: 'Go to artist' })).toBeVisible();
    await app.page.keyboard.press('Escape');
    await expect(app.menu).toBeHidden();
    await quiet.hover();
    await quiet.getByRole('button', { name: 'Play Quiet Harbor' }).click();
    await app.expectPlaying('Opening 2');
    // As anywhere, playing a record shows the queue.
    await expect(app.heading).toHaveText('Queue');
    await app.page.goBack();
    await expect(app.heading).toHaveText('Home');
    // The sleeve now carries the playing mark before its name.
    await quiet.locator('button:not(.play-over)').click();
    await expect(app.heading).toHaveText('Quiet Harbor');
  });

  test('a mix opens its page, and a mix plays from its button', async ({ app }) => {
    await app.signIn({ home: true });
    const mixes = shelf(app, 'Your mixes');
    await mixes.getByRole('button', { name: /^Rock/ }).click();
    await expect(app.heading).toHaveText('Rock');
    await app.page.goBack();
    const everything = mixes.locator('li').filter({ hasText: 'Everything, shuffled' });
    await everything.hover();
    await everything.getByRole('button', { name: 'Play Everything, shuffled' }).click();
    await expect(app.deck.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  });

  test('a record played while a mix is on its way stays playing', async ({ app, fake, page }) => {
    // Set before the page loads: the tiles draw their songs as soon as they are in view, in no
    // fixed order, and the play button reuses Everything's draw, so every draw is slow from the start.
    fake.delay('randomSongs', 1500, 1500, 1500, 1500, 1500, 1500);
    await app.signIn({ home: true });
    const everything = shelf(app, 'Your mixes').locator('li').filter({ hasText: 'Everything, shuffled' });
    await everything.hover();
    await everything.getByRole('button', { name: 'Play Everything, shuffled' }).click();
    const quiet = sleeves(app, 'Newest').filter({ hasText: 'Quiet Harbor' });
    await quiet.hover();
    await quiet.getByRole('button', { name: 'Play Quiet Harbor' }).click();
    await app.expectPlaying('Opening 2');
    await expect(app.heading).toHaveText('Queue');
    // The mix's songs arrive after the record started; they don't replace it. Its tile and its play
    // button share one draw of sixty; the genre tiles' own draws of fifty are not this test's.
    await expect.poll(() => fake.callsTo('randomSongs').filter(call => (call.args[0] as { size: number }).size === 60).length).toBe(1);
    await page.waitForTimeout(2000);
    await expect(app.heading).toHaveText('Queue');
    await app.expectPlaying('Opening 2');
  });

  test('the saved queue is offered with its song and position, and goes once resumed', async ({ app, fake }) => {
    fake.saved = { tracks: ['tr-1-4', 'tr-1-1', 'tr-1-5'].map(id => ({ ...trackOf(id) })), currentIndex: 1, positionSeconds: 17, changed: null, changedBy: 'phone' };
    await app.signIn({ home: true });
    const card = shelf(app, 'Pick up where you left off');
    await expect(card).toContainText('Long Run');
    await expect(card).toContainText('Ada Brass, at 0:17, from phone');
    await expect(app.main.getByRole('heading', { level: 2 }).first()).toHaveText('Pick up where you left off');
    await card.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(app.deck.getByRole('heading', { level: 2 })).toHaveText('Long Run');
    // Resume plays from the saved position.
    await expect(app.deck.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect.poll(() => app.seconds()).toBeGreaterThanOrEqual(17);
    expect(await app.seconds()).toBeLessThan(30);
  });

  test('the saved queue is not offered while something plays', async ({ app, fake }) => {
    fake.saved = { tracks: [{ ...trackOf('tr-1-1') }], currentIndex: 0, positionSeconds: 5, changed: null, changedBy: null };
    await app.signIn({ home: true });
    const card = shelf(app, 'Pick up where you left off');
    await expect(card).toBeVisible();
    await sleeves(app, 'Newest').getByRole('button', { name: /^Quiet Harbor/ }).click();
    await expect(app.heading).toHaveText('Quiet Harbor');
    await app.play('Quiet Harbor', 'Opening 2');
    await app.page.goBack();
    await expect(app.heading).toHaveText('Home');
    await expect(card).toHaveCount(0);
  });

  test('other accounts\' songs are listed, this account\'s left out, and read again on each visit', async ({ app, fake, page }) => {
    fake.listening = [{ username: 'sam', trackId: 'tr-2-1' }, { username: 'tester', trackId: 'tr-3-1' }, { username: 'robin', trackId: 'tr-1-2' }];
    await app.signIn({ home: true });
    const elsewhere = shelf(app, 'Playing elsewhere');
    await expect(elsewhere.getByRole('listitem')).toHaveText(['sam · Opening 2 by Bell Tower', 'robin · Lyric Line by Ada Brass']);
    // A song opens its record.
    await elsewhere.getByRole('button', { name: 'Lyric Line' }).click();
    await expect(app.heading).toHaveText('Test Pressing');
    fake.listening = [];
    await page.goBack();
    await expect(app.heading).toHaveText('Home');
    await expect(shelf(app, 'Newest')).toBeVisible();
    await expect.poll(() => fake.callsTo('nowPlaying').length).toBe(2);
    await expect(elsewhere).toHaveCount(0);
  });

  test('a slow shelf holds up only itself', async ({ app, fake }) => {
    fake.recent = ['al-5'];
    // Played lately asks first; Newest and the rest arrive while it waits.
    fake.delay('albums', 2500);
    await app.signIn({ home: true });
    await expect(sleeves(app, 'Newest')).toHaveCount(12);
    await expect(shelf(app, 'Your mixes')).toBeVisible();
    await expect(shelf(app, 'Played lately')).toHaveCount(0);
    await expect(sleeves(app, 'Played lately')).toHaveCount(1, { timeout: 5000 });
  });

  test('Your mixes waits for Most played, which says whether there is history', async ({ app, fake }) => {
    fake.frequent = ['al-3'];
    // Most played asks third; the mixes share its answer, so they arrive with it.
    fake.delay('albums', 0, 0, 2500);
    await app.signIn({ home: true });
    await expect(sleeves(app, 'Newest')).toHaveCount(12);
    await expect.poll(() => fake.callsTo('genres').length).toBe(1);
    await expect(shelf(app, 'Your mixes')).toHaveCount(0);
    await expect(shelf(app, 'Most played')).toHaveCount(0);
    await expect(sleeves(app, 'Most played')).toHaveCount(1, { timeout: 5000 });
    await expect(shelf(app, 'Your mixes').locator('.grid-name')).toContainText(['On repeat', 'Lately']);
    // The shelf's list of twelve is asked for once; the On repeat tile's own draw asks for ten.
    expect(fake.callsTo('albums').filter(call => call.args[0] === 'frequent' && call.args[2] === 12)).toHaveLength(1);
  });

  test('a shelf that fails says why', async ({ app, fake }) => {
    fake.failNext('albums', 'The server is busy.');
    await app.signIn({ home: true });
    await expect(shelf(app, 'Played lately')).toContainText('The server is busy.');
    await expect(seeAll(app, 'Played lately')).toHaveCount(0);
    await expect(sleeves(app, 'Newest')).toHaveCount(12);
  });

  test('the wordmark and G then H go Home', async ({ app, page }) => {
    await app.signIn();
    await wordmark(page).click();
    await expect(app.heading).toHaveText('Home');
    await page.goBack();
    await expect(app.heading).toHaveText('Records');
    await app.main.focus();
    await page.keyboard.press('g');
    await page.keyboard.press('h');
    await expect(app.heading).toHaveText('Home');
  });
});
