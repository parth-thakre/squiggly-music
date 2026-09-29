import type { M3uEntry } from '../../../packages/core/contracts';
import type { PlayableTrack } from '../../../packages/player-mpv/protocol';
import { QUEUE_LIMIT } from '../../../packages/core/validation';
import { readLocalTracks } from './localFiles';

// Files from this computer, however they arrive (the Open files dialog or a drop on the window).
// Each gets a fresh track id when it's read, so where each one is gets remembered here, by that
// id, for playlist files (saveM3u). The renderer never sees these paths. Twice a full queue at
// most; the oldest are forgotten first.
const LIMIT = 2 * QUEUE_LIMIT;
const locations = new Map<string, string>();

// Reads the files' tags (localFiles.ts) and remembers where each one is.
export async function openLocalFiles(paths: readonly string[]): Promise<PlayableTrack[]> {
  const read = await readLocalTracks(paths);
  return paths.map((location, i) => {
    const track = read[i];
    locations.delete(track.id); locations.set(track.id, location);
    while (locations.size > LIMIT) locations.delete(locations.keys().next().value!);
    return { location, track };
  });
}

// Playlist file entries with local files' paths filled in from here. A path the renderer sent for
// a local file is never used; one this process didn't open (or has forgotten) is left null, and
// buildM3u writes artist/album/title.suffix for it.
export const withLocalPaths = (entries: readonly M3uEntry[]): M3uEntry[] =>
  entries.map(entry => entry.local ? { ...entry, path: locations.get(entry.id) ?? null } : entry);
