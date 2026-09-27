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
  nav.back(); expect(nav.current).toEqual({ view: 'records' });
  nav.back(); expect(nav.current).toEqual({ view: 'records' }); // nothing behind the first place
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
