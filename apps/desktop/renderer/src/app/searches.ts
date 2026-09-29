import { useSyncExternalStore } from 'react';

// Recent searches: the last few queries, newest first, in this browser's storage. Only the text
// typed is kept, nothing about what it found. A search counts once it's used: Enter in the
// field, or opening or playing something it found.
const STORAGE = 'squiggly.searches';
export const RECENT_SEARCHES = 8;
const MAX_LENGTH = 256;

function read(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((item): item is string => typeof item === 'string' && item.trim().length > 0 && item.length <= MAX_LENGTH).slice(0, RECENT_SEARCHES);
  } catch { return []; }
}
let recent: string[] | null = null;
const listeners = new Set<() => void>();
function write(next: string[]) {
  recent = next;
  try { if (next.length) localStorage.setItem(STORAGE, JSON.stringify(next)); else localStorage.removeItem(STORAGE); } catch { /* storage full or off: this session still has them */ }
  listeners.forEach(listener => listener());
}
if (typeof addEventListener === 'function') addEventListener('storage', event => {
  if (event.key !== STORAGE && event.key !== null) return;
  recent = read(); listeners.forEach(listener => listener());
});

export const recentSearches = () => recent ??= read();
export function rememberSearch(query: string) {
  const text = query.trim().slice(0, MAX_LENGTH);
  if (!text) return;
  if (recentSearches()[0] === text) return;
  write([text, ...recentSearches().filter(item => item.toLowerCase() !== text.toLowerCase())].slice(0, RECENT_SEARCHES));
}
export const clearSearches = () => write([]);
export const useRecentSearches = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, recentSearches);

// Enter in the search field asks for the first result of that query. The results may still be
// on their way, so the request waits (a few seconds at most) for the search page to take it.
// Typing again, or Escape, drops it.
let asked: { query: string; at: number } | null = null;
const focusListeners = new Set<() => void>();
export function focusFirstResult(query: string) { asked = { query: query.trim().toLowerCase(), at: performance.now() }; focusListeners.forEach(listener => listener()); }
export const onFocusFirstResult = (listener: () => void) => { focusListeners.add(listener); return () => { focusListeners.delete(listener); }; };
export const focusWaiting = (query: string) => !!asked && asked.query === query.trim().toLowerCase() && performance.now() - asked.at < 5000;
export const dropFocusRequest = () => { asked = null; };
