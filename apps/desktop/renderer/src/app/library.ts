import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { LibraryApi, Playlist, Result, Track } from '../../../../../packages/core/contracts';
import { previewLibrary } from '../bridge/previewLibrary';

export const api: LibraryApi = (typeof window !== 'undefined' && window.squiggly?.library) || previewLibrary;

// A small bounded cache of library responses: going back is instant, memory stays flat.
const LIMIT = 120;
const cache = new Map<string, Promise<Result<unknown>>>();
// Answers that have already arrived, readable synchronously so revisits render at once.
const settled = new Map<string, Result<unknown>>();
// Called with the key that changed, or '*' when everything did (a new session).
const listeners = new Set<(key: string) => void>();

export function load<T>(key: string, loader: () => Promise<Result<T>>): Promise<Result<T>> {
  let entry = cache.get(key);
  if (entry) { cache.delete(key); cache.set(key, entry); return entry as Promise<Result<T>>; }
  entry = loader().catch((): Result<T> => ({ ok: false, error: 'Could not reach the library. Check your connection and try again.' }));
  cache.set(key, entry);
  void entry.then(result => {
    if (cache.get(key) !== entry) return;
    if (result.ok) settled.set(key, result); else cache.delete(key);
  });
  while (cache.size > LIMIT) { const oldest = cache.keys().next().value!; cache.delete(oldest); settled.delete(oldest); }
  return entry as Promise<Result<T>>;
}
export function invalidate(prefix: string) {
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) { cache.delete(key); settled.delete(key); listeners.forEach(listener => listener(key)); }
}
// Read an answer that has already arrived, without asking for it.
export const peek = <T,>(key: string) => settled.get(key) as Result<T> | undefined;

// Everything the renderer remembers about one account. A different server or user must not
// see the last one's records, stars, mixes, or pending edits where ids happen to overlap.
const resets = new Set<() => void>();
export const onLibraryReset = (reset: () => void) => { resets.add(reset); return () => { resets.delete(reset); }; };
let epoch = 0;
const epochListeners = new Set<() => void>();
export function resetLibraryCaches() {
  cache.clear(); settled.clear();
  playlistEditors.clear();
  resets.forEach(reset => reset());
  epoch++;
  listeners.forEach(listener => listener('*'));
  epochListeners.forEach(listener => listener());
}
// Bumps on every reset, for state that lives outside useResource.
export const useLibraryEpoch = () => useSyncExternalStore(listener => { epochListeners.add(listener); return () => { epochListeners.delete(listener); }; }, () => epoch);

export function useResource<T>(key: string | null, loader: () => Promise<Result<T>>): Result<T> | undefined {
  const [value, setValue] = useState<{ key: string; result: Result<T> } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!key) return;
    const listener = (changed: string) => { if (changed === key || changed === '*') { setValue(null); setVersion(v => v + 1); } };
    listeners.add(listener);
    let live = true;
    void load(key, loader).then(result => { if (live) setValue({ key, result }); });
    return () => { live = false; listeners.delete(listener); };
  }, [key, version]);
  if (value && value.key === key) return value.result;
  return key ? settled.get(key) as Result<T> | undefined : undefined;
}

// Playlist editing ------------------------------------------------------------------------
// Every change to one playlist (from its page or from a menu) goes through one queue, one
// request at a time, because the server's edits are positional: "remove index 3" means a
// different song if an earlier edit hasn't landed yet. Each queued edit names songs by entry
// key, not index, and is translated into a request against the server's own list at the
// moment it is sent. After each request the playlist is read back from the server, and the
// page shows that confirmed list with the still-queued edits applied on top. A refused edit
// is simply dropped from the queue, so it can't undo edits that succeeded after it.

export interface Entry { key: string; track: Track }
export type PlaylistEdit =
  | { kind: 'add'; entries: Entry[] }
  | { kind: 'remove'; keys: string[] }
  // `after` is the entry the song should follow (null for the top); `to` is the fallback
  // position when that entry is gone.
  | { kind: 'move'; key: string; after: string | null; to: number }
  | { kind: 'rename'; name: string }
  | { kind: 'delete' };
interface Confirmed { playlist: Playlist; entries: Entry[] }
export interface PlaylistView {
  playlist: Playlist | null; tracks: Track[]; entries: Entry[];
  // Loading until the first read from the server; its error if that failed.
  loading: boolean; loadError: string | null;
  error: string | null; deleted: boolean; saving: boolean;
}
type Task = { edit: PlaylistEdit | { kind: 'sync' }; done(result: Result): void };
type EditsApi = Pick<LibraryApi, 'playlist' | 'addToPlaylist' | 'removeFromPlaylist' | 'reorderPlaylist' | 'updatePlaylist' | 'deletePlaylist'>;

let keys = 0;
const entryOf = (track: Track): Entry => ({ key: `e${++keys}`, track });

export function applyEdit(state: Confirmed, edit: PlaylistEdit | { kind: 'sync' }): Confirmed {
  switch (edit.kind) {
    case 'add': return { ...state, entries: [...state.entries, ...edit.entries] };
    case 'remove': { const drop = new Set(edit.keys); return { ...state, entries: state.entries.filter(e => !drop.has(e.key)) }; }
    case 'move': {
      const moving = state.entries.find(e => e.key === edit.key);
      if (!moving) return state;
      const rest = state.entries.filter(e => e !== moving);
      const anchor = edit.after === null ? -1 : rest.findIndex(e => e.key === edit.after);
      const at = edit.after === null ? 0 : anchor >= 0 ? anchor + 1 : Math.min(edit.to, rest.length);
      return { ...state, entries: [...rest.slice(0, at), moving, ...rest.slice(at)] };
    }
    case 'rename': return { ...state, playlist: { ...state.playlist, name: edit.name } };
    default: return state;
  }
}
// Give the server's list the keys it had locally, matching songs in order, so a queued edit
// still finds its songs after a read-back. Songs the server added get fresh keys.
function rekey(tracks: Track[], known: Entry[]): Entry[] {
  const pools = new Map<string, Entry[]>();
  for (const entry of known) pools.set(entry.track.id, [...(pools.get(entry.track.id) ?? []), entry]);
  return tracks.map(track => { const match = pools.get(track.id)?.shift(); return match ? { key: match.key, track } : entryOf(track); });
}

export class PlaylistEditor {
  private confirmed: Confirmed | null = null;
  private tasks: Task[] = [];
  private running = false;
  private loadError: string | null = null;
  private error: string | null = null;
  private deleted = false;
  private view: PlaylistView;
  private readonly listeners = new Set<() => void>();

  constructor(readonly id: string, private readonly source: EditsApi = api) { this.view = this.compute(); }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get snapshot() { return this.view; }
  get idle() { return !this.tasks.length && !this.listeners.size; }

  // Read the playlist from the server, in turn with any edits already queued.
  sync() { if (!this.tasks.some(task => task.edit.kind === 'sync')) void this.enqueue({ kind: 'sync' }); }
  add(tracks: Track[]) { return this.enqueue({ kind: 'add', entries: tracks.map(entryOf) }); }
  rename(name: string) { return this.enqueue({ kind: 'rename', name }); }
  delete() { return this.enqueue({ kind: 'delete' }); }
  // Indexes refer to the list as shown (this.snapshot.tracks). `expect` guards against a list
  // that changed between the click and the call.
  removeAt(indexes: number[], expect?: Track[]): Promise<Result> {
    const entries = this.view.entries;
    const picked = indexes.map(i => entries[i]);
    if (picked.some((entry, i) => !entry || (expect && expect[i]?.id !== entry.track.id))) return Promise.resolve(this.changed());
    return this.enqueue({ kind: 'remove', keys: picked.map(e => e.key) });
  }
  move(from: number, to: number): Promise<Result> {
    const entries = this.view.entries;
    const moving = entries[from];
    if (!moving || to < 0 || to >= entries.length) return Promise.resolve(this.changed());
    if (from === to) return Promise.resolve({ ok: true, value: undefined });
    const rest = entries.filter((_, i) => i !== from);
    return this.enqueue({ kind: 'move', key: moving.key, after: to === 0 ? null : rest[to - 1].key, to });
  }

  private changed(): Result { return { ok: false, error: 'The playlist changed while you were editing it. Try again.' }; }
  private enqueue(edit: Task['edit']): Promise<Result> {
    if (this.deleted) return Promise.resolve({ ok: false, error: 'This playlist has been deleted.' });
    return new Promise(done => {
      this.tasks.push({ edit, done });
      if (edit.kind !== 'sync') this.error = null;
      this.refresh();
      void this.pump();
    });
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    while (this.tasks.length) {
      const task = this.tasks[0];
      let result: Result;
      try { result = await this.run(task.edit); }
      catch { result = { ok: false, error: 'Could not reach the library. Check your connection and try again.' }; }
      this.tasks.shift();
      // A failed first read shows as loadError; a failed refresh keeps the last list and says so.
      if (!result.ok && (task.edit.kind !== 'sync' || this.confirmed)) this.error = task.edit.kind === 'sync' ? `Could not refresh the playlist. ${result.error}` : result.error;
      if (this.deleted) for (const rest of this.tasks.splice(0)) rest.done({ ok: false, error: 'This playlist has been deleted.' });
      this.refresh();
      task.done(result);
    }
    this.running = false;
  }
  private async read(known: Entry[]): Promise<Result> {
    invalidate(`playlist:${this.id}`);
    const fresh = await load(`playlist:${this.id}`, () => this.source.playlist(this.id));
    if (!fresh.ok) return fresh;
    this.confirmed = { playlist: fresh.value.playlist, entries: rekey(fresh.value.tracks, known) };
    this.loadError = null;
    return { ok: true, value: undefined };
  }
  private async run(edit: Task['edit']): Promise<Result> {
    const base = this.confirmed;
    if (edit.kind === 'sync') {
      const read = await this.read(base?.entries ?? []);
      if (!read.ok && !base) this.loadError = read.error;
      return read;
    }
    let request: Promise<Result> | null;
    switch (edit.kind) {
      case 'add': request = this.source.addToPlaylist(this.id, edit.entries.map(e => e.track.id)); break;
      case 'rename': request = this.source.updatePlaylist(this.id, { name: edit.name }); break;
      case 'delete': request = this.source.deletePlaylist(this.id); break;
      case 'remove': {
        if (!base) return { ok: false, error: 'The playlist is still loading. Try again in a moment.' };
        const drop = new Set(edit.keys);
        const indexes = base.entries.flatMap((e, i) => drop.has(e.key) ? [i] : []);
        request = indexes.length ? this.source.removeFromPlaylist(this.id, indexes) : null;
        break;
      }
      case 'move': {
        if (!base) return { ok: false, error: 'The playlist is still loading. Try again in a moment.' };
        // The new order is built from the server's confirmed list, so songs removed there
        // (by an earlier edit or another device) are never written back.
        const next = applyEdit(base, edit).entries;
        request = next.some((e, i) => e !== base.entries[i]) ? this.source.reorderPlaylist(this.id, next.map(e => e.track.id)) : null;
        break;
      }
    }
    // Nothing to send: the songs involved are already gone, or already in place.
    if (!request) return { ok: true, value: undefined };
    const result = await request;
    invalidate(`playlist:${this.id}`); invalidate('playlists');
    if (edit.kind === 'delete') { if (result.ok) this.deleted = true; return result; }
    // Read back what the server now holds. Until then (or if that fails) trust the edit's own effect.
    if (base) {
      const expected = result.ok ? applyEdit(base, edit) : base;
      const read = await this.read(expected.entries);
      if (!read.ok) this.confirmed = expected;
      if (result.ok && !read.ok) return { ok: false, error: `Saved, but the playlist could not be read back. ${read.error}` };
    }
    return result;
  }
  private compute(): PlaylistView {
    let state = this.confirmed;
    if (state) for (const task of this.tasks) state = applyEdit(state, task.edit);
    const entries = state?.entries ?? [];
    // Keep the track array stable when the songs are the same, so lists don't reset selection.
    const previous = this.view as PlaylistView | undefined;
    const same = previous && previous.entries.length === entries.length && previous.entries.every((e, i) => e.key === entries[i].key && e.track === entries[i].track);
    return {
      playlist: state?.playlist ?? null,
      entries: same ? previous.entries : entries, tracks: same ? previous.tracks : entries.map(e => e.track),
      loading: !this.confirmed && !this.loadError, loadError: this.confirmed ? null : this.loadError,
      error: this.error, deleted: this.deleted, saving: this.tasks.some(task => task.edit.kind !== 'sync'),
    };
  }
  private refresh() { this.view = this.compute(); this.listeners.forEach(listener => listener()); }
}

// One editor per playlist, shared by its page and every menu. Idle editors are let go.
const playlistEditors = new Map<string, PlaylistEditor>();
export function playlistEditor(id: string): PlaylistEditor {
  let editor = playlistEditors.get(id);
  if (!editor) {
    editor = new PlaylistEditor(id);
    playlistEditors.set(id, editor);
    for (const [other, stale] of playlistEditors) { if (playlistEditors.size <= 24) break; if (stale.idle && other !== id) playlistEditors.delete(other); }
  }
  return editor;
}
export function usePlaylist(id: string): PlaylistView {
  const session = useLibraryEpoch();
  const editor = useMemo(() => playlistEditor(id), [id, session]);
  useEffect(() => { editor.sync(); }, [editor]);
  return useSyncExternalStore(editor.subscribe, () => editor.snapshot);
}
