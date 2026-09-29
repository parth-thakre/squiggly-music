import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import type { Album, Playlist, Result, Track } from '../../../../../packages/core/contracts';
import { showNotice } from './extensions/notices';
import { playlistEditor } from './library';
import { tracksOf } from './menu';
import { getPlayer, player, QUEUE_LIMIT } from './player';
import type { MenuTarget } from './registry';
import { plural, splitTitle } from './ui';

// Drag and drop, with a mouse or pen. Sleeves, artists, songs (one or a selection), and playlists
// drag onto the queue (the Queue page, the deck's Queue button) and onto playlists (a row on the
// Playlists page, an open playlist's songs). The payload names the target the way menus do
// (`tracksOf` in menu.tsx), with the title as plain text for drops outside the app. Touch keeps
// its long-press menus. Files from the computer drop onto the desktop app's window (useFileDrops).

export const DRAG_TYPE = 'application/x-squiggly';
// Marks a drag that starts in an editable list (the queue, a playlist), where it reorders songs.
// Other targets (the Queue button, the Playlists page) don't take those.
const REORDER_TYPE = 'application/x-squiggly-reorder';
export type DragKind = 'album' | 'artist' | 'tracks' | 'playlist';
export interface DragPayload { kind: DragKind; ids: string[] }
const kinds = new Set<string>(['album', 'artist', 'tracks', 'playlist']);

// Touch screens long-press for the menu (and a phone's sheet); only mice and pens drag.
export const canDrag = () => typeof matchMedia === 'function' && !matchMedia('(pointer: coarse)').matches;

const idsOf = (target: MenuTarget) => target.kind === 'tracks' ? target.tracks.map(track => track.id)
  : [target.kind === 'album' ? target.album.id : target.kind === 'artist' ? target.artist.id : target.playlist.id];
const textOf = (target: MenuTarget) => target.kind === 'tracks' ? target.tracks.map(track => `${splitTitle(track.title).main}, ${track.artist}`).join('\n')
  : target.kind === 'album' ? `${splitTitle(target.album.name).main}, ${target.album.artist}` : target.kind === 'artist' ? target.artist.name : target.playlist.name;
const nameOf = (target: MenuTarget) => target.kind === 'tracks'
  ? target.tracks.length === 1 ? splitTitle(target.tracks[0].title).main : plural(target.tracks.length, 'song')
  : target.kind === 'album' ? splitTitle(target.album.name).main : target.kind === 'artist' ? target.artist.name : target.playlist.name;

// The drag this window started: its songs need no second trip to the server, and songs (which
// have no lookup by id) can only be dropped in the window they came from.
let active: { payload: DragPayload; target: MenuTarget } | null = null;
if (typeof window !== 'undefined') addEventListener('dragend', () => { active = null; }, true);

// Call from a dragstart handler. `reorder`: the list the drag starts in rearranges its songs.
export function startDrag(event: ReactDragEvent, target: MenuTarget, { reorder = false } = {}) {
  const payload: DragPayload = { kind: target.kind, ids: idsOf(target) };
  const data = event.dataTransfer;
  // A sleeve's image would otherwise carry its own address along.
  data.clearData();
  data.setData(DRAG_TYPE, JSON.stringify(payload));
  data.setData('text/plain', textOf(target));
  if (reorder) data.setData(REORDER_TYPE, '');
  data.effectAllowed = reorder ? 'copyMove' : 'copy';
  active = { payload, target };
}

// What's under the pointer, from the types alone (the data itself is readable only on drop).
// `list`: a song list, which also takes drags that reorder another list.
export const carriesItems = (data: DataTransfer | null, list = false) =>
  !!data && data.types.includes(DRAG_TYPE) && (list || !data.types.includes(REORDER_TYPE));
// The drag this window started, when it is the one under the pointer.
export const activeDrag = () => active;

export function readPayload(data: DataTransfer | null): DragPayload | null {
  try {
    const value: unknown = JSON.parse(data?.getData(DRAG_TYPE) || 'null');
    if (!value || typeof value !== 'object') return null;
    const { kind, ids } = value as Record<string, unknown>;
    if (typeof kind !== 'string' || !kinds.has(kind) || !Array.isArray(ids) || !ids.length || ids.length > QUEUE_LIMIT) return null;
    if (!ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)) return null;
    return { kind: kind as DragKind, ids: ids as string[] };
  } catch { return null; }
}

// The target a payload names: the one this window is dragging, or (from another window) a
// record, artist, or playlist looked up by id.
function targetsOf(payload: DragPayload): MenuTarget[] | null {
  if (active && active.payload.kind === payload.kind && active.payload.ids.join('\n') === payload.ids.join('\n')) return [active.target];
  switch (payload.kind) {
    case 'album': return payload.ids.map(id => ({ kind: 'album', album: { id, name: 'this record' } as Album }));
    case 'artist': return payload.ids.map(id => ({ kind: 'artist', artist: { id, name: 'this artist' } }));
    case 'playlist': return payload.ids.map(id => ({ kind: 'playlist', playlist: { id, name: 'this playlist' } as Playlist }));
    default: return null;
  }
}
async function songsOf(payload: DragPayload): Promise<{ tracks: Track[]; name: string } | null> {
  const targets = targetsOf(payload);
  if (!targets) { player.showError('Songs dragged from another window can’t be dropped here. Use Add to queue or Add to playlist instead.'); return null; }
  const tracks: Track[] = [];
  for (const target of targets) {
    const result: Result<Track[]> = await tracksOf(target);
    if (!result.ok) { player.showError(result.error); return null; }
    tracks.push(...result.value);
  }
  const name = targets.length === 1 ? nameOf(targets[0]) : plural(tracks.length, 'song');
  if (!tracks.length) { player.showError(`There are no songs in ${name}.`); return null; }
  return { tracks, name };
}

// A playlist the server manages takes no songs. Said once as the drag arrives over it (the
// pointer shows it can't drop there), not again for every row it crosses.
let refused: { id: string; at: number } | null = null;
export function refuseDrop(playlist: Playlist, note: string | null) {
  const now = performance.now();
  if (refused?.id === playlist.id && now - refused.at < 4000) return;
  refused = { id: playlist.id, at: now };
  showNotice('', `Songs can’t be added to ${playlist.name}. ${note ?? 'Managed by the server.'}`);
}

// "Add to queue", or before the song at `at` when dropped onto a row of the queue.
export async function dropOnQueue(payload: DragPayload, at?: number) {
  const songs = await songsOf(payload);
  if (!songs) return;
  const idle = getPlayer().index < 0;
  await player.add(songs.tracks, at ?? 'end');
  if (!idle) showNotice('', `Added ${plural(songs.tracks.length, 'song')} to the queue.`);
}

// Songs into a playlist, through its editor (edits queue there and reconcile with the server,
// as the menu's Add to playlist does). `at` places them before that row of the list as shown.
// Playlists the server manages refuse, saying why.
export async function dropOnPlaylist(playlist: Playlist, payload: DragPayload, refusal: string | null, at?: number) {
  if (playlist.readonly) { refuseDrop(playlist, refusal); return; }
  if (payload.kind === 'playlist' && payload.ids.includes(playlist.id)) return;
  const songs = await songsOf(payload);
  if (!songs) return;
  const result = await playlistEditor(playlist.id).add(songs.tracks, at);
  if (!result.ok) { player.showError(result.error); return; }
  showNotice('', `Added ${plural(songs.tracks.length, 'song')} to ${playlist.name}.`);
}

// A place to drop records, artists, songs, and playlists. `over` is true while a payload it
// takes is under the pointer, for the --accent outline. `list` targets also take drags that
// reorder another list. Returns the props to spread on the element.
export function useDropTarget(onDrop: (payload: DragPayload, event: ReactDragEvent) => void, { list = false, enabled = true, accepts }: { list?: boolean; enabled?: boolean; accepts?(): boolean } = {}) {
  const [over, setOver] = useState(false);
  const take = (event: ReactDragEvent) => enabled && carriesItems(event.dataTransfer, list) && (!accepts || accepts());
  // A cancelled drag or a drop elsewhere clears the outline, whatever the leave events did.
  useEffect(() => {
    if (!over) return;
    const clear = () => setOver(false);
    addEventListener('dragend', clear, true); addEventListener('drop', clear, true);
    return () => { removeEventListener('dragend', clear, true); removeEventListener('drop', clear, true); };
  }, [over]);
  const handlers = {
    onDragEnter: (event: ReactDragEvent) => { if (take(event)) { event.preventDefault(); setOver(true); } },
    onDragOver: (event: ReactDragEvent) => {
      if (!take(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      if (!over) setOver(true);
    },
    onDragLeave: (event: ReactDragEvent) => {
      if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(false);
    },
    onDrop: (event: ReactDragEvent) => {
      if (!take(event)) return;
      event.preventDefault(); event.stopPropagation();
      setOver(false);
      const payload = readPayload(event.dataTransfer);
      if (payload) onDrop(payload, event);
    },
  };
  return { over, handlers };
}

// Files from the computer, dropped anywhere on the desktop app's window: they play, or join the
// end of the queue when something is already loaded (Shift plays them now). The Files go to the
// preload, which sends their paths to the main process; the page never sees a path. The main
// process checks them as it checks Open files, and refuses more than a full queue. The browser
// and Android builds take no files: the drop is swallowed so the page isn't replaced by the file.
const carriesFiles = (data: DataTransfer | null) => !!data && data.types.includes('Files') && !data.types.includes(DRAG_TYPE);
export function useFileDrops() {
  const depth = useRef(0);
  useEffect(() => {
    const desktop = window.squiggly;
    const room = () => document.querySelector('.room');
    const show = (on: boolean) => room()?.classList.toggle('files-over', on);
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (desktop && ++depth.current === 1) show(true);
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer) || !desktop) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) show(false);
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = desktop ? 'copy' : 'none';
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current = 0; show(false);
      if (!desktop?.openDropped) return;
      const files = [...event.dataTransfer!.files];
      if (!files.length) return;
      const state = getPlayer();
      void desktop.openDropped(files, event.shiftKey || state.index < 0 ? 'play' : 'queue').then(result => {
        if (!result.ok) { player.showError(result.error); return; }
        const { opened, skipped } = result.value;
        if (skipped) showNotice('', `Opened ${plural(opened, 'file')} and left out ${plural(skipped, 'item')}. Only audio files open, not folders.`);
      });
    };
    addEventListener('dragenter', enter); addEventListener('dragleave', leave); addEventListener('dragover', over); addEventListener('drop', drop);
    return () => { removeEventListener('dragenter', enter); removeEventListener('dragleave', leave); removeEventListener('dragover', over); removeEventListener('drop', drop); };
  }, []);
}
