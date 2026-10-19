import { installDesktopBridge } from '../fixtures/desktop';
import { allTracks, expect, special, test, trackOf } from '../fixtures/test';

// Autoplay: songs like the last one join the queue once it or the one before it plays, when turned on. Playing
// "Tail Light" from its record queues the record with it last. The fake server's similar songs are
// the library's songs off that record, in order.
const record = ['Long Run', 'Lyric Line', 'Short Stop', 'Thirty Two', 'Tail Light'];
const similar = allTracks.filter(track => track.albumId !== special.album).map(track => track.title);
// Autoplay on, and repeat all, as the browser keeps them. Set once: a reload keeps what the page changed.
const stored = () => {
  if (sessionStorage.getItem('stored')) return;
  sessionStorage.setItem('stored', '1');
  localStorage.setItem('squiggly.settings', JSON.stringify({ autoplay: true }));
  localStorage.setItem('squiggly.playModes', JSON.stringify({ repeat: 'all', shuffle: false }));
};

test.describe('autoplay', () => {
  test('is off at first; the last song offers it, and turning it on adds ten songs like it, marked', async ({ app, fake }) => {
    await app.signIn();
    await app.play('Test Pressing', 'Tail Light');
    await app.openQueue();
    await expect(app.main.getByText('This is the last song.')).toBeVisible();
    expect(fake.callsTo('similarSongs')).toEqual([]);
    await app.main.getByRole('button', { name: 'Keep playing similar songs' }).click();

    await expect.poll(() => app.titles()).toEqual([...record, ...similar.slice(0, 10)]);
    expect(fake.callsTo('similarSongs').map(call => call.args)).toEqual([[special.tailLight, 30]]);
    await expect(app.main.getByRole('heading', { name: 'Added by autoplay' })).toHaveCount(1);
    await expect(app.main.getByText('10 songs up next')).toBeVisible();
    await expect(app.deck.getByText('Next:')).toContainText(similar[0]);
    await expect(app.tracks().nth(4)).toHaveClass(/\bnow\b/);

    // Turned off where it's noticed: the songs it added stay, marked, and nothing more comes.
    await app.main.getByRole('button', { name: 'Turn off autoplay' }).click();
    await expect(app.main.getByRole('button', { name: 'Turn off autoplay' })).toHaveCount(0);
    await expect(app.main.getByRole('heading', { name: 'Added by autoplay' })).toHaveCount(1);
    await app.openSettings();
    await expect(app.main.getByRole('checkbox', { name: /^Keep playing similar songs/ })).not.toBeChecked();
    expect(await app.page.evaluate(() => JSON.parse(localStorage.getItem('squiggly.settings') ?? '{}').autoplay)).toBe(false);
  });

  test('turned on in Settings, it waits out repeat and says when the server has nothing like the song', async ({ app, fake, page }) => {
    await page.addInitScript(stored);
    await app.signIn();
    // Repeat all: the queue never runs out, so nothing is added until repeat is off again.
    await app.play('Test Pressing', 'Tail Light');
    await expect(app.deck.getByRole('button', { name: 'Repeat all', exact: true })).toBeVisible();
    await app.openQueue();
    await page.waitForTimeout(500);
    expect(fake.callsTo('similarSongs')).toEqual([]);
    expect(await app.titles()).toEqual(record);
    await app.deck.getByRole('button', { name: 'Repeat all', exact: true }).click();
    await app.deck.getByRole('button', { name: 'Repeat one', exact: true }).click();
    await expect.poll(() => app.titles()).toEqual([...record, ...similar.slice(0, 10)]);

    // A server with nothing similar: nothing is added, and the deck and the queue say so. The
    // menu's Play queues the song alone.
    fake.similar = false;
    await app.deck.getByRole('button', { name: 'Test Pressing', exact: true }).click();
    await expect(app.heading).toHaveText('Test Pressing');
    await app.chooseFromMenu(app.row('Tail Light'), 'Play');
    await expect(app.deck.getByText('Autoplay found nothing new like this song.')).toBeVisible();
    await app.openQueue();
    await expect(app.main.getByText('Autoplay found nothing new like this song on your server, so the queue ends here.')).toBeVisible();
    expect(await app.titles()).toEqual(['Tail Light']);
    // Asked once, and not again for that entry.
    expect(fake.callsTo('similarSongs').slice(1).map(call => call.args)).toEqual([[special.tailLight, 30]]);
    await app.page.waitForTimeout(500);
    expect(fake.callsTo('similarSongs')).toHaveLength(2);
    await app.openSettings();
    await expect(app.main.getByRole('checkbox', { name: /^Keep playing similar songs/ })).toBeChecked();
  });
  test('it asks on the next-to-last song, and Next on the last while it asks moves on when the songs are in', async ({ app, fake, page }) => {
    await page.addInitScript(() => { localStorage.setItem('squiggly.settings', JSON.stringify({ autoplay: true })); });
    await app.signIn();
    // A server slow to answer, as one asking Last.fm can be.
    fake.delay('similarSongs', 1500);
    await app.play('Test Pressing', 'Thirty Two');
    // Asked about the last song while the one before it plays.
    await expect.poll(() => fake.callsTo('similarSongs').map(call => call.args)).toEqual([[special.tailLight, 30]]);
    // Skipping through: on to the last song, then Next again before the answer is in.
    await app.deck.getByRole('button', { name: 'Next', exact: true }).click();
    await app.expectPlaying('Tail Light');
    await app.deck.getByRole('button', { name: 'Next', exact: true }).click();
    await app.expectPlaying(similar[0], { timeout: 5000 });
    await app.openQueue();
    expect(await app.titles()).toEqual([...record, ...similar.slice(0, 10)]);
  });

  test('a sleep timer set while the server answers stops what the answer would have added', async ({ app, fake, page }) => {
    await page.addInitScript(() => { localStorage.setItem('squiggly.settings', JSON.stringify({ autoplay: true })); });
    await app.signIn();
    fake.delay('similarSongs', 1500);
    await app.play('Test Pressing', 'Tail Light');
    await expect.poll(() => fake.callsTo('similarSongs').length).toBe(1);
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Commands' });
    await palette.getByRole('combobox', { name: 'Find a command' }).fill('Sleep after this song');
    await page.keyboard.press('Enter');
    await expect(app.deck.getByText('Sleeps after this song')).toBeVisible();
    await page.waitForTimeout(2000);
    await app.openQueue();
    expect(await app.titles()).toEqual(record);
    expect(fake.callsTo('similarSongs')).toHaveLength(1);
  });
});

test('the desktop marks the entries its main process says autoplay added', async ({ page }) => {
  await installDesktopBridge(page, { settings: { autoplay: true } });
  await page.goto('/');
  const queue = ['tr-1-1', 'tr-1-5', 'tr-2-1', 'tr-2-2', 'tr-1-2'].map(trackOf);
  await page.evaluate(value => (window as unknown as { pushPlayer(p: object): void }).pushPlayer(value), {
    queue, entryIds: ['e1', 'e2', 'e3', 'e4', 'e5'], currentIndex: 1, playId: 'p.1', playing: true, duration: 20,
    autoplay: { added: ['e3', 'e4'], missed: null },
  });
  await page.getByRole('complementary', { name: 'Now playing' }).getByRole('button', { name: 'Queue', exact: true }).click();
  const main = page.locator('main.page');
  // One quiet heading, above the first song autoplay added; the song after them isn't marked.
  const rows = main.locator('ol.tracks > li');
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(2)).toHaveClass(/\bgroup-head\b/);
  await expect(rows.nth(2)).toHaveText('Added by autoplay');
  await expect(main.getByText('Autoplay adds songs like the last one when the queue runs out.')).toBeVisible();
});
