import type { Route } from './route';

// Offline mode's page rules, kept pure so they can be tested. The server's state itself comes
// from the host (PlayerState.reach): the desktop's main process, the Android bridge, or the
// browser build's bridge, each running packages/core/reach.ts.

// Places that need the server. Without one, they offer to connect instead; with it away, they
// say so.
export const serverPages = new Set<Route['view']>(['records', 'artists', 'tracks', 'playlists', 'favorites', 'album', 'artist', 'playlist', 'mix', 'search', 'genres', 'genre', 'home', 'mixes']);

// What a place shows. Away, Home is the Kept page where songs can be kept (the notice where they
// can't), other server pages show the notice, and everything else is as always. The app never
// moves to another page by itself when the server goes.
export function pageFor(route: Route, away: boolean, keptSupported: boolean): 'page' | 'kept' | 'notice' {
  if (!away) return 'page';
  if (route.view === 'kept') return 'kept';
  if (route.view === 'home') return keptSupported ? 'kept' : 'notice';
  return serverPages.has(route.view) ? 'notice' : 'page';
}

export { keptOnly } from '../../../../../packages/core/kept';
