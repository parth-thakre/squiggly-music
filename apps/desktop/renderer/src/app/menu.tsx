import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';
import type { Playlist, Result, Track } from '../../../../../packages/core/contracts';
import { isStarred, setStarred } from './favorites';
import { api, invalidate, load, playlistEditor } from './library';
import { current, getPlayer, player, type PlayerState } from './player';
import { nav } from './route';
import { labelOf, registry, type MenuItem, type MenuTarget } from './registry';
import { kHz, length, plural, shuffled, splitTitle } from './ui';

// One menu for right-click on desktop and long-press on phones (Chrome fires contextmenu for both).
// Every call into an item (its label, predicate, submenu, action, or text field) goes through
// one error boundary: an item that throws is reported in plain words, in the menu or the deck,
// and never leaves the menu stuck on "Loading".
interface Row { item: MenuItem; label: string }
// `from` is the item that opened this level, so Back can return focus to it.
interface Level { title: string; rows: Row[] | null; from?: string }
interface OpenMenu { x: number; y: number; target: MenuTarget; levels: Level[]; error: string | null; invoker: HTMLElement | null }
let open: OpenMenu | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const setOpen = (next: OpenMenu | null) => { open = next; emit(); };

const titleOf = (target: MenuTarget) => target.kind === 'tracks'
  ? target.tracks.length === 1 ? splitTitle(target.tracks[0].title).main : plural(target.tracks.length, 'song')
  : target.kind === 'album' ? splitTitle(target.album.name).main : target.kind === 'artist' ? target.artist.name : target.playlist.name;

const describe = (error: unknown) => error instanceof Error && error.message ? error.message : typeof error === 'string' && error ? error : 'Something went wrong.';
const failed = (what: string, error: unknown) => `${what} didn't work. ${describe(error)}`;
function rowsFor(items: MenuItem[], target: MenuTarget, problems: string[]): Row[] {
  return items.flatMap(item => {
    try { return [{ item, label: labelOf(item, target) }]; } catch (error) { problems.push(failed(`The item “${item.id}”`, error)); return []; }
  });
}

export function openMenu(event: Pick<ReactMouseEvent, 'clientX' | 'clientY' | 'preventDefault'> & { target?: EventTarget | null }, target: MenuTarget) {
  event.preventDefault();
  // Focus goes back here when the menu closes: the control that opened it, or whatever had focus.
  const origin = event.target instanceof Element ? event.target.closest<HTMLElement>('button, a[href], input, select, [tabindex]') : null;
  const invoker = origin ?? (document.activeElement instanceof HTMLElement && !document.activeElement.closest('.menu-layer') ? document.activeElement : null);
  const problems: string[] = [];
  const items = registry.menu.for(target, (item, error) => problems.push(failed(`The item “${item.id}”`, error)));
  setOpen({ x: event.clientX, y: event.clientY, target, levels: [{ title: titleOf(target), rows: rowsFor(items, target, problems) }], error: problems[0] ?? null, invoker });
  // On phones the menu is a sheet, so the back gesture closes it first, like the now-playing
  // sheet. (Not while that sheet is open: it already owns the back gesture.)
  if (!inHistory && matchMedia('(max-width: 760px)').matches && !nav.overlayOpen) {
    inHistory = true;
    nav.openOverlay(() => {}, () => { inHistory = false; finishClose(); closed?.(); closed = null; });
  }
}
let inHistory = false;
let closed: (() => void) | null = null;
function finishClose() {
  if (!open) return;
  const { invoker } = open;
  setOpen(null);
  const focus = document.activeElement;
  if (invoker?.isConnected && (!focus || focus === document.body || focus.closest('.menu-layer'))) invoker.focus({ preventScroll: true });
}
// Resolves once the menu is really gone, including its history entry on phones, so an action
// that navigates runs after the back step rather than being undone by it.
export function closeMenu(): Promise<void> {
  if (!inHistory) { finishClose(); return Promise.resolve(); }
  return new Promise(resolve => { closed = resolve; nav.closeOverlay(); });
}
const popLevel = (menu: OpenMenu) => setOpen({ ...menu, levels: menu.levels.slice(0, -1), error: null });

// Creates a playlist, refreshes the playlist list, and opens the new playlist unless `open` is
// false. Returns the error to show, or null.
export async function createPlaylist(name: string, trackIds: string[], open = true): Promise<string | null> {
  const created = await api.createPlaylist(name, trackIds);
  if (!created.ok) return created.error;
  invalidate('playlists');
  if (open) nav.go({ view: 'playlist', id: created.value.id });
  return null;
}

// The songs behind any target, for play, queue, and add-to-playlist. A record that fails to
// load fails the whole request, so nothing is played or added with songs silently missing.
export async function tracksOf(target: MenuTarget): Promise<Result<Track[]>> {
  if (target.kind === 'tracks') return { ok: true, value: target.tracks };
  if (target.kind === 'album') {
    const r = await load(`album:${target.album.id}`, () => api.album(target.album.id));
    return r.ok ? { ok: true, value: r.value.tracks } : r;
  }
  if (target.kind === 'playlist') {
    // An open playlist's own view includes edits that are still being saved.
    const view = playlistEditor(target.playlist.id).snapshot;
    if (view.playlist && !view.saving) return { ok: true, value: view.tracks };
    const r = await load(`playlist:${target.playlist.id}`, () => api.playlist(target.playlist.id));
    return r.ok ? { ok: true, value: r.value.tracks } : r;
  }
  const artist = await load(`artist:${target.artist.id}`, () => api.artist(target.artist.id));
  if (!artist.ok) return artist;
  // A few at a time: an artist with two hundred records shouldn't fire two hundred requests at once.
  const albums = artist.value.albums, details: Result<{ tracks: Track[] }>[] = new Array(albums.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, albums.length) }, async () => {
    while (next < albums.length) { const i = next++; details[i] = await load(`album:${albums[i].id}`, () => api.album(albums[i].id)); }
  }));
  const missing = details.filter(detail => !detail.ok);
  if (missing.length) {
    const first = missing[0] as Extract<Result, { ok: false }>;
    return { ok: false, error: `${plural(missing.length, 'record')} by ${target.artist.name} could not be loaded, so nothing was changed. ${first.error}` };
  }
  return { ok: true, value: details.flatMap(detail => detail.ok ? detail.value.tracks : []) };
}

export function ContextMenu() {
  const menu = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => open);
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  // The id of the item whose text field is showing.
  const [typing, setTyping] = useState<string | null>(null);
  // Where focus should land after the next render (an item id), if not the first item.
  const focusNext = useRef<string | null>(null);
  const sheet = matchMedia('(max-width: 760px)').matches;
  const level = menu?.levels[menu.levels.length - 1];

  const choose = async (at: OpenMenu, row: Row) => {
    const { item, label } = row;
    if (item.input) { setTyping(item.id); return; }
    if (item.submenu) {
      const next: Level = { title: label, rows: null, from: item.id };
      setOpen({ ...at, levels: [...at.levels, next], error: null });
      const problems: string[] = [];
      let rows: Row[] = [];
      try { rows = rowsFor(await item.submenu(at.target), at.target, problems); } catch (error) { problems.push(failed(label, error)); }
      const now = open;
      if (now && now.levels[now.levels.length - 1] === next) setOpen({ ...now, levels: [...now.levels.slice(0, -1), { ...next, rows }], error: problems[0] ?? null });
      return;
    }
    await closeMenu();
    try { await item.run?.(at.target); } catch (error) { report(failed(label, error)); }
  };
  const submit = async (at: OpenMenu, row: Row, value: string) => {
    let error: string | void;
    try { error = await row.item.input!.submit(at.target, value); } catch (thrown) { error = failed(row.label, thrown); }
    // Only touch the menu this field belonged to; the listener may have moved on.
    if (!open || open.target !== at.target) { if (error) report(error); return; }
    if (error) setOpen({ ...open, error }); else void closeMenu();
  };

  useLayoutEffect(() => {
    if (!menu || !box.current || sheet) { setPosition(null); return; }
    const { width, height } = box.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(menu.x, innerWidth - width - 8)), top: Math.max(8, Math.min(menu.y, innerHeight - height - 8)) });
  }, [menu, level?.rows?.length, typing]);
  // A new level (or a new menu) starts with no text field open and focus on its first item,
  // once the menu is placed (a hidden element can't take focus).
  const focusPending = useRef(false);
  useLayoutEffect(() => { setTyping(null); focusPending.current = !!level; }, [level]);
  useLayoutEffect(() => {
    if (!focusPending.current || (!sheet && !position)) return;
    focusPending.current = false;
    const wanted = focusNext.current;
    focusNext.current = null;
    const target = (wanted && box.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(wanted)}"]`))
      || box.current?.querySelector<HTMLElement>('[role="menuitem"]') || box.current;
    target?.focus({ preventScroll: true });
  }, [level, position]);
  // Leaving a text field puts focus back on its item.
  useEffect(() => {
    if (typing || !focusNext.current) return;
    box.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(focusNext.current)}"]`)?.focus();
    focusNext.current = null;
  }, [typing]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      const field = (event.target as HTMLElement | null)?.closest?.('.menu-input');
      // Inside the text field, arrows and Home/End edit the text. Escape leaves the field; a
      // second Escape (now on the item) closes the menu.
      if (field) {
        if (event.key === 'Escape') { event.preventDefault(); focusNext.current = typing; setTyping(null); return; }
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Tab') return;
      }
      const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      const focused = at >= 0 ? level?.rows?.find(row => row.item.id === items[at].dataset.item) : undefined;
      if (event.key === 'Escape' || (event.key === 'ArrowLeft' && menu.levels.length > 1)) {
        event.preventDefault();
        if (menu.levels.length > 1) { focusNext.current = level?.from ?? null; popLevel(menu); } else void closeMenu();
      } else if (event.key === 'ArrowRight' && focused?.item.submenu) {
        event.preventDefault(); void choose(menu, focused);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        items[(at + (event.key === 'ArrowDown' ? 1 : at < 0 ? 0 : -1) + items.length) % items.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); (event.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
      } else if (event.key === 'Tab') {
        // The menu is modal; Tab leaves it rather than wandering into the page behind.
        event.preventDefault(); void closeMenu();
      }
    };
    addEventListener('keydown', onKey); addEventListener('resize', closeMenu); addEventListener('blur', closeMenu);
    return () => { removeEventListener('keydown', onKey); removeEventListener('resize', closeMenu); removeEventListener('blur', closeMenu); };
  }, [menu, level, typing]);
  if (!menu || !level) return null;

  return <div className="menu-layer" onPointerDown={event => { if (event.target === event.currentTarget) closeMenu(); }} onContextMenu={event => { event.preventDefault(); void closeMenu(); }}>
    <div ref={box} className={`menu${sheet ? ' sheet' : ''}`} role="menu" aria-label={level.title} tabIndex={-1}
      style={sheet ? undefined : position ?? { left: menu.x, top: menu.y, visibility: 'hidden' }}>
      <p className="menu-title">{menu.levels.length > 1 && <button type="button" className="menu-back" aria-label="Back" onClick={() => { focusNext.current = level.from ?? null; popLevel(menu); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
        <span>{level.title}</span></p>
      {level.rows === null ? <p className="menu-note" role="status">Loading</p> : level.rows.map((row, i) => {
        const { item } = row;
        const previous = level.rows![i - 1];
        const divider = previous && previous.item.section !== item.section;
        if (item.note) return <p key={item.id} className={`menu-note${divider ? ' divided' : ''}`}>{row.label}</p>;
        if (typing === item.id) return <form key={item.id} className={`menu-input${divider ? ' divided' : ''}`} onSubmit={event => {
          event.preventDefault();
          const value = String(new FormData(event.currentTarget).get('value') ?? '').trim();
          if (value) void submit(menu, row, value);
        }}><input name="value" autoFocus placeholder={item.input!.placeholder} aria-label={item.input!.placeholder} autoComplete="off" /></form>;
        return <button key={item.id} type="button" role="menuitem" data-item={item.id} aria-haspopup={item.submenu ? 'menu' : undefined}
          className={`menu-item${item.danger ? ' danger' : ''}${divider ? ' divided' : ''}`} onClick={() => void choose(menu, row)}>
          <span>{row.label}</span>
          {item.submenu && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        </button>;
      })}
      {menu.error && <p className="menu-note error" role="alert">{menu.error}</p>}
    </div>
  </div>;
}

// Built-in items -------------------------------------------------------------------------
// Registered through a scope like any extension, so a hot reload can take them all back.
const builtin = registry.scope('builtin');
import.meta.hot?.dispose(() => builtin.dispose());

const one = (t: MenuTarget) => t.kind === 'tracks' && t.tracks.length === 1 ? t.tracks[0] : null;
// Errors from menu actions surface in the deck, where playback errors already appear.
let alertLine: (message: string) => void = () => {};
export const onMenuError = (show: (message: string) => void) => { alertLine = show; };
const report = (error: string) => alertLine(error);
// The songs for an action, or null after saying why there are none.
async function songsFor(t: MenuTarget): Promise<Track[] | null> {
  const result = await tracksOf(t);
  if (!result.ok) { report(result.error); return null; }
  if (!result.value.length) { report(`There are no songs in ${titleOf(t)}.`); return null; }
  return result.value;
}

builtin.menu({ id: 'play', section: 0, label: t => t.kind === 'tracks' && t.tracks.length === 1 ? 'Play' : 'Play all',
  run: async t => { const tracks = await songsFor(t); if (tracks) await player.play(tracks, 0); } });
builtin.menu({ id: 'shuffle', section: 0, label: 'Shuffle', when: t => t.kind !== 'tracks' || t.tracks.length > 1,
  run: async t => { const tracks = await songsFor(t); if (tracks) await player.play(shuffled(tracks), 0); } });
builtin.menu({ id: 'play-next', section: 0, label: 'Play next', when: t => !(t.kind === 'tracks' && t.from?.queue),
  run: async t => { const tracks = await songsFor(t); if (tracks) await player.add(tracks, 'next'); } });
builtin.menu({ id: 'queue', section: 0, label: 'Add to queue', when: t => !(t.kind === 'tracks' && t.from?.queue),
  run: async t => { const tracks = await songsFor(t); if (tracks) await player.add(tracks, 'end'); } });
builtin.menu({
  id: 'radio', section: 0, label: 'Start radio',
  when: t => t.kind === 'artist' || t.kind === 'album' || !!one(t),
  run: t => player.radio(t.kind === 'artist' ? { kind: 'artist', id: t.artist.id, label: t.artist.name }
    : t.kind === 'album' ? { kind: 'album', id: t.album.id, label: splitTitle(t.album.name).main }
    : { kind: 'song', track: one(t)!, label: splitTitle(one(t)!.title).main }),
});

builtin.menu({
  id: 'add-to-playlist', section: 1, label: 'Add to playlist',
  submenu: async t => {
    const create: MenuItem = { id: 'new-playlist', section: 0, label: 'New playlist', input: { placeholder: 'Name the new playlist', async submit(target, name) {
      const tracks = await tracksOf(target);
      if (!tracks.ok) return tracks.error;
      return await createPlaylist(name, tracks.value.map(track => track.id), false) ?? undefined;
    } } };
    const playlists = await load('playlists', () => api.playlists());
    if (!playlists.ok) return [create, { id: 'playlists-error', section: 1, note: true, label: `Your playlists could not be loaded. ${playlists.error}` }];
    const self = t.kind === 'playlist' ? t.playlist.id : t.kind === 'tracks' ? t.from?.playlist?.id : undefined;
    return [create, ...playlists.value.filter((p: Playlist) => !p.readonly && p.id !== self).map((p): MenuItem => ({ id: `playlist:${p.id}`, section: 1, label: p.name, async run(target) {
      const tracks = await songsFor(target);
      if (!tracks) return;
      const result = await playlistEditor(p.id).add(tracks);
      if (!result.ok) report(result.error);
    } }))];
  },
});

builtin.menu({ id: 'go-album', section: 2, label: 'Go to record', when: t => !!one(t)?.albumId, run: t => nav.go({ view: 'album', id: one(t)!.albumId! }) });
builtin.menu({
  id: 'go-artist', section: 2, label: 'Go to artist',
  when: t => !!one(t)?.artistId || (t.kind === 'album' && !!t.album.artistId),
  run: t => nav.go({ view: 'artist', id: t.kind === 'album' ? t.album.artistId! : one(t)!.artistId! }),
});

builtin.menu({
  id: 'favorite', section: 3,
  label: t => {
    if (t.kind === 'tracks') return t.tracks.every(track => isStarred(track.id, track.starred)) ? 'Remove from favorites' : 'Add to favorites';
    const item = t.kind === 'album' ? t.album : t.kind === 'artist' ? t.artist : null;
    return item && isStarred(item.id, item.starred) ? 'Remove from favorites' : 'Add to favorites';
  },
  when: t => t.kind !== 'playlist',
  async run(t) {
    const kind = t.kind === 'tracks' ? 'track' : t.kind === 'album' ? 'album' : 'artist';
    const items = t.kind === 'tracks' ? t.tracks : [t.kind === 'album' ? t.album : (t as Extract<MenuTarget, { kind: 'artist' }>).artist];
    const all = items.every(item => isStarred(item.id, item.starred));
    const result = await setStarred(kind, items.map(item => item.id), !all);
    if (!result.ok) report(result.error);
  },
});

// Moving a song without dragging, for keyboards, screen readers, and touch. The list that
// owns the song supplies `reorder`; these items only appear when it does.
const reorderOf = (t: MenuTarget) => t.kind === 'tracks' && t.tracks.length === 1 ? t.reorder : undefined;
const canRaise = (t: MenuTarget) => (reorderOf(t)?.index ?? 0) > 0;
const canLower = (t: MenuTarget) => { const r = reorderOf(t); return !!r && r.index < r.length - 1; };
builtin.menu({ id: 'move-top', section: 4, label: 'Move to top', when: canRaise, run: t => reorderOf(t)!.move(0) });
builtin.menu({ id: 'move-up', section: 4, label: 'Move up', when: canRaise, run: t => { const r = reorderOf(t)!; r.move(r.index - 1); } });
builtin.menu({ id: 'move-down', section: 4, label: 'Move down', when: canLower, run: t => { const r = reorderOf(t)!; r.move(r.index + 1); } });
builtin.menu({ id: 'move-bottom', section: 4, label: 'Move to bottom', when: canLower, run: t => { const r = reorderOf(t)!; r.move(r.length - 1); } });

builtin.menu({
  id: 'remove-from-playlist', section: 5, label: 'Remove from this playlist', danger: true,
  when: t => t.kind === 'tracks' && !!t.from?.playlist && !t.from.playlist.readonly && !!t.indexes?.length,
  async run(t) {
    if (t.kind !== 'tracks' || !t.from?.playlist) return;
    const result = await playlistEditor(t.from.playlist.id).removeAt(t.indexes!, t.tracks);
    if (!result.ok) report(result.error);
  },
});
builtin.menu({
  id: 'remove-from-queue', section: 5, label: 'Remove from queue', danger: true,
  when: t => t.kind === 'tracks' && !!t.from?.queue && !!t.indexes?.length,
  run: t => { if (t.kind === 'tracks') void player.remove(t.indexes!); },
});

builtin.menu({
  id: 'rename-playlist', section: 5, label: 'Rename', when: t => t.kind === 'playlist' && !t.playlist.readonly,
  input: { placeholder: 'New name', async submit(t, name) {
    if (t.kind !== 'playlist') return;
    const result = await playlistEditor(t.playlist.id).rename(name);
    if (!result.ok) return result.error;
  } },
});
builtin.menu({
  id: 'delete-playlist', section: 5, label: 'Delete playlist', danger: true, when: t => t.kind === 'playlist' && !t.playlist.readonly,
  submenu: t => t.kind !== 'playlist' ? [] : [
    { id: 'confirm-note', section: 0, note: true, label: `Delete “${t.playlist.name}” from your server? Its songs stay in your library.` },
    { id: 'confirm-delete', section: 1, danger: true, label: 'Delete', async run() {
      const result = await playlistEditor(t.playlist.id).delete();
      if (!result.ok) { report(result.error); return; }
      const route = nav.current;
      if (route.view === 'playlist' && route.id === t.playlist.id) nav.go({ view: 'playlists' });
    } },
  ],
});

// The browser build may fall back to MP3 for an original it can't decode; the player says
// which it is doing for the current song only.
const deliveryOf = (track: Track): PlayerState['delivery'] => {
  const state = getPlayer();
  return current(state)?.id === track.id ? state.delivery ?? null : null;
};
builtin.menu({
  id: 'info', section: 6, label: 'Song details', when: t => !!one(t),
  submenu: t => {
    const track = one(t)!;
    const lines = [
      [track.sourceFormat?.toUpperCase(), kHz(track.sourceSampleRate), track.sourceBitDepth && `${track.sourceBitDepth}-bit`].filter(Boolean).join(', ') || 'Format not reported',
      [track.duration && length(track.duration), track.year, track.genre].filter(Boolean).join(', '),
      `${track.artist}, ${splitTitle(track.album).main}`,
      track.source !== 'navidrome' ? 'A file on this computer.'
        : deliveryOf(track) === 'mp3-fallback' ? 'This browser couldn’t decode the original, so it is playing a 320 kbps MP3 from Navidrome instead.'
        : 'Requested from Navidrome as the original file.',
    ].filter(Boolean);
    return lines.map((line, i): MenuItem => ({ id: `info-${i}`, section: 0, note: true, label: String(line) }));
  },
});
