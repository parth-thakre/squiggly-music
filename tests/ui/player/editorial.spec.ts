import { expect, test } from '../fixtures/test';

// The editorial pages: an artist's All songs, the order menu from the keyboard, the queue's record
// dividers, and a record's liner notes.
test.describe('editorial pages', () => {
  test.beforeEach(async ({ app }) => { await app.signIn(); });

  test('an artist\'s All songs lists every song of theirs, in an order of its own, and Back returns to the artist', async ({ app, page }) => {
    await app.section('Artists').click();
    await app.main.getByRole('button', { name: /^Ada Brass/ }).first().click();
    await expect(app.heading).toHaveText('Ada Brass');
    await app.main.getByRole('button', { name: 'All songs', exact: true }).click();
    // Named by the artist, a link back to them, with what the list holds.
    await expect(app.heading).toHaveText('Ada Brass');
    await expect(app.heading.getByRole('button', { name: 'Ada Brass' })).toBeVisible();
    await expect(app.main.locator('.tracks-artist .facts')).toContainText(/^\d+ songs, /);
    await app.expectOrder('A to Z');
    const titles = await app.titles();
    expect(titles.length).toBeGreaterThan(5);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })));
    // Only the orders that make sense for one artist's songs.
    await app.order.click();
    await expect(page.getByRole('menu', { name: 'Order' }).getByRole('menuitemradio')).toHaveText(['A to Z', 'Most played', 'Top rated']);
    await page.keyboard.press('Escape');
    await app.sortBy('Top rated');
    // A sort replaces the place: Back leaves All songs for the artist.
    await page.goBack();
    await expect(app.heading).toHaveText('Ada Brass');
    await expect(app.main.getByRole('region', { name: 'Records', exact: true })).toBeVisible();
  });

  test('an artist\'s Most played ranks their songs by how often they were played, and opens All songs in that order', async ({ app, page }) => {
    // The server's play counts for three of Ada Brass's songs; the rest were never played.
    const plays: Record<string, number> = { 'tr-1-2': 9, 'tr-1-4': 3, 'tr-1-1': 3 };
    await page.route('**/api/album', async route => {
      const response = await route.fetch();
      const result = await response.json() as { ok: boolean; value?: { tracks: { id: string }[] } };
      if (result.ok && result.value) result.value.tracks = result.value.tracks.map(t => plays[t.id] ? { ...t, playCount: plays[t.id] } : t);
      await route.fulfill({ response, json: result });
    });
    await app.section('Artists').click();
    await app.main.getByRole('button', { name: /^Ada Brass/ }).first().click();
    await expect(app.heading).toHaveText('Ada Brass');
    const most = app.main.getByRole('region', { name: 'Most played' });
    // Most first, a tie by name, and only songs played at all.
    await expect.poll(() => app.titles(most)).toEqual(['Lyric Line', 'Long Run', 'Thirty Two']);
    await expect(app.row('Lyric Line', most)).toContainText('9 plays');
    await most.getByRole('button', { name: 'Most played', exact: true }).click();
    await expect(app.heading).toHaveText('Ada Brass');
    await app.expectOrder('Most played');
    expect((await app.titles()).slice(0, 3)).toEqual(['Lyric Line', 'Long Run', 'Thirty Two']);
    // An artist none of whose songs were played has no Most played.
    await page.goBack();
    await app.section('Artists').click();
    await app.main.getByRole('button', { name: /^Bell Tower/ }).first().click();
    await expect(app.heading).toHaveText('Bell Tower');
    await expect(app.main.getByRole('region', { name: 'Records', exact: true })).toBeVisible();
    await expect(app.main.locator('.artist-top')).toHaveCount(0);
  });

  test('Records newest first is one flat shelf, whatever years its records carry', async ({ app, page }) => {
    // Newest is the order records were added: a year can come back after another, on this page
    // or a later one, so it is never parted into years that could regroup as pages arrive.
    let yearOf = (i: number) => i < 4 ? 2019 : i < 6 ? 2003 : 2019;
    await page.route('**/api/albums', async route => {
      const [type] = route.request().postDataJSON() as [string];
      const response = await route.fetch();
      if (type !== 'newest') return route.fulfill({ response });
      const result = await response.json() as { ok: boolean; value: { year: number | null }[] };
      return route.fulfill({ response, json: { ...result, value: result.value.map((album, i) => ({ ...album, year: yearOf(i) })) } });
    });
    await page.reload();
    await expect(app.heading).toHaveText('Records');
    // 2019, 2003, then 2019 again: one flat shelf.
    await expect(app.main.locator('ul.grid > li').first()).toBeVisible();
    await expect(app.main.locator('.crate-year')).toHaveCount(0);
    await expect(app.main.locator('ul.grid')).toHaveCount(1);
    // Each year in one run: still one flat shelf.
    yearOf = i => i < 4 ? 2019 : 2003;
    await page.reload();
    await expect(app.main.locator('ul.grid > li').first()).toBeVisible();
    await expect(app.main.locator('.crate-year')).toHaveCount(0);
    await expect(app.main.locator('ul.grid')).toHaveCount(1);
  });

  test('the order menu opens on the order in use, and the keyboard picks another', async ({ app, page }) => {
    const trigger = app.order;
    await app.expectOrder('newest first');
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Order' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('menuitemradio', { name: 'Newest' })).toBeFocused();
    await expect(menu.getByRole('menuitemradio', { name: 'Newest' })).toHaveAttribute('aria-checked', 'true');
    // Up from the first wraps to the last; Home goes back to the first; Escape closes and returns.
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('menuitemradio', { name: 'Top rated' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(menu.getByRole('menuitemradio', { name: 'Newest' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(app.heading).toHaveText('Records');

    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitemradio', { name: 'A to Z' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await app.expectOrder('A to Z');
    await expect(app.order).toBeFocused();
    await expect(app.main.locator('ul.grid > li').first()).toContainText('Amber Field');
  });

  test('the queue heads each run of a record after the playing one, and a heading opens its record', async ({ app }) => {
    await app.play('Test Pressing', 'Long Run');
    await app.openAlbum('Quiet Harbor');
    await app.chooseFromMenu(app.row('Opening 2'), 'Add to queue');
    await app.chooseFromMenu(app.row('Second Wind 2'), 'Add to queue');
    await app.openAlbum('Amber Field');
    await app.chooseFromMenu(app.row('Opening 3'), 'Add to queue');
    await app.openQueue();
    // The playing song leads, its record's other songs follow unheaded, then a heading for the next
    // record's two songs. A song alone from a record (a shuffle, a playlist) gets no heading.
    await expect(app.main.getByRole('heading', { level: 2, name: 'Long Run' })).toBeVisible();
    await expect(app.main.getByText('7 songs to come')).toBeVisible();
    const records = app.main.locator('ol.tracks > li.group-record');
    await expect(records).toHaveCount(1);
    await expect(records.locator('.queue-record-name')).toHaveText('Quiet Harbor');
    // The server names no record artist here, and the run's two songs aren't by the same act (one
    // is a duet), so the heading names neither performer.
    await expect(records.locator('.queue-record-by')).toHaveText(/^2 songs, /);
    expect(await app.titles()).toEqual(['Long Run', 'Lyric Line', 'Short Stop', 'Thirty Two', 'Tail Light', 'Opening 2', 'Second Wind 2', 'Opening 3']);
    // Quiet Harbor's heading ends where its songs end: a bare rule, with no words, comes before
    // Amber Field's lone song, which gets no heading of its own.
    const items = app.main.locator('ol.tracks > li');
    const order = await items.evaluateAll(lis => lis.map(li => li.classList.contains('rule') ? '—'
      : li.classList.contains('group-record') ? `# ${li.querySelector('.queue-record-name')?.textContent}`
      : li.querySelector('.title .name')?.textContent ?? ''));
    expect(order.slice(-5)).toEqual(['# Quiet Harbor', 'Opening 2', 'Second Wind 2', '—', 'Opening 3']);
    const rule = app.main.locator('ol.tracks > li.group-head.rule');
    await expect(rule).toHaveCount(1);
    await expect(rule).toHaveAttribute('aria-hidden', 'true');
    await expect(rule).toHaveText('');
    await records.getByRole('button').click();
    await expect(app.heading).toHaveText('Quiet Harbor');
  });

  test('a queue heading names the record\'s artist when its songs agree on one, though some don\'t say', async ({ app, page }) => {
    await page.route('**/api/album', async route => {
      const response = await route.fetch();
      const result = await response.json() as { ok: boolean; value?: { tracks: Record<string, unknown>[] } };
      if (result.ok && result.value) result.value.tracks = result.value.tracks.map(t => t.id === 'tr-2-1' ? { ...t, albumArtist: 'Harbor Players' } : t);
      await route.fulfill({ response, json: result });
    });
    await app.play('Test Pressing', 'Long Run');
    await app.openAlbum('Quiet Harbor');
    await app.chooseFromMenu(app.row('Opening 2'), 'Add to queue');
    await app.chooseFromMenu(app.row('Second Wind 2'), 'Add to queue');
    await app.openQueue();
    const records = app.main.locator('ol.tracks > li.group-record');
    await expect(records.locator('.queue-record-name')).toHaveText('Quiet Harbor');
    await expect(records.locator('.queue-record-by')).toHaveText(/^Harbor Players, 2 songs, /);
  });

  test('an artist\'s Most played and All songs count only songs that credit them, not everyone on their records', async ({ app, page }) => {
    // With participations a compilation Ada Brass guests on is one of their records; its other
    // performers' songs are no song of theirs. A song with no artist ids at all is matched by name,
    // and a duet credited to the pair as one act counts on Ada Brass's own record (albumArtist).
    await page.route('**/api/album', async route => {
      const response = await route.fetch();
      const result = await response.json() as { ok: boolean; value?: { tracks: Record<string, unknown>[] } };
      if (result.ok && result.value) result.value.tracks = result.value.tracks.map(t =>
        t.id === 'tr-1-2' ? { ...t, playCount: 9 }
        : t.id === 'tr-1-3' ? { ...t, artist: 'Ada Brass & Hob Nail', artistId: 'ar-duo', artists: [{ id: 'ar-duo', name: 'Ada Brass & Hob Nail' }], albumArtist: 'Ada Brass', playCount: 6 }
        // Someone else's song, played most of all.
        : t.id === 'tr-7-2' ? { ...t, artist: 'Hob Nail', artistId: 'ar-hob', artists: [{ id: 'ar-hob', name: 'Hob Nail' }], playCount: 40 }
        // Gale Guest's duet with Ada Brass: theirs too.
        : t.id === 'tr-7-1' ? { ...t, playCount: 5 }
        // No ids: by name, whatever its case; and a stranger's, by name too.
        : t.id === 'tr-13-1' ? { ...t, artist: 'ADA BRASS', artistId: null, artists: undefined, playCount: 4 }
        : t.id === 'tr-13-2' ? { ...t, artist: 'Someone Else', artistId: null, artists: undefined, playCount: 30 }
        : t);
      await route.fulfill({ response, json: result });
    });
    await app.section('Artists').click();
    await app.main.getByRole('button', { name: /^Ada Brass/ }).first().click();
    await expect(app.heading).toHaveText('Ada Brass');
    const most = app.main.getByRole('region', { name: 'Most played' });
    await expect.poll(() => app.titles(most)).toEqual(['Lyric Line', 'Short Stop', 'Opening 7', 'Opening 13']);
    await expect(most).not.toContainText('Second Wind 7');
    await expect(most).not.toContainText('Second Wind 13');
    // All songs, most played first, ranks the same songs, and lists no stranger's in any order.
    await most.getByRole('button', { name: 'Most played' }).click();
    const songs = app.main.getByRole('region', { name: 'Songs' });
    await expect.poll(async () => (await app.titles(songs)).slice(0, 4)).toEqual(['Lyric Line', 'Short Stop', 'Opening 7', 'Opening 13']);
    await expect(songs).not.toContainText('Second Wind 7');
    await expect(songs).not.toContainText('Second Wind 13');
    await app.sortBy('A to Z');
    await expect(songs).toContainText('Short Stop');
    await expect(songs).not.toContainText('Second Wind 7');
    await expect(songs).not.toContainText('Second Wind 13');
  });

  test('liner notes count every song in its file group, and number a two-disc record\'s songs by disc', async ({ app, page }) => {
    await page.route('**/api/album', async route => {
      const response = await route.fetch();
      const result = await response.json() as { ok: boolean; value?: { tracks: Record<string, unknown>[] } };
      const bare = { sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null };
      // Low Tide Radio: three songs on disc 1, two on disc 2. Gale Guest sings on the third of each.
      // Two songs say nothing of their format, and only one of those its size.
      if (result.ok && result.value) result.value.tracks = result.value.tracks.map(t =>
        t.id === 'tr-8-1' ? { ...t, ...bare, size: 4_000_000 }
        : t.id === 'tr-8-2' ? { ...t, ...bare }
        // Disc 2's second song has no number: it is 2-2 by its place on its disc, not 2-5.
        : t.id === 'tr-8-5' ? { ...t, trackNumber: null, artist: `${t.artist} & Gale Guest`, artists: [{ id: t.artistId, name: t.artist }, { id: 'ar-guest', name: 'Gale Guest' }], size: 1_000_000 }
        : t.id === 'tr-8-3' ? { ...t, artist: `${t.artist} & Gale Guest`, artists: [{ id: t.artistId, name: t.artist }, { id: 'ar-guest', name: 'Gale Guest' }], size: 1_000_000 }
        : { ...t, size: 1_000_000 });
      await route.fulfill({ response, json: result });
    });
    await app.openAlbum('Low Tide Radio');
    const credits = app.main.getByRole('region', { name: 'Credits' });
    await expect(credits.locator('.credits-cast')).toHaveText('Bell Tower (every song), Gale Guest (1-3, 2-2)');
    // A size only for a group whose every file says its own: not the one song's 4 MB as the whole.
    const rows = credits.locator('.credits-file-row');
    await expect(rows).toHaveText(['Audio, 2 songs', 'WAV, 16-bit, 8 kHz, 3 songs, 3.0 MB']);
  });

  test('a record\'s liner notes say who is on which song and what the server says the files are', async ({ app }) => {
    await app.openAlbum('Quiet Harbor');
    const credits = app.main.getByRole('region', { name: 'Credits' });
    await expect(credits.locator('.credits-cast')).toHaveText('Bell Tower (every song), Cinder Lane (2)');
    // Only what the server reports about the files, and no claim about what reaches the ears.
    await expect(credits.locator('.credits-files')).toContainText(/kHz/);
    await expect(app.main).not.toContainText(/bit-perfect|lossless|hi-?res/i);
    await expect(app.main.getByRole('region', { name: 'More records' })).toContainText('More by Bell Tower');
    await credits.getByRole('button', { name: 'Cinder Lane' }).click();
    await expect(app.heading).toHaveText('Cinder Lane');
  });
});
