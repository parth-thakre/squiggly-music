import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { isStation } from '../../../../../packages/core/stations';
import type { Playlist, Track } from '../../../../../packages/core/contracts';
import { canDrag, carriesItems, readPayload, startDrag, type DragPayload } from './drag';
import { isStarred, setStarred, useFavoritesVersion } from './favorites';
import { openMenu } from './menu';
import { current, player, usePlayer } from './player';
import { nav } from './route';
import { RatingStars } from './ratings';
import { useActiveTheme } from './theme';
import { Glyph, splitTitle, time, Wave } from './ui';
import { isKept, keptSupported, useKeptVersion } from './keptState';
import { KeptMark } from './keptMark';
import './kept.css';

// Song rows are --row-height tall (compact themes shorten them); windowing uses the same number.
const rowHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-height')) || 44;
const WINDOWED = 120;
// A click that came from a finger. Chrome sends clicks as pointer events that say so; a browser
// that doesn't goes by the screen.
const tapped = (event: ReactMouseEvent) => {
  const type = (event.nativeEvent as Partial<PointerEvent>).pointerType;
  return type ? type === 'touch' : matchMedia('(pointer: coarse)').matches;
};

// Rows outside the queue are known by song id and occurrence ("a", "a#2"), so a fresh array
// holding the same songs keeps its selection, and a structural change keeps what still exists.
function occurrenceKeys(tracks: Track[]) {
  const seen = new Map<string, number>();
  return tracks.map(track => { const n = (seen.get(track.id) ?? 0) + 1; seen.set(track.id, n); return n === 1 ? track.id : `${track.id}#${n}`; });
}

// A song list. Click plays (on a touch screen, a tap anywhere on the row); ctrl/cmd-click and
// shift-click select; right-click or long-press opens the menu for the selection. Rows (or the
// selection) drag onto the queue and playlists (drag.ts). Where the list is editable, rows drag to reorder, Alt+Up and Alt+Down move the
// focused or selected song, and Delete removes the selection. With `onDropItems`, records,
// artists, and songs from elsewhere drop between rows, before the row under the pointer.
// A heading between rows (a record's discs): it sits above the row at index `at`.
export interface TrackGroup { at: number; label: string }
const noGroups: TrackGroup[] = [];

export function TrackTable({ tracks, album, albumArtist, showAlbum = false, numbered = 'position', onPick, playlist, queue, onMove, onRemove, onDropItems, groups = noGroups, keptMarks = true }: {
  tracks: Track[]; album?: string; albumArtist?: string; showAlbum?: boolean; numbered?: 'position' | 'track';
  // In the queue, the entry id the click saw comes along: pass it to player.jump.
  onPick?(index: number, entryId?: string): void;
  // Where these songs live, for menu items like "Remove from this playlist".
  playlist?: Playlist; queue?: boolean;
  onMove?(from: number, to: number): void;
  onRemove?(indexes: number[]): void;
  // A drop from outside the list, to go before the song at `at`.
  onDropItems?(payload: DragPayload, at: number): void;
  // Headings only: rows keep one numbering of indexes, one selection, and one keyboard.
  groups?: TrackGroup[];
  // Off where every song listed is kept (the Kept page), so the mark would say nothing.
  keptMarks?: boolean;
}) {
  useActiveTheme();
  const ROW = rowHeight();
  const nowId = usePlayer(s => current(s)?.id);
  const nowIndex = usePlayer(s => s.index);
  const playing = usePlayer(s => s.playing);
  // Queue rows are known by entry, so two copies of a song stay two rows.
  const entryIds = usePlayer(s => queue ? s.entryIds : null);
  useFavoritesVersion();
  useKeptVersion();
  // Away, server songs that aren't kept can't play, and stars can't be changed.
  const away = usePlayer(s => s.reach.away);
  const table = useRef<HTMLOListElement>(null);
  const [range, setRange] = useState<[number, number]>([0, Math.min(tracks.length, 60)]);
  const keys = useMemo(() => entryIds && entryIds.length === tracks.length ? entryIds : occurrenceKeys(tracks), [tracks, entryIds]);
  const positions = useMemo(() => new Map(keys.map((key, i) => [key, i])), [keys]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // The row a context menu is open for, when it isn't part of the selection.
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  // Where a drop from outside would land: before this row.
  const [into, setInto] = useState<number | null>(null);
  useEffect(() => {
    if (into === null) return;
    const clear = () => setInto(null);
    addEventListener('dragend', clear, true); addEventListener('drop', clear, true);
    return () => { removeEventListener('dragend', clear, true); removeEventListener('drop', clear, true); };
  }, [into !== null]);
  const draggable = !!onMove || canDrag();
  // A keyboard move on its way: once the row lands, focus follows it and the move is announced.
  const moving = useRef<{ key: string; to: number; title: string; at: number } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const windowed = tracks.length > WINDOWED;

  // Only a structural change touches the selection, and then only to drop rows that are gone.
  useEffect(() => {
    setSelected(previous => [...previous].every(key => positions.has(key)) ? previous : new Set([...previous].filter(key => positions.has(key))));
    if (anchor.current !== null && !positions.has(anchor.current)) anchor.current = null;
    const pending = moving.current;
    if (pending && positions.get(pending.key) === pending.to) {
      moving.current = null;
      setAnnouncement(`Moved ${pending.title} to position ${pending.to + 1} of ${keys.length}.`);
      const row = table.current?.querySelector<HTMLElement>(`li[data-key="${CSS.escape(pending.key)}"] .track`);
      row?.focus(); row?.scrollIntoView({ block: 'nearest' });
    }
  }, [positions]);
  // Long lists render only the rows near the viewport.
  useEffect(() => {
    if (!windowed) return;
    const scroller = nav.scroller;
    if (!scroller) return;
    const update = () => {
      const top = table.current!.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      // Headings take a row's height each, so a row sits up to groups.length rows lower.
      const first = Math.max(0, Math.floor(-top / ROW) - 10 - groups.length);
      const last = Math.min(tracks.length, Math.ceil((scroller.clientHeight - top) / ROW) + 10);
      setRange(r => r[0] === first && r[1] === last ? r : [first, last]);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    addEventListener('resize', update);
    return () => { scroller.removeEventListener('scroll', update); removeEventListener('resize', update); };
  }, [windowed, tracks.length, ROW, groups.length]);
  // Where a row or heading sits, in rows, counting the headings above it.
  const slot = (index: number, heading = false) => index + groups.filter(group => heading ? group.at < index : group.at <= index).length;

  const [first, last] = windowed ? range : [0, tracks.length];
  const selectedIndexes = () => [...selected].map(key => positions.get(key)).filter((i): i is number => i !== undefined).sort((a, b) => a - b);
  const move = (from: number, to: number) => {
    if (!onMove || from < 0 || from >= tracks.length) return;
    if (to < 0 || to >= tracks.length) { setAnnouncement(to < 0 ? 'Already at the top.' : 'Already at the bottom.'); return; }
    // One move at a time: indexes refer to the list as it is, so a second request sent before
    // the first lands would move the wrong row.
    if (moving.current && performance.now() - moving.current.at < 3000) return;
    moving.current = { key: keys[from], to, title: splitTitle(tracks[from].title, album).main, at: performance.now() };
    onMove(from, to);
  };
  const click = (event: ReactMouseEvent, index: number, isNow: boolean) => {
    const key = keys[index];
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(selected);
      if (next.has(key)) next.delete(key); else next.add(key);
      setSelected(next); anchor.current = key; return;
    }
    const from = anchor.current !== null ? positions.get(anchor.current) : undefined;
    if (event.shiftKey && from !== undefined) {
      setSelected(new Set(keys.slice(Math.min(from, index), Math.max(from, index) + 1))); return;
    }
    setSelected(new Set()); anchor.current = key;
    const track = tracks[index];
    if (away && keptSupported && track.source === 'navidrome' && !isKept(track.id) && !isNow) { player.showError('This song isn\'t kept on this device, and your server is out of reach.'); return; }
    if (isNow) player.toggle(); else if (onPick) onPick(index, entryIds?.[index]); else void player.play(tracks, index);
  };
  // A tap on a touch screen plays from anywhere on the row: its length and the space around the
  // name too, not only the name's button. The row's own buttons (the star) keep their taps, and
  // a mouse keeps its target.
  const rowTap = (event: ReactMouseEvent, index: number, isNow: boolean) => {
    if (!tapped(event) || (event.target as Element).closest('button, a, input')) return;
    click(event, index, isNow);
  };
  const menu = (event: ReactMouseEvent, index: number) => {
    const key = keys[index];
    // A row outside the selection is only marked while its menu is open; the selection stays.
    const indexes = selected.has(key) ? selectedIndexes() : [index];
    if (!selected.has(key)) setMenuRow(key);
    openMenu(event, { kind: 'tracks', tracks: indexes.map(i => tracks[i]), indexes, from: { playlist, queue },
      reorder: onMove && indexes.length === 1 ? { index, length: tracks.length, move: to => move(index, to) } : undefined },
      () => setMenuRow(null));
  };
  // A selected row carries the whole selection; any other row carries itself.
  const dragStart = (event: ReactDragEvent, index: number) => {
    const indexes = selected.has(keys[index]) ? selectedIndexes() : [index];
    startDrag(event, { kind: 'tracks', tracks: indexes.map(i => tracks[i]) }, { reorder: !!onMove });
    if (onMove) setDrag({ from: index, to: index });
  };
  const dragOver = (event: ReactDragEvent, index: number) => {
    if (drag) { event.preventDefault(); if (drag.to !== index) setDrag({ ...drag, to: index }); return; }
    if (!onDropItems || !carriesItems(event.dataTransfer, true)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
    if (into !== index) setInto(index);
  };
  const drop = (event: ReactDragEvent, index: number) => {
    if (drag) { event.preventDefault(); event.stopPropagation(); if (drag.from !== drag.to) onMove?.(drag.from, drag.to); setDrag(null); return; }
    // Anything else is left to the page around the list, if it takes drops.
    if (!onDropItems || !carriesItems(event.dataTransfer, true)) return;
    event.preventDefault(); event.stopPropagation();
    setInto(null);
    const payload = readPayload(event.dataTransfer);
    if (payload) onDropItems(payload, index);
  };
  const keyDown = (event: ReactKeyboardEvent) => {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && onMove) {
      event.preventDefault();
      const focused = (event.target as HTMLElement).closest<HTMLElement>('li[data-index]');
      const from = selected.size === 1 ? positions.get([...selected][0])
        : selected.size === 0 && focused ? Number(focused.dataset.index) : undefined;
      if (from === undefined) { setAnnouncement('Select one song to move it.'); return; }
      move(from, from + (event.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && onRemove && selected.size) { event.preventDefault(); onRemove(selectedIndexes()); setSelected(new Set()); }
    if (event.key === 'Escape' && selected.size) setSelected(new Set());
    if ((event.metaKey || event.ctrlKey) && event.key === 'a') { event.preventDefault(); setSelected(new Set(keys)); }
  };

  return <>
    <ol ref={table} className={`tracks${showAlbum ? ' with-album' : ''}${drag ? ' dragging' : ''}`} onKeyDown={keyDown}
      onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setInto(null); }}
      style={windowed ? { height: (tracks.length + groups.length) * ROW, position: 'relative' } : undefined}>
      {tracks.slice(first, last).map((track, offset) => {
        const index = first + offset;
        const key = keys[index];
        const isNow = queue ? index === nowIndex : track.id === nowId;
        const isSelected = selected.has(key) || menuRow === key;
        const name = splitTitle(track.title, album);
        const starred = isStarred(track.id, track.starred);
        const credit = track.artist !== albumArtist ? track.artist : null;
        const kept = keptSupported && track.source === 'navidrome' && isKept(track.id);
        const unavailable = away && keptSupported && track.source === 'navidrome' && !kept;
        const classes = [isNow && 'now', isSelected && 'selected', unavailable && 'unavailable', drag && drag.to === index && drag.from !== index && (drag.from < index ? 'drop-after' : 'drop-before'),
          !drag && into === index && 'drop-before'].filter(Boolean).join(' ');
        const group = groups.length ? groups.find(g => g.at === index) : undefined;
        const row = <li key={key} data-key={key} data-index={index} className={classes || undefined}
          style={windowed ? { position: 'absolute', top: slot(index) * ROW, left: 0, right: 0 } : undefined}
          draggable={draggable} onContextMenu={event => menu(event, index)} onClick={event => rowTap(event, index, isNow)}
          onDragStart={event => dragStart(event, index)} onDragOver={event => dragOver(event, index)}
          onDrop={event => drop(event, index)} onDragEnd={() => setDrag(null)}>
          <button type="button" className="track" onClick={event => click(event, index, isNow)}
            aria-label={isNow ? `${playing ? 'Pause' : 'Resume'} ${track.title}` : `Play ${track.title}`} aria-pressed={selected.size ? isSelected : undefined}
            aria-description={unavailable ? 'Not kept on this device' : undefined}>
            <span className="n">{isNow ? <Wave playing={playing} /> : numbered === 'track' ? track.trackNumber ?? index + 1 : index + 1}</span>
            <span className="title"><span className="name">{name.main}</span>{name.extra && <span className="extra">{name.extra}</span>}
              {credit && <span className="credit">{credit}</span>}</span>
            {showAlbum && <span className="album">{splitTitle(track.album).main}</span>}
          </button>
          {/* Outside the row's button, which can't hold buttons. Only the server's songs can be rated,
              and only while it's in reach; other rows keep the slot empty so the durations line up. */}
          <span className="row-rating">{track.source === 'navidrome' && !away && <RatingStars target="track" id={track.id} rating={track.userRating} name={track.title} />}</span>
          <span className="figure">{isStation(track) ? 'Live' : time(track.duration)}</span>
          {/* Beside the button, so the row's name stays "Play <title>". */}
          {keptSupported && keptMarks && <span className="kept-slot">{kept && <KeptMark />}</span>}
          {/* A station can't be a favorite: the server stars songs, records, and artists. Away, stars wait for the server. */}
          {isStation(track) || away ? <span className="star" aria-hidden="true" /> : <button type="button" className={`star${starred ? ' on' : ''}`} aria-pressed={starred}
            aria-label={starred ? `Remove ${track.title} from favorites` : `Add ${track.title} to favorites`}
            onClick={() => void setStarred('track', [track.id], !starred)}><Glyph kind={starred ? 'starred' : 'star'} /></button>}
        </li>;
        return group ? [<li key={`group-${index}`} className="group-head"
          style={windowed ? { position: 'absolute', top: slot(index, true) * ROW, left: 0, right: 0 } : undefined}>
          <h2 title={group.label} aria-label={group.label}>{group.label}</h2></li>, row] : row;
      })}
    </ol>
    {onMove && <p className="sr-only" aria-live="polite">{announcement}</p>}
  </>;
}
