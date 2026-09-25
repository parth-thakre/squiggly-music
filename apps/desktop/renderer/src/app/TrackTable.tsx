import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { Playlist, Track } from '../../../../../packages/core/contracts';
import { isStarred, setStarred, useFavoritesVersion } from './favorites';
import { openMenu } from './menu';
import { current, player, usePlayer } from './player';
import { nav } from './route';
import { useActiveTheme } from './theme';
import { Glyph, splitTitle, time, Wave } from './ui';

// Song rows are --row-height tall (compact themes shorten them); windowing uses the same number.
const rowHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-height')) || 44;
const WINDOWED = 120;

// Rows outside the queue are known by song id and occurrence ("a", "a#2"), so a fresh array
// holding the same songs keeps its selection, and a structural change keeps what still exists.
function occurrenceKeys(tracks: Track[]) {
  const seen = new Map<string, number>();
  return tracks.map(track => { const n = (seen.get(track.id) ?? 0) + 1; seen.set(track.id, n); return n === 1 ? track.id : `${track.id}#${n}`; });
}

// A song list. Click plays; ctrl/cmd-click and shift-click select; right-click or long-press
// opens the menu for the selection. Where the list is editable, rows drag to reorder,
// Alt+Up and Alt+Down move the focused or selected song, and Delete removes the selection.
export function TrackTable({ tracks, album, albumArtist, showAlbum = false, numbered = 'position', onPick, playlist, queue, onMove, onRemove }: {
  tracks: Track[]; album?: string; albumArtist?: string; showAlbum?: boolean; numbered?: 'position' | 'track';
  // In the queue, the entry id the click saw comes along: pass it to player.jump.
  onPick?(index: number, entryId?: string): void;
  // Where these songs live, for menu items like "Remove from this playlist".
  playlist?: Playlist; queue?: boolean;
  onMove?(from: number, to: number): void;
  onRemove?(indexes: number[]): void;
}) {
  useActiveTheme();
  const ROW = rowHeight();
  const nowId = usePlayer(s => current(s)?.id);
  const nowIndex = usePlayer(s => s.index);
  const playing = usePlayer(s => s.playing);
  // Queue rows are known by entry, so two copies of a song stay two rows.
  const entryIds = usePlayer(s => queue ? s.entryIds : null);
  useFavoritesVersion();
  const table = useRef<HTMLOListElement>(null);
  const [range, setRange] = useState<[number, number]>([0, Math.min(tracks.length, 60)]);
  const keys = useMemo(() => entryIds && entryIds.length === tracks.length ? entryIds : occurrenceKeys(tracks), [tracks, entryIds]);
  const positions = useMemo(() => new Map(keys.map((key, i) => [key, i])), [keys]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
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
      const first = Math.max(0, Math.floor(-top / ROW) - 10);
      const last = Math.min(tracks.length, Math.ceil((scroller.clientHeight - top) / ROW) + 10);
      setRange(r => r[0] === first && r[1] === last ? r : [first, last]);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    addEventListener('resize', update);
    return () => { scroller.removeEventListener('scroll', update); removeEventListener('resize', update); };
  }, [windowed, tracks.length, ROW]);

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
    if (isNow) player.toggle(); else if (onPick) onPick(index, entryIds?.[index]); else void player.play(tracks, index);
  };
  const menu = (event: ReactMouseEvent, index: number) => {
    const key = keys[index];
    const indexes = selected.has(key) ? selectedIndexes() : [index];
    if (!selected.has(key)) { setSelected(new Set([key])); anchor.current = key; }
    openMenu(event, { kind: 'tracks', tracks: indexes.map(i => tracks[i]), indexes, from: { playlist, queue },
      reorder: onMove && indexes.length === 1 ? { index, length: tracks.length, move: to => move(index, to) } : undefined });
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
      style={windowed ? { height: tracks.length * ROW, position: 'relative' } : undefined}>
      {tracks.slice(first, last).map((track, offset) => {
        const index = first + offset;
        const key = keys[index];
        const isNow = queue ? index === nowIndex : track.id === nowId;
        const isSelected = selected.has(key);
        const name = splitTitle(track.title, album);
        const starred = isStarred(track.id, track.starred);
        const credit = track.artist !== albumArtist ? track.artist : null;
        const classes = [isNow && 'now', isSelected && 'selected', drag && drag.to === index && drag.from !== index && (drag.from < index ? 'drop-after' : 'drop-before')].filter(Boolean).join(' ');
        return <li key={key} data-key={key} data-index={index} className={classes || undefined}
          style={windowed ? { position: 'absolute', top: index * ROW, left: 0, right: 0 } : undefined}
          draggable={!!onMove} onContextMenu={event => menu(event, index)}
          onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; setDrag({ from: index, to: index }); }}
          onDragOver={event => { if (!drag) return; event.preventDefault(); if (drag.to !== index) setDrag({ ...drag, to: index }); }}
          onDrop={event => { event.preventDefault(); if (drag && drag.from !== drag.to) onMove?.(drag.from, drag.to); setDrag(null); }}
          onDragEnd={() => setDrag(null)}>
          <button type="button" className="track" onClick={event => click(event, index, isNow)}
            aria-label={isNow ? `${playing ? 'Pause' : 'Resume'} ${track.title}` : `Play ${track.title}`} aria-pressed={selected.size ? isSelected : undefined}>
            <span className="n">{isNow ? <Wave playing={playing} /> : numbered === 'track' ? track.trackNumber ?? index + 1 : index + 1}</span>
            <span className="title"><span className="name">{name.main}</span>{name.extra && <span className="extra">{name.extra}</span>}
              {credit && <span className="credit">{credit}</span>}</span>
            {showAlbum && <span className="album">{splitTitle(track.album).main}</span>}
            <span className="figure">{time(track.duration)}</span>
          </button>
          <button type="button" className={`star${starred ? ' on' : ''}`} aria-pressed={starred}
            aria-label={starred ? `Remove ${track.title} from favorites` : `Add ${track.title} to favorites`}
            onClick={() => void setStarred('track', [track.id], !starred)}><Glyph kind={starred ? 'starred' : 'star'} /></button>
        </li>;
      })}
    </ol>
    {onMove && <p className="sr-only" aria-live="polite">{announcement}</p>}
  </>;
}
