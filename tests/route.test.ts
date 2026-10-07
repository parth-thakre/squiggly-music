import { expect, it, vi } from 'vitest';

// route.ts drives the browser's history; this file gives it a small in-memory one.

// A minimal browser history: entries, a cursor, popstate on back/forward.
const entries: unknown[] = [null]; let at = 0;
const handlers: ((e: { state: unknown }) => void)[] = [];
const fire = () => handlers.forEach(h => h({ state: entries[at] }));
Object.assign(globalThis, {
  history: {
    get state() { return entries[at]; },
    pushState(s: unknown) { entries.splice(at + 1); entries.push(structuredClone(s)); at++; },
    replaceState(s: unknown) { entries[at] = structuredClone(s); },
    back() { if (at > 0) { at--; fire(); } }, forward() { if (at < entries.length - 1) { at++; fire(); } },
  },
  addEventListener: (type: string, h: (e: { state: unknown }) => void) => { if (type === 'popstate') handlers.push(h); },
  matchMedia: () => ({ matches: true }),
  document: { hidden: true },
});
vi.mock('react-dom', () => ({ flushSync: (f: () => void) => f() }));

it('keeps Back and Forward working past any number of places, with the sheet and the records sort', async () => {
  const { nav } = await import('../apps/desktop/renderer/src/app/route');
  for (let i = 0; i < 120; i++) nav.go({ view: 'album', id: String(i) });
  expect(nav.current).toEqual({ view: 'album', id: '119' });
  for (let i = 118; i >= 0; i--) { nav.back(); expect(nav.current).toEqual({ view: 'album', id: String(i) }); }
  nav.back(); expect(nav.current).toEqual({ view: 'home' });
  nav.back(); expect(nav.current).toEqual({ view: 'home' }); // nothing behind the first place
  for (let i = 0; i < 120; i++) { (history as unknown as { forward(): void }).forward(); expect(nav.current).toEqual({ view: 'album', id: String(i) }); }
  // Sheet: open, Back closes it without moving; following a link replaces the sheet's entry.
  let open = false;
  nav.openOverlay(() => { open = true; }, () => { open = false; });
  expect(open).toBe(true);
  nav.back(); expect(open).toBe(false); expect(nav.current).toEqual({ view: 'album', id: '119' });
  nav.openOverlay(() => { open = true; }, () => { open = false; });
  nav.go({ view: 'queue' }); expect(open).toBe(false); expect(nav.current).toEqual({ view: 'queue' });
  nav.back(); expect(nav.current).toEqual({ view: 'album', id: '119' });
  // Records sort survives Back.
  nav.go({ view: 'records' }); nav.go({ view: 'records', sort: 'random' }, true); nav.go({ view: 'artists' });
  nav.back(); expect(nav.current).toEqual({ view: 'records', sort: 'random' });
});

it('keeps the records decade, the genres and a genre across Back', async () => {
  const { nav } = await import('../apps/desktop/renderer/src/app/route');
  nav.go({ view: 'genres' });
  nav.go({ view: 'genre', name: 'Rock & Roll' });
  nav.go({ view: 'records', sort: 'alphabeticalByName' });
  nav.go({ view: 'records', sort: 'alphabeticalByName', decade: 1990 }, true);
  nav.go({ view: 'album', id: 'a' });
  nav.back(); expect(nav.current).toEqual({ view: 'records', sort: 'alphabeticalByName', decade: 1990 });
  // "All" replaces the filter in place, and the sort it waited behind comes back.
  nav.go({ view: 'records', sort: 'alphabeticalByName' }, true);
  nav.back(); expect(nav.current).toEqual({ view: 'genre', name: 'Rock & Roll' });
  nav.back(); expect(nav.current).toEqual({ view: 'genres' });
  (history as unknown as { forward(): void }).forward(); expect(nav.current).toEqual({ view: 'genre', name: 'Rock & Roll' });
});

it('returns from a mix to Mixes, at the offset it was left', async () => {
  const { nav } = await import('../apps/desktop/renderer/src/app/route');
  const scroller = { scrollTop: 0, scrollTo(_x: number, y: number) { this.scrollTop = y; }, addEventListener() {}, removeEventListener() {} };
  nav.attach(scroller as unknown as HTMLElement);
  nav.go({ view: 'mixes' });
  scroller.scrollTop = 640;
  nav.go({ view: 'mix', id: 'decade:1990' });
  expect(scroller.scrollTop).toBe(0);
  nav.back(); expect(nav.current).toEqual({ view: 'mixes' });
  expect(scroller.scrollTop).toBe(640);
  (history as unknown as { forward(): void }).forward(); expect(nav.current).toEqual({ view: 'mix', id: 'decade:1990' });
  nav.attach(null);
});

it('opens at Home on a fresh start, keeps a reloaded place, and Back returns Home', async () => {
  // A fresh page load: an empty history and a new copy of route.ts.
  entries.splice(0, entries.length, null); at = 0; handlers.length = 0;
  vi.resetModules();
  const { nav } = await import('../apps/desktop/renderer/src/app/route');
  expect(nav.current).toEqual({ view: 'home' });
  nav.back(); expect(nav.current).toEqual({ view: 'home' });
  nav.go({ view: 'records' });
  nav.go({ view: 'album', id: 'a' });
  nav.back(); expect(nav.current).toEqual({ view: 'records' });
  nav.back(); expect(nav.current).toEqual({ view: 'home' });
  nav.back(); expect(nav.current).toEqual({ view: 'home' });
  (history as unknown as { forward(): void }).forward(); expect(nav.current).toEqual({ view: 'records' });
  // Going Home is a place like any other, so Back leaves it.
  nav.go({ view: 'home' });
  nav.back(); expect(nav.current).toEqual({ view: 'records' });
  // A reload picks up the place the history shows, not Home.
  handlers.length = 0;
  vi.resetModules();
  const reloaded = (await import('../apps/desktop/renderer/src/app/route')).nav;
  expect(reloaded.current).toEqual({ view: 'records' });
  reloaded.back(); expect(reloaded.current).toEqual({ view: 'home' });
});

it('moves the history at once, so Back during a move counts from the new place, and two quick Backs land right', async () => {
  // Motion on: moves render inside a view transition whose callback the browser runs later.
  entries.splice(0, entries.length, null); at = 0; handlers.length = 0;
  const pending: (() => Promise<void>)[] = [];
  Object.assign(globalThis, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    document: { hidden: false, querySelector: () => null, startViewTransition(update: () => Promise<void>) {
      pending.push(update);
      return { ready: Promise.resolve(), finished: Promise.resolve() };
    } },
  });
  const flush = async () => { const run = pending.splice(0); for (const update of run) await update(); };
  vi.resetModules();
  const { nav } = await import('../apps/desktop/renderer/src/app/route');
  const start = nav.current;
  // A move is in the history before its transition has drawn it.
  nav.go({ view: 'artists' });
  expect(nav.current).toEqual({ view: 'artists' });
  expect(pending.length).toBe(1);
  // Back before the draw: from Artists, not from the place before it.
  nav.back();
  expect(nav.current).toEqual(start);
  await flush();
  expect(nav.current).toEqual(start);
  expect(entries.length).toBe(2); // the start and Artists: nothing pushed on top of the wrong entry
  // Artists, a record, Artists again: two quick Backs must show the record, then the first Artists.
  nav.go({ view: 'artists' }); await flush();
  nav.go({ view: 'album', id: 'x' }); await flush();
  nav.go({ view: 'artists' }); await flush();
  nav.back(); nav.back();
  expect(nav.current).toEqual({ view: 'artists' });
  await flush();
  expect(nav.current).toEqual({ view: 'artists' });
  expect(at).toBe(1);
  (history as unknown as { forward(): void }).forward();
  expect(nav.current).toEqual({ view: 'album', id: 'x' });
  await flush();
  expect(nav.current).toEqual({ view: 'album', id: 'x' });
});

it('keeps each place\'s scroll offset when Back and Forward come faster than the moves draw', async () => {
  // Motion on, as above: a move draws only when its view transition's callback runs.
  const pending: (() => Promise<void>)[] = [];
  const flush = async () => { const run = pending.splice(0); for (const update of run) await update(); };
  // The page's scroll area: it scrolls wherever it's told, and nothing grows while it loads.
  const scroller = { scrollTop: 0, scrollTo(_x: number, y: number) { this.scrollTop = y; }, addEventListener() {}, removeEventListener() {} };
  const load = async () => {
    entries.splice(0, entries.length, null); at = 0; handlers.length = 0; pending.length = 0;
    Object.assign(globalThis, {
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      document: { hidden: false, querySelector: () => null, startViewTransition(update: () => Promise<void>) {
        pending.push(update);
        return { ready: Promise.resolve(), finished: Promise.resolve() };
      } },
    });
    vi.resetModules();
    const { nav } = await import('../apps/desktop/renderer/src/app/route');
    nav.attach(scroller as unknown as HTMLElement);
    return nav;
  };
  const visit = async (nav: Awaited<ReturnType<typeof load>>, route: Parameters<typeof nav.go>[0], offset: number) => {
    nav.go(route); await flush(); scroller.scrollTop = offset;
  };
  const forward = () => (history as unknown as { forward(): void }).forward();

  // Tracks, Artists, Records; two Backs before either draws, then Forward to Artists.
  let nav = await load();
  await visit(nav, { view: 'tracks' }, 500);
  await visit(nav, { view: 'artists' }, 200);
  await visit(nav, { view: 'records' }, 1000);
  nav.back(); nav.back(); await flush();
  expect(nav.current).toEqual({ view: 'tracks' });
  expect(scroller.scrollTop).toBe(500);
  forward(); await flush();
  expect(nav.current).toEqual({ view: 'artists' });
  expect(scroller.scrollTop).toBe(200); // not Records' 1000, which was on screen during the second Back
  forward(); await flush();
  expect(scroller.scrollTop).toBe(1000);

  // Artists, a record, Artists again; two quick Backs, then Forward to the record.
  nav = await load();
  await visit(nav, { view: 'artists' }, 800);
  await visit(nav, { view: 'album', id: 'x' }, 100);
  await visit(nav, { view: 'artists' }, 400);
  nav.back(); nav.back(); await flush();
  expect(scroller.scrollTop).toBe(800);
  forward(); await flush();
  expect(nav.current).toEqual({ view: 'album', id: 'x' });
  expect(scroller.scrollTop).toBe(100);
  forward(); await flush();
  expect(scroller.scrollTop).toBe(400);

  // Back from a move that hasn't drawn yet keeps the offset of the page that was on screen.
  nav = await load();
  await visit(nav, { view: 'artists' }, 300);
  nav.go({ view: 'album', id: 'y' });
  scroller.scrollTop = 350; // the listener scrolls Artists a little more before the record draws
  nav.back(); await flush();
  expect(nav.current).toEqual({ view: 'artists' });
  expect(scroller.scrollTop).toBe(350);
});

it('keeps the Kept page in history, so Back and Forward return to it', async () => {
  const { nav } = await import('../apps/desktop/renderer/src/app/route');
  nav.go({ view: 'playlists' });
  nav.go({ view: 'kept' });
  nav.go({ view: 'settings' });
  nav.back(); expect(nav.current).toEqual({ view: 'kept' });
  nav.back(); expect(nav.current).toEqual({ view: 'playlists' });
  (history as unknown as { forward(): void }).forward(); expect(nav.current).toEqual({ view: 'kept' });
});
