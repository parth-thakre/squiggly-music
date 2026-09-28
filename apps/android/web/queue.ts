// The page owns the queue (as in the browser build) and the native player holds a copy, so it
// can go from song to song with the screen off. After every edit the bridge sends the native
// player the few operations that turn its copy into the page's, rather than the whole queue:
// replacing the queue would interrupt the song that's playing.
//
// Entries are named by their entry ids, which are unique within a queue.

export type QueueOp =
  | { type: 'replace'; ids: string[] }
  | { type: 'remove'; from: number; count: number }
  | { type: 'insert'; at: number; ids: string[] }
  | { type: 'move'; from: number; to: number };

/** The operations that turn `before` into `after`. A queue sharing no entries is replaced. */
export function planQueue(before: readonly string[], after: readonly string[]): QueueOp[] {
  if (sameList(before, after)) return [];
  const wanted = new Set(after);
  if (!before.some(id => wanted.has(id))) return [{ type: 'replace', ids: [...after] }];
  const ops: QueueOp[] = [];
  const work = [...before];

  // Removals first, from the end, in runs.
  for (let end = work.length - 1; end >= 0;) {
    if (wanted.has(work[end])) { end--; continue; }
    let start = end;
    while (start > 0 && !wanted.has(work[start - 1])) start--;
    ops.push({ type: 'remove', from: start, count: end - start + 1 });
    work.splice(start, end - start + 1);
    end = start - 1;
  }

  // Then left to right: after position i, `work` matches `after`.
  const target = new Map(after.map((id, i) => [id, i]));
  let present = new Set(work);
  for (let i = 0; i < after.length; i++) {
    if (work[i] === after[i]) continue;
    const want = after[i];
    if (!present.has(want)) {
      let end = i;
      while (end < after.length && !present.has(after[end])) end++;
      const ids = after.slice(i, end);
      ops.push({ type: 'insert', at: i, ids });
      work.splice(i, 0, ...ids);
      present = new Set(work);
      i = end - 1;
      continue;
    }
    const from = work.indexOf(want, i);
    // A song dragged further down leaves every song after it one place early. Moving that one
    // song takes one step; pulling each of the others up would take one step apiece.
    const here = work[i];
    const later = Math.min(target.get(here)!, work.length - 1);
    if (from === i + 1 && later > i) {
      ops.push({ type: 'move', from: i, to: later });
      work.splice(later, 0, ...work.splice(i, 1));
      i--;
      continue;
    }
    ops.push({ type: 'move', from, to: i });
    work.splice(i, 0, ...work.splice(from, 1));
  }
  return ops;
}

/** Applies the operations to a copy of the list, as the native player does to its queue. */
export function applyQueue<T>(list: readonly T[], ops: readonly QueueOp[], item: (id: string) => T): T[] {
  let work = [...list];
  for (const op of ops) {
    if (op.type === 'replace') work = op.ids.map(item);
    else if (op.type === 'remove') work.splice(op.from, op.count);
    else if (op.type === 'insert') work.splice(op.at, 0, ...op.ids.map(item));
    else work.splice(op.to, 0, ...work.splice(op.from, 1));
  }
  return work;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
