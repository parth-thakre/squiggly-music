import type { AutoplayView, RepeatMode, Track } from './contracts';

// Autoplay: when an ordinary queue reaches its last song, songs like it from the server go on the
// end, so the music keeps going instead of stopping. It stays off until turned on in Settings,
// since a record that ends usually means to. Radio tops up its own queue, and under repeat the
// queue never runs out, so neither gets autoplay. The desktop's main process runs it beside radio
// (main/radio.ts), so it keeps going with every window hidden; the browser and Android run it in
// the page (player.ts). Both decide with what is here.

// Songs one turn adds, about forty minutes. The next turn starts from the newest of them, so the
// music wanders on from where it got to rather than circling the song that started it.
export const AUTOPLAY_SONGS = 10;
// Songs asked for per seed: more than are added, since some may be queued already.
export const AUTOPLAY_ASK = 30;
// The last song's similar songs may be queued already (a long evening of one artist, say). Then
// the server's songs before it are asked too, newest first, up to this many seeds in all, until
// the turn has its ten.
const SEEDS = 3;
export const noAutoplay: AutoplayView = { added: [], missed: null };

export interface AutoplayQueue { queue: readonly Track[]; entryIds: readonly string[]; index: number; repeat: RepeatMode; radio: boolean }
// What a turn follows: the queue's last entry, once it is the one playing, and the songs to ask
// about. Null when there's nothing to do: radio, repeat, songs still to come, or a last entry
// that isn't a song from the server (a file from this computer, or a station, which never ends).
export function autoplayTurn({ queue, entryIds, index, repeat, radio }: AutoplayQueue): { entry: string; seeds: Track[] } | null {
  const last = queue.at(-1), entry = entryIds.at(-1);
  if (radio || repeat !== 'off' || index < 0 || index !== queue.length - 1 || !last || !entry || last.source !== 'navidrome') return null;
  const seeds: Track[] = [];
  for (let i = queue.length - 1; i >= 0 && seeds.length < SEEDS; i--) {
    const track = queue[i];
    if (track.source === 'navidrome' && !seeds.some(seed => seed.id === track.id)) seeds.push(track);
  }
  return { entry, seeds };
}

// The songs of a server's answer that aren't in `taken` (the queue, and songs this turn already
// picked), in the server's order, at most `count`. Adds the ones it picks to `taken`.
export function freshSongs(similar: readonly Track[], taken: Set<string>, count: number): Track[] {
  const fresh: Track[] = [];
  for (const track of similar) {
    if (fresh.length >= count) break;
    if (track.source !== 'navidrome' || taken.has(track.id)) continue;
    taken.add(track.id); fresh.push(track);
  }
  return fresh;
}

// The view without entries that have left the queue. The same object when nothing left, so a
// snapshot that changed nothing here keeps its reference.
export function keepQueued(view: AutoplayView, entryIds: readonly string[]): AutoplayView {
  if (!view.added.length) return view;
  const queued = new Set(entryIds);
  const added = view.added.filter(entry => queued.has(entry));
  return added.length === view.added.length ? view : { ...view, added };
}

// Where each run of added entries begins in the queue, for the queue's quiet headings.
export function addedRuns(view: AutoplayView, entryIds: readonly string[]): number[] {
  if (!view.added.length) return [];
  const added = new Set(view.added);
  return entryIds.flatMap((entry, index) => added.has(entry) && !added.has(entryIds[index - 1]) ? [index] : []);
}
