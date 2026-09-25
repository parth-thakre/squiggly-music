import { expect, special, test } from '../fixtures/test';
import type { FakeNavidrome } from '../fixtures/library';

// Play reports count time actually listened, so these specs play the fixture audio four
// times faster (timeupdate steps stay near one second, under the player's two-second
// "that was a seek" cut-off). Nothing else about playback changes.
test.beforeEach(async ({ page, app }) => {
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      this.defaultPlaybackRate = 4; this.playbackRate = 4;
      return play.call(this);
    };
  });
  await app.signIn();
});

const reportsFor = (fake: FakeNavidrome, id: string) => () => fake.reports.filter(report => report.id === id).map(report => report.event);

test.describe('web play reporting', () => {
  test('one started and one finished report per real play, and a replay counts again', async ({ app, fake }) => {
    test.setTimeout(60_000);
    // Thirty Two lasts 32 s, so it counts as finished after 16 s of listening.
    await app.play('Test Pressing', 'Thirty Two');
    await expect.poll(reportsFor(fake, special.thirtyTwo)).toEqual(['started']);
    await expect.poll(reportsFor(fake, special.thirtyTwo), { timeout: 15_000 }).toEqual(['started', 'finished']);

    // Playing it again from the menu is a new play.
    await app.chooseFromMenu(app.row('Thirty Two'), 'Play');
    await expect.poll(reportsFor(fake, special.thirtyTwo)).toEqual(['started', 'finished', 'started']);
    await expect.poll(reportsFor(fake, special.thirtyTwo), { timeout: 15_000 }).toEqual(['started', 'finished', 'started', 'finished']);
    // The menu's Play queued this song alone; it plays on to its end: still two plays, no more.
    await expect(app.deck.getByRole('button', { name: 'Play', exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(app.clock).toHaveText('0:00');
    expect(reportsFor(fake, special.thirtyTwo)()).toEqual(['started', 'finished', 'started', 'finished']);
    expect(fake.reports.filter(report => report.id !== special.thirtyTwo)).toEqual([]);
  });

  test('moving the playing song in the queue does not count it again', async ({ app, page, fake }) => {
    test.setTimeout(45_000);
    await app.play('Test Pressing', 'Thirty Two');
    await expect.poll(reportsFor(fake, special.thirtyTwo)).toEqual(['started']);
    await app.openQueue();
    await app.rowButton(app.row('Thirty Two')).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => app.titles()).toEqual(['Long Run', 'Lyric Line', 'Thirty Two', 'Short Stop', 'Tail Light']);
    await app.expectPlaying('Thirty Two');
    await expect(app.deck.getByText('Next:')).toContainText('Short Stop', { timeout: 15_000 });
    await app.expectPlaying('Short Stop', { timeout: 10_000 });
    expect(reportsFor(fake, special.thirtyTwo)()).toEqual(['started', 'finished']);
  });

  test('songs of 30 seconds or less start but never finish', async ({ app, fake }) => {
    test.setTimeout(60_000);
    // Lyric Line (30 s) then Short Stop (8 s) play through, then Thirty Two starts.
    await app.play('Test Pressing', 'Lyric Line');
    await app.expectPlaying('Short Stop', { timeout: 15_000 });
    await app.expectPlaying('Thirty Two', { timeout: 10_000 });
    expect(reportsFor(fake, special.lyricLine)()).toEqual(['started']);
    expect(reportsFor(fake, special.shortStop)()).toEqual(['started']);
  });

  test('turning reporting off in Settings sends no reports', async ({ app, fake }) => {
    await app.deck.getByRole('button', { name: 'Settings' }).click();
    const setting = app.main.getByRole('checkbox', { name: /Report what you play/ });
    await expect(setting).toBeChecked();
    await setting.uncheck();
    await app.play('Test Pressing', 'Short Stop');
    await app.expectPlaying('Thirty Two', { timeout: 10_000 });
    // Short Stop played through; any report for it was sent seconds ago.
    expect(fake.reports).toEqual([]);
  });

  // Regression: a song that has ended and is started again from its own row (or the deck's Play
  // button) is a new play. player.toggle() reloads an ended element instead of resuming it.
  test('replaying a song that has ended, from its own row, counts as a new play', async ({ app, fake }) => {
    test.setTimeout(60_000);
    await app.openAlbum('Test Pressing');
    await app.chooseFromMenu(app.row('Thirty Two'), 'Play');
    await expect.poll(reportsFor(fake, special.thirtyTwo), { timeout: 15_000 }).toEqual(['started', 'finished']);
    // The queue holds only this song, so it stops at the end.
    await expect(app.deck.getByRole('button', { name: 'Play', exact: true })).toBeVisible({ timeout: 15_000 });
    await app.rowButton(app.row('Thirty Two')).click();
    await expect(app.deck.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect.poll(reportsFor(fake, special.thirtyTwo), { timeout: 15_000 }).toEqual(['started', 'finished', 'started', 'finished']);
  });
});
