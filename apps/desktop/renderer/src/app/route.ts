import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { reducedMotion } from './theme';
import type { AlbumListType, TrackSort } from '../../../../../packages/core/contracts';

export type Route =
  // The sort is part of the place, so Back returns to the same order (and the same scroll offset).
  | { view: 'records'; sort?: AlbumListType; decade?: number } | { view: 'artists' } | { view: 'tracks'; sort?: TrackSort } | { view: 'playlists' } | { view: 'favorites' }
  | { view: 'album'; id: string } | { view: 'artist'; id: string }
  | { view: 'playlist'; id: string } | { view: 'mix'; id: string }
  // Search's tab (All when left out) is part of the place too, replaced in place like a sort.
  | { view: 'search'; query: string; type?: 'artists' | 'albums' | 'songs' } | { view: 'queue' } | { view: 'lyrics' } | { view: 'settings' } | { view: 'diagnostics' }
  // A page an extension added; id is the page's namespaced id.
  | { view: 'extension'; id: string }
  // Every genre, and one genre's songs.
  | { view: 'genres' } | { view: 'genre'; name: string }
  // Where the app opens: what's lately played, new, and playing elsewhere.
  | { view: 'home' };

// Navigation rides on the browser's own history, so a phone's back gesture (and Forward)
// steps through the app instead of leaving it. Each history entry carries its route, a
// unique id, and its depth (how many app entries lie behind it), so Back and Forward work
// however long the session runs; the app itself only remembers the current place and the
// scroll offsets of the most recent places.
interface Place { id: string; depth: number; route: Route; overlay?: boolean }
const views = new Set(['records', 'artists', 'tracks', 'playlists', 'favorites', 'album', 'artist', 'playlist', 'mix', 'search', 'queue', 'lyrics', 'settings', 'diagnostics', 'extension', 'genres', 'genre', 'home']);
function placeOf(state: unknown): Place | null {
  const s = state as { squiggly?: unknown; depth?: unknown; route?: { view?: unknown }; overlay?: unknown } | null;
  if (!s || typeof s.squiggly !== 'string' || typeof s.depth !== 'number' || !views.has(String(s.route?.view))) return null;
  return { id: s.squiggly, depth: s.depth, route: s.route as Route, overlay: s.overlay === true };
}
const stateOf = (place: Place) => ({ squiggly: place.id, depth: place.depth, route: place.route, overlay: place.overlay || undefined });
// Ids only need to be unique within this page load; the prefix keeps them apart from entries
// written before a reload.
const run = Math.random().toString(36).slice(2, 8);
let counter = 0;
const nextId = () => `${run}.${++counter}`;
const same = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

const SCROLLS = 50;
const scrolls = new Map<string, number>();
const remember = (id: string, offset: number) => {
  scrolls.delete(id); scrolls.set(id, offset);
  while (scrolls.size > SCROLLS) scrolls.delete(scrolls.keys().next().value!);
};

// A reload keeps the browser's history, so pick up the place it was showing. A fresh start opens Home.
let now: Place = placeOf(history.state) ?? { id: nextId(), depth: 0, route: { view: 'home' } };
now = { ...now, overlay: false };
history.replaceState(stateOf(now), '');

// `now` is where the history is, changed the moment a move is decided, so a Back that lands
// while the last move is still animating counts from the right place. `shown` is what the
// page draws; it catches up when the move's transition renders.
let shown: Place = now;
const listeners = new Set<() => void>();
let scroller: HTMLElement | null = null;
// A full-screen layer (the phone's now-playing sheet) that the back gesture closes first.
let overlay: (() => void) | null = null;
const emit = () => { shown = now; listeners.forEach(listener => listener()); };
// The scroller holds the offset of the page on screen, which during a move is `shown`, not
// `now`; saving it under `now` would give a place the offset of the page still in view.
const keepScroll = () => { if (!shown.overlay) remember(shown.id, scroller?.scrollTop ?? 0); };

// Moving between places animates with the browser's View Transitions: the sleeve you touched
// travels to where it lands, everything else crossfades. Skipped for reduced motion.
const reduced = reducedMotion;
// The record, playlist, or mix whose sleeve should travel on the next move.
export const morph = { id: null as string | null };
export function transition(update: () => void) {
  if (!document.startViewTransition || reduced.matches || document.hidden) { update(); return; }
  const view = document.startViewTransition(async () => {
    flushSync(update);
    // Give a page whose data is still arriving a moment (at most 250 ms), so the sleeve has
    // somewhere to land. Rendering is paused inside this callback, so wait on timers, not frames.
    for (let wait = 0; wait < 10 && document.querySelector('.page .status.loading'); wait++) await new Promise(done => setTimeout(done, 25));
  });
  // A transition interrupted by the next one is expected, not an error.
  view.ready.catch(() => undefined); view.finished.catch(() => undefined);
}

// Returning to a place scrolls to where it was left. A page still filling in (a long list
// measuring itself, a record still loading) may be too short at first, so keep trying for a
// moment as it grows, and give up as soon as the listener scrolls or navigates.
let stopRestoring: (() => void) | null = null;
function restoreScroll(offset: number) {
  stopRestoring?.();
  const element = scroller;
  if (!element) return;
  element.scrollTo(0, offset);
  if (offset <= 0 || Math.abs(element.scrollTop - offset) < 2) return;
  const until = performance.now() + 1500;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame); stopRestoring = null;
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) element.removeEventListener(type, stop);
  };
  const step = () => {
    element.scrollTo(0, offset);
    if (Math.abs(element.scrollTop - offset) < 2 || performance.now() > until) stop(); else frame = requestAnimationFrame(step);
  };
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) element.addEventListener(type, stop, { passive: true });
  stopRestoring = stop;
  frame = requestAnimationFrame(step);
}

addEventListener('popstate', event => {
  const close = overlay;
  overlay = null;
  const place = placeOf(event.state);
  // Not one of ours (history from before the app loaded): just close the sheet if it was open.
  if (!place) { if (close) transition(close); return; }
  stopRestoring?.();
  keepScroll();
  // Closing the sheet, or stepping onto a sheet's old entry: the page itself stays put.
  if (same(place.route, now.route)) { now = { ...place, route: now.route }; emit(); if (close) transition(close); return; }
  now = place;
  transition(() => {
    close?.();
    // A later move has already taken over; its own transition draws it.
    if (now.id !== place.id) return;
    emit();
    restoreScroll(scrolls.get(place.id) ?? 0);
  });
});

export const nav = {
  attach(element: HTMLElement | null) { scroller = element; },
  go(route: Route, replace = false) {
    // Following a link out of the sheet replaces the sheet's history entry.
    const close = overlay;
    overlay = null;
    if (same(now.route, route)) {
      if (close) { transition(close); history.back(); }
      return;
    }
    stopRestoring?.();
    keepScroll();
    // The history moves at once, before any animation, so a Back pressed during the move goes
    // back from here and not from the place before it.
    const replacing = replace || close !== null;
    const place: Place = { id: nextId(), depth: replacing ? now.depth : now.depth + 1, route };
    now = place;
    if (replacing) history.replaceState(stateOf(place), ''); else history.pushState(stateOf(place), '');
    const draw = () => {
      close?.();
      if (now.id !== place.id) return;
      emit();
      scroller?.scrollTo(0, 0);
    };
    // Typing in search and changing a sort replace in place; they shouldn't animate on every change.
    if (replace) draw(); else transition(draw);
  },
  back() { if (overlay || now.depth > 0) history.back(); },
  get overlayOpen() { return overlay !== null; },
  openOverlay(open: () => void, close: () => void) {
    overlay = close;
    keepScroll();
    now = { id: nextId(), depth: now.depth + 1, route: now.route, overlay: true };
    history.pushState(stateOf(now), '');
    emit();
    transition(open);
  },
  closeOverlay() { if (overlay) history.back(); },
  get scroller() { return scroller; },
  get current(): Route { return now.route; },
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useRoute() {
  return useSyncExternalStore(subscribe, () => shown.route);
}
// A sheet's entry sits one above the page it covers; Back from the page itself is what counts.
export const useCanGoBack = () => useSyncExternalStore(subscribe, () => (shown.overlay ? shown.depth - 1 : shown.depth) > 0);
