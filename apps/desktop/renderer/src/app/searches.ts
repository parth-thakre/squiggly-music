import { useSyncExternalStore } from 'react';

// Recent searches: the last few queries, newest first, in this browser's storage. Only the text
// typed is kept, nothing about what it found. A search counts once it's used: Enter in the
// field, or opening or playing something it found.
// They belong to the account that made them: stored with its server and username, shown to
// no other, and forgotten when it signs out.
const STORAGE = 'squiggly.searches';
export const RECENT_SEARCHES = 8;
const MAX_LENGTH = 256;

// Who is signed in (server address and username), or null when no one is.
let account: string | null = null;
function read(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as { account?: unknown; queries?: unknown };
    if (!account || stored.account !== account || !Array.isArray(stored.queries)) return [];
    return stored.queries.filter((item): item is string => typeof item === 'string' && item.trim().length > 0 && item.length <= MAX_LENGTH).slice(0, RECENT_SEARCHES);
  } catch { return []; }
}
let recent: string[] | null = null;
const listeners = new Set<() => void>();
function write(next: string[]) {
  recent = next;
  try { if (next.length && account) localStorage.setItem(STORAGE, JSON.stringify({ account, queries: next })); else localStorage.removeItem(STORAGE); } catch { /* storage full or off: this session still has them */ }
  listeners.forEach(listener => listener());
}
// Called whenever the signed-in account may have changed. Signing out forgets its searches;
// another account starts with none of the last one's.
export function searchesFor(next: string | null) {
  if (next === account) return;
  if (!next) write([]);
  account = next; recent = null;
  listeners.forEach(listener => listener());
}
if (typeof addEventListener === 'function') addEventListener('storage', event => {
  if (event.key !== STORAGE && event.key !== null) return;
  recent = read(); listeners.forEach(listener => listener());
});

export const recentSearches = () => recent ??= read();
export function rememberSearch(query: string) {
  const text = query.trim().slice(0, MAX_LENGTH);
  if (!text || !account) return;
  if (recentSearches()[0] === text) return;
  write([text, ...recentSearches().filter(item => item.toLowerCase() !== text.toLowerCase())].slice(0, RECENT_SEARCHES));
}
export const clearSearches = () => write([]);
export const useRecentSearches = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, recentSearches);

// Enter in the search field asks for the first result of that query. The results may still be
// on their way (a slow server can take up to 15 seconds), so the request waits for the search
// page to take it, for as long as focus stays where it was when Enter was pressed. Typing
// again, Escape, leaving the search, or moving focus elsewhere drops it.
let asked: { query: string; from: Element | null } | null = null;
const focusListeners = new Set<() => void>();
export function focusFirstResult(query: string) { asked = { query: query.trim().toLowerCase(), from: document.activeElement }; focusListeners.forEach(listener => listener()); }
export const onFocusFirstResult = (listener: () => void) => { focusListeners.add(listener); return () => { focusListeners.delete(listener); }; };
export function focusWaiting(query: string) {
  if (asked && document.activeElement !== asked.from) asked = null;
  return !!asked && asked.query === query.trim().toLowerCase();
}
export const dropFocusRequest = () => { asked = null; };
