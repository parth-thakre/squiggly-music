import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test, trackOf } from '../fixtures/test';

// A soundtrack song's credit runs long. The song's name and version stay whole, and the credit
// gives way first, though its artists are links outside the row's play button.

test('a long credit gives way before the song\'s name does', async ({ page }) => {
  await installDesktopBridge(page, { commands: true });
  await page.goto('/');
  const credited = (id: string, title: string, names: string[]) => ({ ...trackOf('tr-1-1'), id, title, album: 'Main Vaapas Aaunga', albumId: 'al-1',
    artist: `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`, artists: names.map((name, i) => ({ id: `ar-${id}-${i}`, name })) });
  const queue = [
    credited('x1', 'Vo Nahi Hai', ['A. R. Rahman', 'Adithya RK', 'Armaan Khan', 'Sameer Khan', 'Irshad Kamil']),
    credited('x2', 'Tere Paas Main (Female Version)', ['A. R. Rahman', 'Deepali Sahay', 'Irshad Kamil', 'Sameer Khan', 'Armaan Khan']),
  ];
  await page.evaluate(v => (window as unknown as { pushPlayer(p: object): void }).pushPlayer(v), { queue, entryIds: ['e1', 'e2'], currentIndex: 0, duration: 200, playId: 'p', playing: false, position: 0 });
  await page.getByRole('button', { name: 'Queue', exact: true }).first().click();
  const rows = page.locator('ol.tracks > li');
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    const fits = (selector: string) => row.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth);
    expect(await fits('.name')).toBe(true);
    expect(await row.locator('.extra').count() ? await fits('.extra') : true).toBe(true);
    // The credit is the part cut short, still showing its first artist.
    expect(await fits('.credit')).toBe(false);
    await expect(row.locator('.credit .link').first()).toHaveText('A. R. Rahman');
  }
});
