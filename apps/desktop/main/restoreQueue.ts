// A queue put back in a new audio engine (main's relaunch), with the songs added while it started:
// they went into its empty queue, which this one replaces. They keep their order: Play next after
// the song playing (`at`), as the engine places it, and the rest at the end. The queue's limit
// takes them in the order they were added, so the queue itself is never cut, and `left` counts
// those that didn't fit.
export function withAdds<T>(tracks: readonly T[], at: number, added: readonly { tracks: readonly T[]; where: 'next' | 'end' | number }[], limit: number) {
  const queue = [...tracks];
  let room = Math.max(0, limit - queue.length), left = 0;
  for (const add of added) {
    const fits = add.tracks.slice(0, room);
    left += add.tracks.length - fits.length; room -= fits.length;
    if (add.where === 'next') queue.splice(at + 1, 0, ...fits); else queue.push(...fits);
  }
  return { queue, left };
}
