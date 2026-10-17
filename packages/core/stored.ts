import type { LibraryApi } from './contracts';

// Library answers kept on the device by the connector's host (the desktop's main process, the
// Android bridge), so a page opened before shows at once, after a restart and away from the
// server too, while it's read again (useResource in the renderer's library.ts). Only answers that
// describe the library are kept, for the account signed in: nothing searched for, nobody else's
// listening, and no random draw, which is never the same twice. Signing out, or another account,
// removes them.
export type StoredMethod = 'albums' | 'album' | 'artists' | 'artist' | 'playlists' | 'genres' | 'starred' | 'topSongs' | 'artistInfo' | 'radioStations' | 'lyrics';
const STORED = new Set<string>(['albums', 'album', 'artists', 'artist', 'playlists', 'genres', 'starred', 'topSongs', 'artistInfo', 'radioStations', 'lyrics'] satisfies StoredMethod[]);
// The same requests as LibraryApi's, answered from the device: the last answer the server gave, or
// a failure when there is none. A host that keeps nothing (the browser build) has none of these.
export type StoredLibrary = Pick<LibraryApi, StoredMethod>;

// The name an answer is kept under: the request as the host received it. Null for one not kept.
export function storedKey(method: string, args: readonly unknown[]): string | null {
  if (!STORED.has(method) || (method === 'albums' && args[0] === 'random')) return null;
  return `${method}\n${JSON.stringify(args)}`;
}
// Answers kept per account, the least recently shown going first, and the largest one kept.
export const STORED_ANSWERS = 2000;
export const STORED_MAX_CHARS = 4 * 1024 * 1024;
export const NOT_STORED = 'Not kept on this device.';
