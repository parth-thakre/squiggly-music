import { installDesktopBridge } from '../fixtures/desktop';
import { expect, test, trackOf } from '../fixtures/test';

// Over a slow connection a new sleeve took seconds: the deck sat empty, and then the room changed
// colour well after the music had. The next song's sleeve and colours are fetched while this one plays.

const svg = (ground: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${ground}"/><rect x="20" y="20" width="24" height="24" fill="#e33"/></svg>`;

test('the next song\'s sleeve and colours are there when it starts, however slow the server', async ({ page }) => {
  const asked: string[] = [];
  let switched = false;
  await page.route('**/api/cover**', async route => {
    const id = new URL(route.request().url()).searchParams.get('id')!;
    asked.push(`${id}${switched ? ' after' : ''}`);
    // The second record's art takes three seconds.
    if (id === 'al-2') await new Promise(resolve => setTimeout(resolve, 3000));
    await route.fulfill({ contentType: 'image/svg+xml', headers: { 'cache-control': 'private, max-age=86400' }, body: svg(id === 'al-1' ? '#141a2e' : '#f4efe2') });
  });
  await installDesktopBridge(page, { commands: true, server: true });
  await page.goto('/');
  const push = (value: object) => page.evaluate(v => (window as unknown as { pushPlayer(p: object): void }).pushPlayer(v), value);
  const ground = () => page.locator('.room').evaluate(room => (room as HTMLElement).style.getPropertyValue('--ground'));
  await push({ queue: [trackOf('tr-1-1'), trackOf('tr-2-1')], entryIds: ['e.1', 'e.2'], currentIndex: 0, duration: 200, playId: 'p.1', playing: true, position: 10 });
  await expect.poll(ground).toBe('#141a2e');
  // A few seconds into the song, the next one's art arrives.
  await expect.poll(() => asked.filter(id => id === 'al-2').length, { timeout: 10_000 }).toBe(2);
  await page.waitForTimeout(3200);

  switched = true;
  await push({ currentIndex: 1, playId: 'p.2', position: 0 });
  // At once: no empty sleeve, no wait for the colours, nothing asked again.
  await expect.poll(() => page.locator('.deck img.deck-cover').evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0), { timeout: 300 }).toBe(true);
  await expect.poll(ground, { timeout: 300 }).not.toBe('#141a2e');
  expect(asked.filter(id => id.endsWith('after'))).toEqual([]);
});
