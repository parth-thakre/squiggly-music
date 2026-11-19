import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { isStation } from '../../../../../packages/core/stations';
import type { Playlist, Track } from '../../../../../packages/core/contracts';
import { GripVertical, X } from 'lucide-react';
import { Credits } from './credits';
import { canDrag, carriesItems, readPayload, startDrag, type DragPayload } from './drag';
import { trackInitial } from './editorial';
import { isStarred, setStarred, useFavoritesVersion } from './favorites';
import { openMenu } from './menu';
import { current, player, usePlayer } from './player';
import { nav } from './route';
import { RatingStars, ratingOf, useRatingsVersion } from './ratings';
import { useActiveTheme } from './theme';
import { Cover, Glyph, plural, splitTitle, time, useWide, Wave } from './ui';
import { isKept, keptSupported, useKeptVersion } from './keptState';
import { KeptMark } from './keptMark';
import './kept.css';

// Song rows are --row-height tall, or --row-two where rows also show the artists or the record
// under the name (compact themes shorten both); windowing uses the same number.
const rowHeight = (two: boolean) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(two ? '--row-two' : '--row-height')) || (two ? 56 : 44);
const WINDOWED = 120;
const tapped = (event: ReactMouseEvent) => {
  const type = (event.nativeEvent as Partial<PointerEvent>).pointerType;
  return type ? type === 'touch' : matchMedia('(pointer: coarse)').matches;
};

function occurrenceKeys(tracks: Track[]) {
  const seen = new Map<string, number>();
  return tracks.map(track => { const n = (seen.get(track.id) ?? 0) + 1; seen.set(track.id, n); return n === 1 ? track.id : `${track.id}#${n}`; });
}

// A heading between rows: discs on a multi-disc record, quiet autoplay labels, or record-change
// dividers in the queue (with the record's sleeve, title, and artist/count). A rule is a bare
// line with no words, closing a record's run in the queue before a song from elsewhere.
export interface TrackGroup {
  at: number;
  label: string;
  quiet?: boolean;
  rule?: true;
  record?: { id?: string | null; name: string; sub: string; coverArt?: string | null };
}
const noGroups: TrackGroup[] = [];
// The list's own move, for a control outside it that stands in for a row (the queue's playing
// song): `focus` false leaves focus where it is.
export type Mover = (from: number, to: number, focus?: boolean) => void;

export function TrackTable({
  tracks, album, albumArtist, showAlbum = false, numbered = 'position', onPick, playlist, queue,
  onMove, onRemove, onDropItems, groups = noGroups, keptMarks = true,
  columns = 1, large = false, leadingCover = false, bookIndex = false, lettered = false,
  noteOf, hideIndex = -1, mover,
}: {
  tracks: Track[]; album?: string; albumArtist?: string; showAlbum?: boolean; numbered?: 'position' | 'track' | 'none';
  onPick?(index: number, entryId?: string): void;
  playlist?: Playlist; queue?: boolean;
  onMove?(from: number, to: number): void;
  onRemove?(indexes: number[]): void;
  onDropItems?(payload: DragPayload, at: number): void;
  groups?: TrackGroup[];
  keptMarks?: boolean;
  // Editorial presentation options:
  // columns: 2 or 'auto' (2 columns from 4+ songs up, desktop single-disc non-windowed).
  columns?: 1 | 2 | 'auto';
  // large: bigger type for short 1–3 song records (singles/EPs).
  large?: boolean | 'auto';
  // leadingCover: 44px sleeve beside the number (artist's Most played).
  leadingCover?: boolean;
  // bookIndex: Tracks page style — letter/number gutter, record+singers stacked on line 2, 40px sleeve on the right.
  bookIndex?: boolean;
  // lettered: show large Young Serif initial letters ("#", "A", "B") on the first song of each group in bookIndex mode.
  lettered?: boolean;
  // Optional quiet note printed before the duration (e.g., "16 plays").
  noteOf?(track: Track): string | null;
  // Queue: index of the currently playing song when it is already shown in the queue's hero header.
  hideIndex?: number;
  // Filled with the list's move (Mover).
  mover?: { current: Mover | null };
}) {
  useActiveTheme();
  const twoLine = useMemo(() => bookIndex || leadingCover || showAlbum || tracks.some(t => t.artist !== albumArtist), [tracks, albumArtist, bookIndex, leadingCover, showAlbum]);
  const ROW = rowHeight(twoLine);
  const nowId = usePlayer(s => current(s)?.id);
  const nowIndex = usePlayer(s => s.index);
  const playing = usePlayer(s => s.playing);
  const entryIds = usePlayer(s => queue ? s.entryIds : null);
  useFavoritesVersion();
  useKeptVersion();
  const away = usePlayer(s => s.reach.away);
  const wide = useWide();
  const table = useRef<HTMLOListElement>(null);
  const [range, setRange] = useState<[number, number]>([0, Math.min(tracks.length, 60)]);
  const keys = useMemo(() => entryIds && entryIds.length === tracks.length ? entryIds : occurrenceKeys(tracks), [tracks, entryIds]);
  const positions = useMemo(() => new Map(keys.map((key, i) => [key, i])), [keys]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [into, setInto] = useState<number | null>(null);
  useEffect(() => {
    if (into === null) return;
    const clear = () => setInto(null);
    addEventListener('dragend', clear, true); addEventListener('drop', clear, true);
    return () => { removeEventListener('dragend', clear, true); removeEventListener('drop', clear, true); };
  }, [into !== null]);
  const draggable = !!onMove || canDrag();
  const moving = useRef<{ key: string; to: number; title: string; at: number; focus: boolean } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const windowed = tracks.length > WINDOWED;

  // Two-column printed listing on desktop when requested, non-windowed, and no group headings split it.
  const twoCol = wide && !windowed && !groups.length && !bookIndex && (columns === 2 || (columns === 'auto' && tracks.length >= 4));
  const isLarge = wide && !windowed && !showAlbum && !bookIndex && !leadingCover && (large === true || (large === 'auto' && tracks.length > 0 && tracks.length <= 3));

  // Precompute book-index initial letters so windowed rows still know when a new letter opens.
  const initials = useMemo(() => {
    if (!bookIndex || !lettered || tracks.length < 24) return null;
    const result: (string | null)[] = new Array(tracks.length);
    let prev = '';
    for (let i = 0; i < tracks.length; i++) {
      const letter = trackInitial(tracks[i].title);
      if (letter !== prev) { result[i] = letter; prev = letter; } else { result[i] = null; }
    }
    return result;
  }, [bookIndex, lettered, tracks]);

  useEffect(() => {
    setSelected(previous => [...previous].every(key => positions.has(key)) ? previous : new Set([...previous].filter(key => positions.has(key))));
    if (anchor.current !== null && !positions.has(anchor.current)) anchor.current = null;
    const pending = moving.current;
    if (pending && positions.get(pending.key) === pending.to) {
      moving.current = null;
      setAnnouncement(`Moved ${pending.title} to position ${pending.to + 1} of ${keys.length}.`);
      if (!pending.focus) return;
      const row = table.current?.querySelector<HTMLElement>(`li[data-key="${CSS.escape(pending.key)}"] .track-play`);
      row?.focus(); row?.scrollIntoView({ block: 'nearest' });
    }
  }, [positions]);

  useEffect(() => {
    if (!windowed) return;
    const scroller = nav.scroller;
    if (!scroller) return;
    const update = () => {
      const top = table.current!.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const first = Math.max(0, Math.floor(-top / ROW) - 10 - groups.length);
      const last = Math.min(tracks.length, Math.ceil((scroller.clientHeight - top) / ROW) + 10);
      setRange(r => r[0] === first && r[1] === last ? r : [first, last]);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    addEventListener('resize', update);
    return () => { scroller.removeEventListener('scroll', update); removeEventListener('resize', update); };
  }, [windowed, tracks.length, ROW, groups.length]);

  const slot = (index: number, heading = false) => index + groups.filter(group => heading ? group.at < index : group.at <= index).length;
  const [first, last] = windowed ? range : [0, tracks.length];
  const selectedIndexes = () => [...selected].map(key => positions.get(key)).filter((i): i is number => i !== undefined).sort((a, b) => a - b);
  const move: Mover = (from, to, focus = true) => {
    if (!onMove || from < 0 || from >= tracks.length) return;
    if (to < 0 || to >= tracks.length) { setAnnouncement(to < 0 ? 'Already at the top.' : 'Already at the bottom.'); return; }
    if (moving.current && performance.now() - moving.current.at < 3000) return;
    moving.current = { key: keys[from], to, title: splitTitle(tracks[from].title, album).main, at: performance.now(), focus };
    onMove(from, to);
  };
  if (mover) mover.current = move;
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
  const rowTap = (event: ReactMouseEvent, index: number, isNow: boolean) => {
    if (!tapped(event) || (event.target as Element).closest('button, a, input')) return;
    click(event, index, isNow);
  };
  const menu = (event: ReactMouseEvent, index: number) => {
    const key = keys[index];
    const indexes = selected.has(key) ? selectedIndexes() : [index];
    if (!selected.has(key)) setMenuRow(key);
    openMenu(event, { kind: 'tracks', tracks: indexes.map(i => tracks[i]), indexes, from: { playlist, queue },
      reorder: onMove && indexes.length === 1 ? { index, length: tracks.length, move: to => move(index, to) } : undefined },
      () => setMenuRow(null));
  };
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
    if (!onDropItems || !carriesItems(event.dataTransfer, true)) return;
    event.preventDefault(); event.stopPropagation();
    setInto(null);
    const payload = readPayload(event.dataTransfer);
    if (payload) onDropItems(payload, index);
  };
  const handlers = useRef<RowHandlers>(null!);
  handlers.current = { click, rowTap, menu, dragStart, dragOver, drop, dragEnd: () => setDrag(null), remove: index => onRemove?.([index]) };
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

  const olClasses = [
    'tracks',
    showAlbum && 'with-album',
    twoLine && 'two-line',
    queue && 'queue-list',
    onMove && 'reorderable',
    windowed && 'windowed',
    drag && 'dragging',
    twoCol && 'listing-two',
    isLarge && 'listing-large',
    leadingCover && 'has-leading-cover',
    bookIndex && 'book-index',
    initials && 'lettered',
  ].filter(Boolean).join(' ');

  const olStyle: CSSProperties | undefined = windowed
    ? { height: (tracks.length + groups.length) * ROW, position: 'relative' }
    : twoCol ? { '--rows': Math.ceil(tracks.length / 2) } as CSSProperties : undefined;

  return <>
    <ol ref={table} className={olClasses} onKeyDown={keyDown}
      onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setInto(null); }}
      style={olStyle}>
      {tracks.slice(first, last).map((track, offset) => {
        const index = first + offset;
        const key = keys[index];
        const isNow = queue ? index === nowIndex : track.id === nowId;
        const kept = keptSupported && track.source === 'navidrome' && isKept(track.id);
        const hiddenHero = hideIndex >= 0 && index === hideIndex;
        const num = queue ? (index > nowIndex ? index - nowIndex : '')
          : numbered === 'none' ? ''
          : numbered === 'track' ? track.trackNumber ?? index + 1
          : index + 1;
        const row = <TrackRow key={key} track={track} index={index} rowKey={key} isNow={isNow} hiddenHero={hiddenHero}
          number={num} initial={initials ? initials[index] : undefined}
          played={!!queue && index < nowIndex} reorderable={!!onMove} removable={!!onRemove} playing={isNow && playing}
          isSelected={selected.has(key) || menuRow === key} selecting={selected.size > 0} starred={isStarred(track.id, track.starred)}
          kept={kept} unavailable={away && keptSupported && track.source === 'navidrome' && !kept} away={away} wide={wide}
          drop={drag && drag.to === index && drag.from !== index ? (drag.from < index ? 'drop-after' : 'drop-before') : !drag && into === index ? 'drop-before' : null}
          top={windowed ? slot(index) * ROW : null} draggable={draggable} album={album} albumArtist={albumArtist}
          showAlbum={showAlbum} leadingCover={leadingCover} bookIndex={bookIndex}
          note={noteOf ? noteOf(track) : null}
          keptMarks={keptMarks} handlers={handlers} />;
        const group = groups.length ? groups.find(g => g.at === index) : undefined;
        if (!group) return row;
        const head = group.rule ? <li key={`group-${index}`} className="group-head rule" aria-hidden="true"
          style={windowed ? { position: 'absolute', top: slot(index, true) * ROW, left: 0, right: 0 } : undefined} />
        : group.record ? <li key={`group-${index}`} className="group-head group-record"
          style={windowed ? { position: 'absolute', top: slot(index, true) * ROW, left: 0, right: 0 } : undefined}>
          {group.record.id ? <button type="button" className="queue-record" data-warm={`album:${group.record.id}`}
            onClick={() => nav.go({ view: 'album', id: group.record!.id! })}>
            <Cover id={group.record.coverArt} name={group.record.name} size={160} className="queue-sleeve" />
            <span className="queue-record-words">
              <span className="queue-record-name">{group.record.name}</span>
              <span className="queue-record-by">{group.record.sub}</span>
            </span>
          </button> : <div className="queue-record">
            <Cover id={group.record.coverArt} name={group.record.name} size={160} className="queue-sleeve" />
            <span className="queue-record-words">
              <span className="queue-record-name">{group.record.name}</span>
              <span className="queue-record-by">{group.record.sub}</span>
            </span>
          </div>}
        </li> : <li key={`group-${index}`} className={`group-head${group.quiet ? ' quiet' : ''}`}
          style={windowed ? { position: 'absolute', top: slot(index, true) * ROW, left: 0, right: 0 } : undefined}>
          <h2 title={group.label} aria-label={group.label}>{group.label}</h2>
        </li>;
        return [head, row];
      })}
    </ol>
    {onMove && <p className="sr-only" aria-live="polite">{announcement}</p>}
  </>;
}

// A row's rating: the stars while the row is pointed at, selected, or focused, else a compact
// figure. Both follow a rating set anywhere (the deck, a menu), not only the one the list loaded.
function RowRating({ track }: { track: Track }) {
  useRatingsVersion();
  const rating = ratingOf(track.id, track.userRating);
  return <span className={`row-rating${rating ? ' rated' : ''}`}>
    {!!rating && <span className="rating-compact" title={plural(rating, 'star')} aria-hidden="true">{rating}<Glyph kind="starred" /></span>}
    <RatingStars target="track" id={track.id} rating={track.userRating} name={track.title} />
  </span>;
}

interface RowHandlers {
  click(event: ReactMouseEvent, index: number, isNow: boolean): void;
  rowTap(event: ReactMouseEvent, index: number, isNow: boolean): void;
  menu(event: ReactMouseEvent, index: number): void;
  dragStart(event: ReactDragEvent, index: number): void;
  dragOver(event: ReactDragEvent, index: number): void;
  drop(event: ReactDragEvent, index: number): void;
  dragEnd(): void;
  remove(index: number): void;
}

const TrackRow = memo(function TrackRow({
  track, index, rowKey, isNow, hiddenHero, number, initial, played, reorderable, removable, playing,
  isSelected, selecting, starred, kept, unavailable, away, wide, drop, top, draggable,
  album, albumArtist, showAlbum, leadingCover, bookIndex, note, keptMarks, handlers,
}: {
  track: Track; index: number; rowKey: string; isNow: boolean; hiddenHero: boolean;
  number: number | string; initial?: string | null; played: boolean; reorderable: boolean; removable: boolean;
  playing: boolean; isSelected: boolean; selecting: boolean; starred: boolean;
  kept: boolean; unavailable: boolean; away: boolean; wide: boolean; drop: string | null; top: number | null; draggable: boolean;
  album?: string; albumArtist?: string; showAlbum: boolean; leadingCover: boolean; bookIndex: boolean;
  note: string | null; keptMarks: boolean;
  handlers: { current: RowHandlers };
}) {
  const name = splitTitle(track.title, album);
  const credit = track.artist !== albumArtist ? track.artist : null;
  const recordName = track.album ? splitTitle(track.album).main : '';
  const classes = [isNow && 'now', hiddenHero && 'hidden-hero', played && 'played', isSelected && 'selected', unavailable && 'unavailable', drop].filter(Boolean).join(' ');
  const isLatinInitial = initial ? /^[A-Z#]$/.test(initial) : true;
  return <li data-key={rowKey} data-index={index} className={classes || undefined}
    aria-current={isNow ? 'true' : undefined}
    style={top !== null ? { position: 'absolute', top, left: 0, right: 0 } : undefined}
    draggable={draggable} onContextMenu={event => handlers.current.menu(event, index)} onClick={event => handlers.current.rowTap(event, index, isNow)}
    onDragStart={event => handlers.current.dragStart(event, index)} onDragOver={event => handlers.current.dragOver(event, index)}
    onDrop={event => handlers.current.drop(event, index)} onDragEnd={() => handlers.current.dragEnd()}>
    {wide && reorderable && <GripVertical className="queue-grip" aria-hidden="true" />}
    <span className="track">
      <span className="n">
        <span className="n-mark">
          {isNow ? <Wave playing={playing} />
            : initial !== undefined ? (initial ? <span className={`tracks-initial${isLatinInitial ? '' : ' tracks-initial-other'}`}>{initial}</span> : '')
            : number}
        </span>
        {reorderable && !wide && <GripVertical className="grip" aria-hidden="true" />}
      </span>
      {leadingCover && <Cover id={track.coverArt} name={track.album || track.title} size={96} className="song-sleeve" />}
      <span className="title">
        <span className="song-line">
          <button type="button" className="track-play" onClick={event => handlers.current.click(event, index, isNow)}
            aria-label={isNow ? `${playing ? 'Pause' : 'Resume'} ${track.title}` : `Play ${track.title}`} aria-pressed={selecting ? isSelected : undefined}
            aria-description={unavailable ? 'Not kept on this device' : undefined}>
            <span className="name">{name.main}</span>{name.extra && <span className="extra">{name.extra}</span>}
          </button>
          <span className="song-lead" aria-hidden="true" />
        </span>
        {bookIndex ? (recordName || credit) && <span className="tracks-under">
          {recordName && <span className="tracks-from">{track.albumId && !isStation(track)
            ? <button type="button" className="link" data-warm={`album:${track.albumId}`} onClick={() => nav.go({ view: 'album', id: track.albumId! })}>{recordName}</button>
            : recordName}</span>}
          {credit && <span className="credit tracks-by"><Credits text={credit} artistId={track.artistId} artists={track.artists} /></span>}
        </span>
          : leadingCover ? recordName && <span className="credit">{track.albumId && !isStation(track)
            ? <button type="button" className="link" data-warm={`album:${track.albumId}`} onClick={() => nav.go({ view: 'album', id: track.albumId! })}>{recordName}</button>
            : recordName}</span>
          : (credit || (showAlbum && recordName)) && <span className="song-sub">
            {credit && <span className="credit"><Credits text={credit} artistId={track.artistId} artists={track.artists} /></span>}
            {showAlbum && recordName && <span className="album">{track.albumId && !isStation(track)
              ? <button type="button" className="link" data-warm={`album:${track.albumId}`} onClick={() => nav.go({ view: 'album', id: track.albumId! })}>{recordName}</button>
              : recordName}</span>}
          </span>}
      </span>
    </span>
    <span className="song-meta">
      {wide && track.source === 'navidrome' && !away && <RowRating track={track} />}
      {isStation(track) || away ? null : <button type="button" className={`star${starred ? ' on' : ''}`} aria-pressed={starred}
        aria-label={starred ? `Remove ${track.title} from favorites` : `Add ${track.title} to favorites`}
        onClick={() => void setStarred('track', [track.id], !starred)}><Glyph kind={starred ? 'hearted' : 'heart'} /></button>}
      {note && <span className="song-note">{note}</span>}
      <span className="figure">{isStation(track) ? 'Live' : time(track.duration)}</span>
      {keptSupported && keptMarks && kept && <span className="kept-slot"><KeptMark /></span>}
    </span>
    {wide && removable && !isNow && <button type="button" className="row-remove" aria-label={`Remove ${track.title}`} title="Remove"
      onClick={event => { event.stopPropagation(); handlers.current.remove(index); }}><X aria-hidden="true" /></button>}
    {bookIndex && wide && <span className="tracks-sleeve">
      {track.albumId && !isStation(track)
        ? <button type="button" className="tracks-sleeve-btn" tabIndex={-1} aria-hidden="true" data-warm={`album:${track.albumId}`}
            onClick={() => nav.go({ view: 'album', id: track.albumId! })}>
            <Cover id={track.coverArt} name={track.album || track.title} size={96} className="tracks-art" />
          </button>
        : <Cover id={track.coverArt} name={track.album || track.title} size={96} className="tracks-art" />}
    </span>}
  </li>;
});
