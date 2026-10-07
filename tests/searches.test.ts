import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Recent searches belong to one account: another never sees them, and signing out forgets them.
let stored: Map<string, string>;
const load = async () => { vi.resetModules(); return import('../apps/desktop/renderer/src/app/searches'); };
const saved = () => JSON.parse(stored.get('squiggly.searches') ?? 'null') as unknown;

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('recent searches', () => {
  it('are kept with the account that made them and come back for it', async () => {
    const searches = await load();
    searches.searchesFor('https://music.example.com\nann');
    searches.rememberSearch('amber');
    searches.rememberSearch('harbor');
    expect(searches.recentSearches()).toEqual(['harbor', 'amber']);
    expect(saved()).toEqual({ account: 'https://music.example.com\nann', queries: ['harbor', 'amber'] });

    // The next launch, the same account reconnecting.
    const again = await load();
    expect(again.recentSearches()).toEqual([]);
    again.searchesFor('https://music.example.com\nann');
    expect(again.recentSearches()).toEqual(['harbor', 'amber']);
  });

  it('another account, or another server, starts with none', async () => {
    const searches = await load();
    searches.searchesFor('https://music.example.com\nann');
    searches.rememberSearch('amber');
    searches.searchesFor('https://music.example.com\nbob');
    expect(searches.recentSearches()).toEqual([]);
    searches.rememberSearch('glass');
    expect(saved()).toEqual({ account: 'https://music.example.com\nbob', queries: ['glass'] });

    // Left signed in at quit; someone else signs in at the next launch.
    const later = await load();
    later.searchesFor('https://other.example.com\nbob');
    expect(later.recentSearches()).toEqual([]);
  });

  it('signing out forgets them, in memory and in storage', async () => {
    const searches = await load();
    searches.searchesFor('web');
    searches.rememberSearch('amber');
    searches.searchesFor(null);
    expect(searches.recentSearches()).toEqual([]);
    expect(stored.has('squiggly.searches')).toBe(false);
    // Nothing is kept while no one is signed in.
    searches.rememberSearch('glass');
    expect(stored.has('squiggly.searches')).toBe(false);
    searches.searchesFor('web');
    expect(searches.recentSearches()).toEqual([]);
  });

  it('ignores the old list with no account', async () => {
    stored.set('squiggly.searches', JSON.stringify(['amber', 'harbor']));
    const searches = await load();
    searches.searchesFor('web');
    expect(searches.recentSearches()).toEqual([]);
  });
});
