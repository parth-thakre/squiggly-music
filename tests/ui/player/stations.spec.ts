import type { Locator } from '@playwright/test';
import { expect, playlistIds, stationIds, test, type App } from '../fixtures/test';

// Internet radio stations from the server, on the Playlists page. A station plays as a live
// stream: the fixture server sends an endless WAV (fixtures/server.ts), and the page only ever
// asks for /api/station?id=..., never the station's own address.

async function openStations(app: App) {
  await app.section('Playlists').click();
  await expect(app.heading).toHaveText('Playlists');
  const stations = app.main.getByRole('region', { name: 'Stations' });
  await expect(stations.getByRole('listitem')).toHaveCount(2);
  return stations;
}
const row = (app: App, name: string) => app.main.getByRole('region', { name: 'Stations' }).getByRole('listitem')
  .filter({ has: app.page.getByRole('button', { name: `Play ${name}`, exact: true }) });

// Drag and drop as drag-drop.spec.ts dispatches it, one DataTransfer kept on window between
// steps, so a drag can start on the queue and land in a playlist after navigating.
type Dragging = Window & { dragData?: DataTransfer };
const dragStart = (source: Locator) => source.evaluate(element => {
  const data = new DataTransfer();
  (window as Dragging).dragData = data;
  element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
});
const dragOnto = (target: Locator) => target.evaluate(element => {
  const dataTransfer = (window as Dragging).dragData!;
  for (const type of ['dragenter', 'dragover', 'drop']) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
  document.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
});

test.describe('internet radio stations', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('plays a station live, and never reports it or saves the queue', async ({ app, fake, page }) => {
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    await openStations(app);
    // The home page shows as its host name only; a station without one says what it is.
    await expect(row(app, 'Harbour FM')).toContainText('harbour.example');
    await expect(row(app, 'Night Signal')).toContainText('Live stream');

    await row(app, 'Harbour FM').hover();
    await row(app, 'Harbour FM').getByRole('button', { name: 'Play Harbour FM', exact: true }).click();
    await app.expectPlaying('Harbour FM');

    // Live: no position and nothing to seek, and the deck says what it knows and no more.
    await expect(app.seek).toHaveCount(0);
    await expect(app.deck.getByRole('img', { name: /^Harbour FM, live\./ })).toBeVisible();
    await expect(app.clock).toHaveText('Live');
    await expect(app.deck.locator('.deck-sub')).toHaveText('Internet radio');
    await expect(app.deck.locator('.signal')).toHaveText('A live stream, played by this browser, which can\'t tell what the station says is on.');
    await expect(app.deck.getByRole('button', { name: 'Favorite' })).toHaveCount(0);

    // The stream is relayed by the host; the station's own address never reached the page.
    expect(fake.stationStreams).toContain(stationIds.harbour);
    expect(requests.some(url => url.includes(`/api/station?id=${stationIds.harbour}`))).toBe(true);
    expect(requests.filter(url => url.includes('/radio/'))).toEqual([]);

    // Long enough for a queue save (three seconds after a change) to have gone out, then a pause,
    // which saves too.
    await page.waitForTimeout(4000);
    await app.pause();
    await page.waitForTimeout(3500);
    expect(fake.callsTo('reportPlay')).toEqual([]);
    expect(fake.callsTo('saveQueue')).toEqual([]);
  });

  test('Next and Previous move past a station, seeking does nothing, and its menu has no song actions', async ({ app, fake, page }) => {
    await app.play('Test Pressing', 'Long Run');
    const stations = await openStations(app);
    await app.chooseFromMenu(stations.getByRole('button', { name: /^Night Signal/ }), 'Play next');
    await expect(app.deck.getByText('Next:')).toContainText('Night Signal');
    await app.deck.getByRole('button', { name: 'Next', exact: true }).click();
    await app.expectPlaying('Night Signal');
    await expect(app.clock).toHaveText('Live');

    // The seek keys do nothing to a live stream, and say nothing either.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Shift+ArrowRight');
    await expect(app.clock).toHaveText('Live');
    await expect(app.deck.getByRole('alert')).toHaveCount(0);

    // Radio, playlists, and favorites are for songs.
    const menu = await app.openMenuOn(app.deck.getByRole('heading', { level: 2 }));
    await expect(menu.getByRole('menuitem', { name: 'Start radio' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Add to playlist' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: /favorites/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(app.menu).toBeHidden();

    // More than three seconds into a song, Previous starts it again; a station has no start, so
    // Previous goes back in the queue.
    await page.waitForTimeout(3500);
    await app.deck.getByRole('button', { name: 'Previous', exact: true }).click();
    await app.expectPlaying('Long Run');
    await app.deck.getByRole('button', { name: 'Next', exact: true }).click();
    await app.expectPlaying('Night Signal');
    expect(fake.stationStreams.filter(id => id === stationIds.night).length).toBeGreaterThanOrEqual(2);
    // Long Run was reported; the station never was.
    expect(fake.reports.map(report => report.id)).not.toContain(stationIds.night);
    expect(fake.callsTo('saveQueue').every(call => !(call.args[0] as string[]).includes(stationIds.night))).toBe(true);
  });

  test('a queued station dragged into a playlist is refused, and nothing is sent to the server', async ({ app, fake }) => {
    await app.play('Test Pressing', 'Long Run');
    const stations = await openStations(app);
    await app.chooseFromMenu(stations.getByRole('button', { name: /^Night Signal/ }), 'Add to queue');
    await app.openQueue();
    await expect.poll(() => app.titles()).toContain('Night Signal');
    const before = fake.playlist(playlistIds.road)?.trackIds;
    await dragStart(app.row('Night Signal'));
    await app.openPlaylist('Road Mix');
    await dragOnto(app.tracks().nth(1));
    await expect(app.deck.getByRole('alert')).toContainText('Playlists hold songs, not radio stations.');
    await expect(app.main.getByText('Saving changes')).toHaveCount(0);
    expect(fake.callsTo('addToPlaylist')).toEqual([]);
    expect(fake.callsTo('reorderPlaylist')).toEqual([]);
    expect(fake.playlist(playlistIds.road)?.trackIds).toEqual(before);
  });
});
