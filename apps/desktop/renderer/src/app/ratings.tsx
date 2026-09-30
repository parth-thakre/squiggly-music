import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { Rating, Result, StarTarget } from '../../../../../packages/core/contracts';
import { api, invalidate, onLibraryReset } from './library';
import { player } from './player';
import { Glyph } from './ui';

// Ratings are optimistic, as favorites are, and shared by every place showing the same item.
// A rating shows at once and stays over what the server last said; a refused one rolls back.
// Overrides are kept for the most recent few hundred changes; older ones fall back to what the
// server said, which by then is the new rating. 0 is unrated.
const LIMIT = 400;
const overrides = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; listeners.forEach(listener => listener()); };
const remember = (id: string, value: number) => {
  overrides.delete(id); overrides.set(id, value);
  while (overrides.size > LIMIT) overrides.delete(overrides.keys().next().value!);
};
onLibraryReset(() => { overrides.clear(); emit(); });

export const ratingOf = (id: string, fallback: number | undefined) => overrides.get(id) ?? fallback ?? 0;
export const useRatingsVersion = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version);

// Rates every id, and shows the first failure in the deck, where the app's other errors appear.
export async function setRating(target: StarTarget, ids: string[], rating: Rating): Promise<Result> {
  // One write per item: a playlist can list a song twice, and a failed duplicate would roll back
  // the one that was saved.
  ids = [...new Set(ids)];
  const previous = ids.map(id => overrides.get(id));
  ids.forEach(id => remember(id, rating)); emit();
  const results = await Promise.all(ids.map(id => api.rate(target, id, rating).catch((): Result => ({ ok: false, error: 'Could not reach the library. Check your connection and try again.' }))));
  // Roll back only what this call set; a newer change to the same item wins.
  results.forEach((result, i) => {
    if (result.ok || overrides.get(ids[i]) !== rating) return;
    if (previous[i] === undefined) overrides.delete(ids[i]); else remember(ids[i], previous[i]!);
  });
  emit();
  // The next read of these comes from the server.
  invalidate(target === 'track' ? 'tracks:highest' : 'albums:highest');
  if (target !== 'track') ids.forEach(id => invalidate(`${target}:${id}`));
  const failed = results.find(result => !result.ok);
  if (failed) { player.showError(ids.length > 1 ? `Some ratings were not saved. ${failed.error}` : `The rating was not saved. ${failed.error}`); return failed; }
  return { ok: true, value: undefined };
}

export const ratingText = (rating: number) => rating ? `Rated ${rating} of 5` : 'Not rated';

// A rating as five stars, filled up to the rating: on record and artist pages, in song rows,
// and under the deck. Pointing at a star with a mouse shows what clicking it would set (after a
// tap the preview would stay stuck); clicking the current rating clears it. From the keyboard
// it is a radio group: the arrows move the rating, Backspace or Delete clears it. Those keys
// stop here, so a song list doesn't also take them.
export function RatingStars({ target, id, rating, name, className }: { target: StarTarget; id: string; rating: number | undefined; name: string; className?: string }) {
  useRatingsVersion();
  const value = ratingOf(id, rating);
  const [pointed, setPointed] = useState(0);
  const stars = useRef<(HTMLButtonElement | null)[]>([]);
  const shown = pointed || value;
  const rate = (n: number) => { void setRating(target, [id], n as Rating); };
  const onKeyDown = (event: KeyboardEvent) => {
    const next = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? Math.min(5, value + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? Math.max(1, value - 1)
      : event.key === 'Home' ? 1 : event.key === 'End' ? 5
      : event.key === 'Backspace' || event.key === 'Delete' ? 0 : null;
    if (next === null) return;
    event.preventDefault(); event.stopPropagation();
    if (next !== value) rate(next);
    stars.current[Math.max(1, next) - 1]?.focus();
  };
  return <span className={`rating${value ? '' : ' unrated'}${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={`Rating for ${name}`} onKeyDown={onKeyDown} onPointerLeave={() => setPointed(0)}>
    {([1, 2, 3, 4, 5] as const).map(n => <button key={n} ref={element => { stars.current[n - 1] = element; }} type="button" role="radio"
      aria-checked={n === value} aria-label={n === 1 ? '1 star' : `${n} stars`} title={n === value ? 'Clear rating' : `Rate ${n} of 5`}
      tabIndex={n === Math.max(1, value) ? 0 : -1} className={n <= shown ? 'on' : undefined}
      onPointerEnter={event => { if (event.pointerType === 'mouse') setPointed(n); }} onClick={() => { setPointed(0); rate(n === value ? 0 : n); }}>
      <Glyph kind={n <= shown ? 'starred' : 'star'} />
    </button>)}
  </span>;
}
