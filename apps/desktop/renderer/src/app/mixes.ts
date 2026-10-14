import type { Genre, Result, Track } from '../../../../../packages/core/contracts';
import { albumDetails, api, libraryEpoch, load, onLibraryReset, peek, prime } from './library';
import { signedInAccount } from './searches';
import { shuffled } from './ui';

// Automatic playlists, built from the library itself. They work on a fresh server with
// no listening history; history-based ones appear once the server has something to say.
export interface Mix { id: string; name: string; description: string; tracks(): Promise<Result<Track[]>> }

async function fromAlbums(type: 'newest' | 'frequent' | 'recent', count: number, mix: boolean): Promise<Result<Track[]>> {
  const albums = await load(`albums:${type}:0:${count}`, () => api.albums(type, 0, count));
  if (!albums.ok) return albums;
  const details = await albumDetails(albums.value.map(album => album.id));
  const failed = details.find(detail => !detail.ok);
  if (failed && !failed.ok) return failed;
  const tracks = details.flatMap(detail => detail.ok ? detail.value.tracks : []);
  return { ok: true, value: mix ? shuffled(tracks).slice(0, 80) : tracks };
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

// A decade qualifies when the server can find at least a handful of songs from it: nine
// lookups, which take a second or two. So the decades found are kept in this browser's storage
// for the account (server and username), shown at once next time, and looked for again in the
// background; the fresh list takes their place when it differs. A lookup that fails is a failure,
// not a decade without songs: with nothing kept it's shown, and the next visit asks again.
const SAVED_DECADES = 'squiggly.decades';
function savedDecades(): number[] | null {
  try {
    const stored = JSON.parse(localStorage.getItem(SAVED_DECADES) ?? '{}') as { account?: unknown; decades?: unknown };
    const account = signedInAccount();
    if (!account || stored.account !== account || !Array.isArray(stored.decades)) return null;
    return stored.decades.filter((value): value is number => Number.isInteger(value) && value % 10 === 0 && value >= 0 && value <= 9990);
  } catch { return null; }
}
function saveDecades(decades: number[], account: string | null) {
  if (!account || account !== signedInAccount()) return;
  try { localStorage.setItem(SAVED_DECADES, JSON.stringify({ account, decades })); } catch { /* Looked for again next time. */ }
}
// For Home, which shows the decades it knows of without looking for them.
export const knownDecades = (): number[] => {
  const found = peek<number[]>('decades');
  return found?.ok ? found.value : savedDecades() ?? [];
};
export function libraryDecades(): Promise<Result<number[]>> {
  const saved = savedDecades(), account = signedInAccount(), session = libraryEpoch();
  const asked = lookForDecades().then(result => { if (result.ok) saveDecades(result.value, account); return result; });
  if (!saved) return asked;
  void asked.then(result => {
    if (result.ok && session === libraryEpoch() && result.value.join() !== saved.join()) prime('decades', result);
  });
  return Promise.resolve({ ok: true, value: saved });
}
async function lookForDecades(): Promise<Result<number[]>> {
  const candidates = Array.from({ length: 9 }, (_, i) => 1940 + i * 10);
  const results = await Promise.all(candidates.map(decade => api.randomSongs({ size: 8, fromYear: decade, toYear: decade + 9 })));
  const failed = results.find(result => !result.ok);
  if (failed && !failed.ok) return failed;
  return { ok: true, value: candidates.filter((_, i) => { const result = results[i]; return result.ok && result.value.length >= 8; }).reverse() };
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
