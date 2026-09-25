import type { PlayableTrack, QueueEdit } from './protocol';

// Same bound as QUEUE_LIMIT in core/validation.ts, kept here so the host bundle avoids Effect schemas.
export const QUEUE_LIMIT = 1000;
interface PlaylistEngine { command(...args: string[]): void; number(name: string): number | null }
const gone = () => new Error('That song is no longer in the queue. Try again.');
// The host stores its own entry type (with a queue-entry id); edits keep each item whole.
export type Edit<T extends PlayableTrack> = Exclude<QueueEdit, { type: 'queue-add' }> | { type: 'queue-add'; tracks: T[]; where: 'next' | 'end' };

// Applies one edit to mpv's playlist and the host's parallel copy, entry by entry, so a
// native failure part-way leaves both describing the same list. `live` is false after a
// legacy argument-less stop: mpv's playlist is then empty and only the private copy remains.
export function editQueue<T extends PlayableTrack>(native: PlaylistEngine, queue: T[], live: boolean, edit: Edit<T>) {
  const current = live ? native.number('playlist-pos') ?? -1 : -1;
  switch (edit.type) {
    case 'queue-add': {
      if (!edit.tracks.length) throw new Error('Choose at least one track.');
      if (queue.length + edit.tracks.length > QUEUE_LIMIT) throw new Error(`The queue holds up to ${QUEUE_LIMIT.toLocaleString('en-US')} songs.`);
      // With nothing current (stopped, or finished), "next" means the front of the queue.
      const at = edit.where === 'end' ? queue.length : current + 1;
      for (const [offset, item] of edit.tracks.entries()) {
        const target = at + offset;
        if (live) {
          native.command('loadfile', item.location, 'append');
          // Moving a later entry onto an earlier index leaves it exactly at that index.
          try { if (target < queue.length) native.command('playlist-move', String(queue.length), String(target)); }
          catch (error) { queue.push(item); throw error; }
        }
        queue.splice(target, 0, item);
      }
      break;
    }
    case 'queue-move': {
      const { from, to } = edit;
      if (from >= queue.length || to >= queue.length) throw gone();
      if (from === to) break;
      // mpv's second index names the entry to insert before, not the final index. Moving
      // down therefore targets the entry after `to`; `to + 1` may equal the count (the end).
      if (live) native.command('playlist-move', String(from), String(to > from ? to + 1 : to));
      queue.splice(to, 0, ...queue.splice(from, 1));
      break;
    }
    case 'queue-remove': {
      const indexes = [...new Set(edit.indexes)].sort((a, b) => b - a);
      if (indexes.some(index => index >= queue.length)) throw gone();
      // Removing the loaded entry would stop or skip playback as a side effect.
      if (current >= 0 && indexes.includes(current)) throw new Error('The current song cannot be removed. Skip to another song first.');
      // Highest first, so each remaining index still names the same entry.
      for (const index of indexes) { if (live) native.command('playlist-remove', String(index)); queue.splice(index, 1); }
      break;
    }
    case 'queue-clear':
      for (let index = queue.length - 1; index >= 0; index--) {
        if (index === current) continue;
        if (live) native.command('playlist-remove', String(index));
        queue.splice(index, 1);
      }
  }
  if (live && native.number('playlist-count') !== queue.length) {
    throw new Error('The audio engine queue changed unexpectedly. Replace the queue to continue.');
  }
}
