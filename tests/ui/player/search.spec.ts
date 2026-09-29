import { expect, test, type App } from '../fixtures/test';

// Search: All shows a few of each kind, and a kind that came back full offers "See all", its own
// tab, which pages through that kind alone. The tab is part of the place. Enter moves to the
// first result, Escape leaves the search, and searches you used are kept to pick again.
const field = (app: App) => app.page.getByRole('searchbox', { name: 'Search your library' });
const tabs = (app: App) => app.main.getByRole('group', { name: 'Show' });
const tab = (app: App, name: 'All' | 'Artists' | 'Records' | 'Songs') => tabs(app).getByRole('button', { name, exact: true });
const records = (app: App) => app.main.locator('ul.grid > li');
const recent = (app: App) => app.main.getByRole('region', { name: 'Recent searches' });
const stored = (app: App) => app.page.evaluate(() => localStorage.getItem('squiggly.searches'));

test.describe('search', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('All shows a few of each kind, See all opens its tab, and Back returns to the tab', async ({ app, fake, page }) => {
    await field(app).fill('e');
    await expect(app.heading).toHaveText('“e”');
    await expect(tab(app, 'All')).toHaveAttribute('aria-pressed', 'true');
    // 206 songs and 26 records match, more than All shows; the 5 artists all fit.
    await expect(app.tracks()).toHaveCount(40);
    await expect(records(app)).toHaveCount(16);
    await expect(app.main.getByRole('heading', { level: 2 })).toHaveText(['Songs', 'Records', 'Artists']);
    await expect(app.main.getByRole('button', { name: 'See all songs' })).toBeVisible();
    await expect(app.main.getByRole('button', { name: 'See all records' })).toHaveText('See all records');
    await expect(app.main.getByRole('button', { name: 'See all artists' })).toHaveCount(0);
    expect(fake.callsTo('search').map(call => call.args)).toEqual([['e']]);

    await app.main.getByRole('button', { name: 'See all records' }).click();
    await expect(tab(app, 'Records')).toHaveAttribute('aria-pressed', 'true');
    await expect(records(app)).toHaveCount(26);
    await expect(app.tracks()).toHaveCount(0);
    expect(fake.callsTo('search').at(-1)!.args).toEqual(['e', { artistCount: 0, albumCount: 60, songCount: 0, albumOffset: 0 }]);
    // Typing on a tab keeps the tab.
    await field(app).fill('ember');
    await expect(app.heading).toHaveText('“ember”');
    await expect(tab(app, 'Records')).toHaveAttribute('aria-pressed', 'true');
    await expect(records(app)).toHaveCount(1);

    await records(app).getByRole('button', { name: /^Ember Road/ }).click();
    await expect(app.heading).toHaveText('Ember Road');
    await page.goBack();
    await expect(app.heading).toHaveText('“ember”');
    await expect(tab(app, 'Records')).toHaveAttribute('aria-pressed', 'true');
    await expect(field(app)).toHaveValue('ember');

    await tab(app, 'Artists').click();
    await expect(app.main.locator('ul.names > li')).toHaveCount(0);
    await expect(app.main.getByText('No artists match “ember”. Check the spelling, or look under All.')).toBeVisible();
    await tab(app, 'All').click();
    await expect(app.main.getByRole('heading', { level: 2 })).toHaveText(['Records']);
    // Tabs replace the place, so Back leaves the search for the page before it.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(app.heading).toHaveText('Records');
  });

  test('the Songs tab loads 100 songs at a time as the list nears its end', async ({ app, fake }) => {
    fake.large = true;
    await field(app).fill('night');
    await expect(app.heading).toHaveText('“night”');
    await expect(app.tracks()).toHaveCount(40);
    await expect(app.main.getByRole('button', { name: 'See all records' })).toHaveCount(0);
    await app.main.getByRole('button', { name: 'See all songs' }).click();
    await expect(tab(app, 'Songs')).toHaveAttribute('aria-pressed', 'true');
    await expect(app.tracks()).toHaveCount(100);
    const pages = () => fake.callsTo('search').filter(call => call.args.length > 1).map(call => call.args[1]);
    expect(pages()).toEqual([{ artistCount: 0, albumCount: 0, songCount: 100, songOffset: 0 }]);

    await app.main.evaluate(main => main.scrollTo(0, main.scrollHeight));
    await expect.poll(() => pages().map(page => (page as { songOffset: number }).songOffset)).toEqual([0, 100]);
    await app.main.evaluate(main => main.scrollTo(0, main.scrollHeight));
    await expect.poll(() => pages().map(page => (page as { songOffset: number }).songOffset)).toEqual([0, 100, 200]);
    await app.main.evaluate(main => main.scrollTo(0, main.scrollHeight));
    await expect(app.row('Night Two 100')).toBeVisible();
    // Ten songs came back on the third page: that was the last.
    await app.main.evaluate(main => main.scrollTo(0, main.scrollHeight));
    await app.page.waitForTimeout(300);
    expect(pages()).toHaveLength(3);
    // A song plays from the tab like any song list.
    await app.rowButton(app.row('Night Two 100')).click();
    await app.expectPlaying('Night Two 100');
  });

  test('Enter moves to the first result and Escape leaves the search', async ({ app, page }) => {
    await app.section('Artists').click();
    await expect(app.heading).toHaveText('Artists');
    // Enter searches at once, without waiting for typing to settle.
    await field(app).fill('harbor');
    await field(app).press('Enter');
    await expect(app.heading).toHaveText('“harbor”');
    await expect(records(app).locator('button:not(.play-over)').first()).toBeFocused();
    await expect(records(app).first()).toContainText('Quiet Harbor');

    await field(app).focus();
    await page.keyboard.press('Escape');
    await expect(field(app)).toHaveValue('');
    await expect(app.heading).toHaveText('Artists');
    await expect(field(app)).toBeFocused();

    // On a tab, the first song.
    await field(app).fill('opening');
    await expect(app.heading).toHaveText('“opening”');
    await tab(app, 'Songs').click();
    await expect(app.tracks()).toHaveCount(29);
    await field(app).press('Enter');
    await expect(app.rowButton(app.tracks().first())).toBeFocused();

    // A search that finds nothing leaves focus in the field.
    await field(app).fill('zzz');
    await field(app).press('Enter');
    await expect(app.main.getByText('No songs match “zzz”. Check the spelling, or look under All.')).toBeVisible();
    await expect(field(app)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(app.heading).toHaveText('Artists');

    // Escape on the Search page opened with / returns too.
    await app.main.focus();
    await page.keyboard.press('/');
    await expect(app.heading).toHaveText('Search');
    await expect(field(app)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(app.heading).toHaveText('Artists');
  });

  test('searches you used are kept, newest first, and can be cleared', async ({ app, page }) => {
    await field(app).fill('harbor');
    await field(app).press('Enter');
    await expect(app.heading).toHaveText('“harbor”');
    // Opening something a search found keeps it too.
    await field(app).fill('amber');
    await expect(app.heading).toHaveText('“amber”');
    await records(app).getByRole('button', { name: /^Amber Field/ }).click();
    await expect(app.heading).toHaveText('Amber Field');
    // Only typed, never used: not kept.
    await field(app).fill('glass');
    await expect(app.heading).toHaveText('“glass”');
    await app.section('Records').click();
    await expect(app.heading).toHaveText('Records');
    expect(JSON.parse((await stored(app))!)).toEqual(['amber', 'harbor']);

    // / opens Search, which shows them under the empty field.
    await app.main.focus();
    await page.keyboard.press('/');
    await expect(app.heading).toHaveText('Search');
    await expect(app.main.getByText('Type an artist, record, or song.')).toBeVisible();
    await expect(recent(app).getByRole('listitem')).toHaveText(['amber', 'harbor']);
    await recent(app).getByRole('button', { name: 'harbor', exact: true }).click();
    await expect(app.heading).toHaveText('“harbor”');
    await expect(field(app)).toHaveValue('harbor');

    // Emptying the field on the search page shows them again, the one chosen now first.
    await field(app).fill('');
    await expect(app.heading).toHaveText('Search');
    await expect(recent(app).getByRole('listitem')).toHaveText(['harbor', 'amber']);
    await recent(app).getByRole('button', { name: 'Clear recent searches' }).click();
    await expect(recent(app)).toHaveCount(0);
    await expect(field(app)).toBeFocused();
    expect(await stored(app)).toBeNull();
  });

  test('keeps the last eight searches and nothing else', async ({ app, page }) => {
    await page.evaluate(() => localStorage.setItem('squiggly.searches', JSON.stringify(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'])));
    await page.reload();
    await expect(app.heading).toHaveText('Records');
    await field(app).fill('Harbor');
    await field(app).press('Enter');
    await expect(app.heading).toHaveText('“Harbor”');
    expect(JSON.parse((await stored(app))!)).toEqual(['Harbor', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']);
    // The same search again moves it to the top rather than adding it twice.
    await field(app).fill('q5');
    await field(app).press('Enter');
    await expect(app.heading).toHaveText('“q5”');
    expect(JSON.parse((await stored(app))!)).toEqual(['q5', 'Harbor', 'q1', 'q2', 'q3', 'q4', 'q6', 'q7']);
  });

  test('says when nothing matches and when the search failed', async ({ app, fake }) => {
    await field(app).fill('zzz');
    await expect(app.heading).toHaveText('“zzz”');
    await expect(app.main.getByText('Nothing matches “zzz”. Check the spelling or try fewer words.')).toBeVisible();
    await expect(app.main.getByRole('button', { name: /^See all/ })).toHaveCount(0);

    fake.failNext('search', 'The server did not respond within 15 seconds. Check your connection and try again.');
    await field(app).fill('harbour');
    await expect(app.heading).toHaveText('“harbour”');
    await expect(app.main.getByText('The server did not respond within 15 seconds. Check your connection and try again.')).toBeVisible();
    // Each tab asks again.
    await tab(app, 'Records').click();
    await expect(app.main.getByText('No records match “harbour”. Check the spelling, or look under All.')).toBeVisible();
  });
});
