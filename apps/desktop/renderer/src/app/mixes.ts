import type { Genre, Result, Track } from '../../../../../packages/core/contracts';
import { api, load, onLibraryReset } from './library';

// Automatic playlists, built from the library itself. They work on a fresh server with
// no listening history; history-based ones appear once the server has something to say.
export interface Mix { id: string; name: string; description: string; tracks(): Promise<Result<Track[]>> }

const shuffle = <T,>(items: T[]) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
};
async function fromAlbums(type: 'newest' | 'frequent' | 'recent', count: number, mix: boolean): Promise<Result<Track[]>> {
  const albums = await load(`albums:${type}:0:${count}`, () => api.albums(type, 0, count));
  if (!albums.ok) return albums;
  const details = await Promise.all(albums.value.map(album => load(`album:${album.id}`, () => api.album(album.id))));
  const failed = details.find(detail => !detail.ok);
  if (failed && !failed.ok) return failed;
  const tracks = details.flatMap(detail => detail.ok ? detail.value.tracks : []);
  return { ok: true, value: mix ? shuffle(tracks).slice(0, 80) : tracks };
}

export function buildMixes(genres: Genre[], decades: number[], history: boolean): Mix[] {
  const mixes: Mix[] = [
    { id: 'everything', name: 'Everything, shuffled', description: 'Sixty songs from anywhere in your library.',
      tracks: () => api.randomSongs({ size: 60 }) },
    { id: 'recent', name: 'Recently added', description: 'Every song from the twelve newest records, newest first.',
      tracks: () => fromAlbums('newest', 12, false) },
  ];
  if (history) mixes.push(
    { id: 'repeat', name: 'On repeat', description: 'Songs from the records you play most, shuffled.', tracks: () => fromAlbums('frequent', 10, true) },
    { id: 'lately', name: 'Lately', description: 'Songs from the records you played most recently, shuffled.', tracks: () => fromAlbums('recent', 10, true) },
  );
  for (const genre of genres.filter(g => g.songCount >= 12).sort((a, b) => b.songCount - a.songCount).slice(0, 6)) {
    mixes.push({ id: `genre:${genre.name}`, name: genre.name, description: `Fifty songs tagged ${genre.name}, shuffled.`,
      tracks: () => api.randomSongs({ size: 50, genre: genre.name }) });
  }
  for (const decade of decades) {
    mixes.push({ id: `decade:${decade}`, name: `The ${decade}s`, description: `Fifty songs released from ${decade} to ${decade + 9}.`,
      tracks: () => api.randomSongs({ size: 50, fromYear: decade, toYear: decade + 9 }) });
  }
  return mixes;
}

// A decade qualifies when the server can find at least a handful of songs from it.
export async function libraryDecades(): Promise<number[]> {
  const candidates = Array.from({ length: 9 }, (_, i) => 1940 + i * 10);
  const found = await Promise.all(candidates.map(async decade => {
    const result = await api.randomSongs({ size: 8, fromYear: decade, toYear: decade + 9 });
    return result.ok && result.value.length >= 8 ? decade : null;
  }));
  return found.filter((d): d is number => d !== null).reverse();
}

// Mixes stay put for the session until the listener asks for a new draw. Only the most
// recently opened few are kept; a failed draw is forgotten so the next visit tries again.
const DRAWN = 24;
const drawn = new Map<string, Promise<Result<Track[]>>>();
onLibraryReset(() => drawn.clear());
export function mixTracks(mix: Mix, fresh = false) {
  let draw = fresh ? undefined : drawn.get(mix.id);
  if (!draw) {
    const next = mix.tracks().catch((): Result<Track[]> => ({ ok: false, error: 'Could not reach the library. Check your connection and try again.' }));
    draw = next;
    void next.then(result => { if (!result.ok && drawn.get(mix.id) === next) drawn.delete(mix.id); });
  }
  drawn.delete(mix.id); drawn.set(mix.id, draw);
  while (drawn.size > DRAWN) drawn.delete(drawn.keys().next().value!);
  return draw;
}

// Mix ids describe their own rules, so a mix page can be opened directly.
export function mixById(id: string): Mix | undefined {
  if (id.startsWith('genre:')) return buildMixes([{ name: id.slice(6), songCount: 99, albumCount: 0 }], [], false).find(m => m.id === id);
  if (id.startsWith('decade:')) return buildMixes([], [Number(id.slice(7))], false).find(m => m.id === id);
  return buildMixes([], [], true).find(m => m.id === id);
}
