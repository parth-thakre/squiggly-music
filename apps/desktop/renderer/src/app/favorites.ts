import { useSyncExternalStore } from 'react';
import type { StarTarget } from '../../../../../packages/core/contracts';
import { api, invalidate, onLibraryReset } from './library';

// Favorites are optimistic and shared by every place showing the same item. Overrides are
// kept for the most recent few hundred changes; older ones fall back to what the server said.
const LIMIT = 400;
const overrides = new Map<string, boolean>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; listeners.forEach(listener => listener()); };
const remember = (id: string, value: boolean) => {
  overrides.delete(id); overrides.set(id, value);
  while (overrides.size > LIMIT) overrides.delete(overrides.keys().next().value!);
};
onLibraryReset(() => { overrides.clear(); emit(); });

export const isStarred = (id: string, fallback: boolean | undefined) => overrides.get(id) ?? fallback ?? false;
export const useFavoritesVersion = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version);

export async function setStarred(target: StarTarget, ids: string[], value: boolean) {
  const previous = ids.map(id => overrides.get(id));
  ids.forEach(id => remember(id, value)); emit();
  const results = await Promise.all(ids.map(id => api.star(target, id, value)));
  // Roll back only what this call set; a newer change to the same item wins.
  results.forEach((result, i) => {
    if (result.ok || overrides.get(ids[i]) !== value) return;
    if (previous[i] === undefined) overrides.delete(ids[i]); else remember(ids[i], previous[i]!);
  });
  emit();
  invalidate('starred');
  if (target !== 'track') ids.forEach(id => invalidate(`${target}:${id}`));
  return results.find(result => !result.ok) ?? { ok: true as const };
}
