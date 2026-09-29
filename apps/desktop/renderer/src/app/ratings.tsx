import { useSyncExternalStore } from 'react';
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

// A rating as small marks: filled up to the rating, hollow after it. Nothing when unrated.
export function RatingMarks({ id, rating }: { id: string; rating: number | undefined }) {
  useRatingsVersion();
  const value = ratingOf(id, rating);
  if (!value) return null;
  return <span className="rating-marks" role="img" aria-label={ratingText(value)} title={ratingText(value)}>
    {[1, 2, 3, 4, 5].map(n => <span key={n} className={n <= value ? 'on' : undefined}><Glyph kind={n <= value ? 'starred' : 'star'} /></span>)}
  </span>;
}
