import { describe, expect, it } from 'vitest';
import type { Playlist, PlaylistDetail, Result, Track } from '../packages/core/contracts';
import { PlaylistEditor, resetLibraryCaches } from '../apps/desktop/renderer/src/app/library';

const track = (id: string): Track => ({ id, title: id, artist: 'Artist', album: 'Record', duration: 60, source: 'navidrome', sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null });
const info = (name: string): Playlist => ({ id: 'p', name, comment: null, owner: null, songCount: 0, duration: 0, coverArt: null, readonly: false, changed: null });

// A positional server like Navidrome's: removals are by index, reorders rewrite the list.
// Each request waits until the test releases it, so requests can be finished out of order.
function server(ids: string[]) {
  let songs = ids.map(track);
  let name = 'Mix';
  const log: string[] = [];
  const gates: { label: string; release(): void }[] = [];
  const refuse = new Set<string>();
  const gate = <T,>(label: string, apply: () => T): Promise<T> => new Promise(resolve => {
    gates.push({ label, release: () => resolve(apply()) });
  });
  const ok: Result = { ok: true, value: undefined };
  const api = {
    playlist: (): Promise<Result<PlaylistDetail>> => Promise.resolve({ ok: true, value: { playlist: info(name), tracks: [...songs] } }),
    addToPlaylist: (_: string, add: string[]) => gate(`add ${add}`, () => { if (refuse.has('add')) return fail; songs = [...songs, ...add.map(track)]; log.push(`add ${add}`); return ok; }),
    removeFromPlaylist: (_: string, indexes: number[]) => gate(`remove ${indexes}`, () => {
      if (refuse.has(`remove ${indexes}`)) return fail;
      songs = songs.filter((_, i) => !indexes.includes(i)); log.push(`remove ${indexes}`); return ok;
    }),
    reorderPlaylist: (_: string, order: string[]) => gate(`reorder ${order}`, () => { songs = order.map(track); log.push(`reorder ${order}`); return ok; }),
    updatePlaylist: (_: string, changes: { name?: string }) => gate(`rename ${changes.name}`, () => { if (refuse.has('rename')) return fail; name = changes.name ?? name; return ok; }),
    deletePlaylist: () => gate('delete', () => ok),
  };
  const fail: Result = { ok: false, error: 'Refused' };
  return {
    api, log, refuse, songs: () => songs.map(s => s.id), name: () => name,
    // Release the oldest waiting request and let everything it triggers settle.
    async step() { await flush(); const next = gates.shift(); if (!next) throw new Error('nothing waiting'); next.release(); await flush(); },
    waiting: () => gates.map(g => g.label),
  };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const shown = (editor: PlaylistEditor) => editor.snapshot.tracks.map(t => t.id);

async function opened(ids: string[]) {
  resetLibraryCaches();
  const fake = server(ids);
  const editor = new PlaylistEditor('p', fake.api);
  editor.sync();
  await flush(); await flush();
  expect(shown(editor)).toEqual(ids);
  return { fake, editor };
}

describe('playlist editing', () => {
  it('sends one request at a time, so quick removals remove the songs that were chosen', async () => {
    const { fake, editor } = await opened(['A', 'B', 'C', 'D']);
    const first = editor.removeAt([0]);
    // Chosen against the list as shown: C is now at index 1.
    const second = editor.removeAt([1], [track('C')]);
    expect(shown(editor)).toEqual(['B', 'D']);
    expect(fake.waiting()).toEqual(['remove 0']);
    await fake.step();
    expect(fake.waiting()).toEqual(['remove 1']);
    await fake.step();
    expect(await first).toEqual({ ok: true, value: undefined });
    expect(await second).toEqual({ ok: true, value: undefined });
    expect(fake.songs()).toEqual(['B', 'D']);
    expect(shown(editor)).toEqual(['B', 'D']);
  });

  it('drops a refused edit without undoing the ones that succeeded after it', async () => {
    const { fake, editor } = await opened(['A', 'B', 'C']);
    fake.refuse.add('remove 0');
    const refused = editor.removeAt([0]);
    const kept = editor.removeAt([1], [track('C')]);
    expect(shown(editor)).toEqual(['B']);
    await fake.step();
    expect(await refused).toEqual({ ok: false, error: 'Refused' });
    // A is back, and C's removal is now translated against the server's real list.
    expect(shown(editor)).toEqual(['A', 'B']);
    expect(fake.waiting()).toEqual(['remove 2']);
    await fake.step();
    expect((await kept).ok).toBe(true);
    expect(fake.songs()).toEqual(['A', 'B']);
    expect(shown(editor)).toEqual(['A', 'B']);
    // The refusal stays on screen; the later success doesn't hide it.
    expect(editor.snapshot.error).toBe('Refused');
  });

  it('never writes removed songs back when reordering', async () => {
    const { fake, editor } = await opened(['A', 'B', 'C', 'D']);
    void editor.removeAt([1]);
    // Move D to the top of the list as shown (A, C, D).
    const moved = editor.move(2, 0);
    expect(shown(editor)).toEqual(['D', 'A', 'C']);
    await fake.step();
    expect(fake.waiting()).toEqual(['reorder D,A,C']);
    await fake.step();
    expect((await moved).ok).toBe(true);
    expect(fake.songs()).toEqual(['D', 'A', 'C']);
  });

  it('keeps duplicate songs apart', async () => {
    const { fake, editor } = await opened(['A', 'B', 'A']);
    void editor.removeAt([0]);
    void editor.removeAt([1], [track('A')]);
    await fake.step(); await fake.step();
    expect(fake.log).toEqual(['remove 0', 'remove 1']);
    expect(shown(editor)).toEqual(['B']);
  });

  it('queues renames and additions with the rest, and stops after a delete', async () => {
    const { fake, editor } = await opened(['A']);
    fake.refuse.add('rename');
    const renamed = editor.rename('New');
    const added = editor.add([track('B')]);
    expect(editor.snapshot.playlist?.name).toBe('New');
    expect(shown(editor)).toEqual(['A', 'B']);
    await fake.step();
    expect((await renamed).ok).toBe(false);
    expect(editor.snapshot.playlist?.name).toBe('Mix');
    expect(editor.snapshot.error).toBe('Refused');
    await fake.step();
    expect((await added).ok).toBe(true);
    expect(fake.songs()).toEqual(['A', 'B']);
    const deleted = editor.delete();
    const late = editor.add([track('C')]);
    await fake.step();
    expect((await deleted).ok).toBe(true);
    expect((await late).ok).toBe(false);
    expect(editor.snapshot.deleted).toBe(true);
  });

  it('refuses index edits against a list that changed under the click', async () => {
    const { editor } = await opened(['A', 'B']);
    expect(await editor.removeAt([0], [track('B')])).toMatchObject({ ok: false });
  });
});
