import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';
import type { Album, AlbumListType, Artist, Playlist, Result, Track, TrackSort } from '../../../../../packages/core/contracts';
import type { ArtistInfo, DiscTitle, Genre } from '../../../../../packages/core/contracts';
import type { RadioStation } from '../../../../../packages/core/contracts';
import { stationTrack } from '../../../../../packages/core/stations';
import { api, load, onInvalidate, onLibraryReset, playlistEditor, useLibraryEpoch, usePlaylist, useResource, type PlaylistView } from './library';
import { buildMixes, libraryDecades, mixById, mixTracks, type Mix } from './mixes';
import { current, player, playRequests, usePlayer } from './player';
import { isStarred, setStarred, useFavoritesVersion } from './favorites';
import { createPlaylist, openMenu, playTarget, tracksOf } from './menu';
import { showNowPlaying } from './nowPlaying';
import { Credits } from './credits';
import { activeDrag, canDrag, carriesItems, dropOnPlaylist, dropOnQueue, refuseDrop, startDrag, useDropTarget, useSpringOpen } from './drag';
import { morph, nav, useRoute } from './route';
import { updateSettings, useSettings, useSettingsError } from './settings';
import { Lyrics } from './lyrics';
import { TrackTable, type TrackGroup } from './TrackTable';
import { Cover, Glyph, kHz, length, plural, shuffled, splitTitle, Status, Wave } from './ui';
import { KeySettings } from './commands/KeySettings';
import { ExtensionsSettings } from './extensions';
import { ExtensionSections } from './extensions';
import { ThemeSettings } from './theme/ThemeSettings';
import { RatingMarks } from './ratings';
import { invalidate, peek } from './library';
import { time } from './ui';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { SearchOptions, SearchResults } from '../../../../../packages/core/contracts';
import { clearSearches, dropFocusRequest, focusWaiting, onFocusFirstResult, rememberSearch, useRecentSearches } from './searches';
import { exportM3u } from './exports';
import { SharesSettings } from './share';

// Tag the touched sleeve so it travels to the page it opens (see transition() in route.ts).
const travel = (id: string, target: EventTarget) => {
  morph.id = id;
  document.querySelectorAll('.morph').forEach(element => element.classList.remove('morph'));
  (target as HTMLElement).querySelector('.cover')?.classList.add('morph');
};
function Pending<T>({ result, children, waiting }: { result: Result<T> | undefined; children(value: T): ReactNode; waiting: string }) {
  if (!result) return <p className="status loading">{waiting}</p>;
  if (!result.ok) return <Status>{result.error}</Status>;
  return <>{children(result.value)}</>;
}

// `onDeck`: this record is the one playing, so the deck already shows its sleeve and the page's
// cover folds away (desktop only; a phone's deck is a strip).
function Head({ title, qualifier, cover, onDeck = false, children }: { title: string; qualifier?: string; cover?: ReactNode; onDeck?: boolean; children?: ReactNode }) {
  return <header className={`head${cover ? ' with-cover' : ''}${onDeck ? ' on-deck' : ''}`}>
    {cover}
    <div className="head-text">
      <h1 className={title.length > 28 ? 'long' : undefined}>{title}</h1>
      {qualifier && <p className="qualifier">{qualifier}</p>}
      {children}
    </div>
  </header>;
}
function Actions({ tracks, children }: { tracks: Track[] | null; children?: ReactNode }) {
  return <div className="actions">
    <button type="button" className="play-action" disabled={!tracks?.length} onClick={() => tracks && void player.play(tracks, 0).then(showNowPlaying)}>
      <span className="disc"><Glyph kind="play" /></span>Play
    </button>
    <button type="button" className="text-button" disabled={!tracks?.length} onClick={() => tracks && void player.play(shuffled(tracks), 0).then(showNowPlaying)}>Shuffle</button>
    {children}
  </div>;
}

// Long lists ---------------------------------------------------------------------------
// Records and Artists can run to thousands of entries. They render only the rows near the
// visible part of the page, with padding standing in for the rest, so the page's size in
// memory stays flat however large the library is.

// The rows [first, last) of a list whose row tops are `offsets` (one more entry than rows,
// the last being the total height) that fall within a screen or so of the viewport.
function useVisibleRows(list: RefObject<HTMLElement | null>, offsets: number[]): [number, number] {
  const rows = offsets.length - 1;
  const [range, setRange] = useState<[number, number]>([0, Math.min(rows, 12)]);
  useLayoutEffect(() => {
    const scroller = nav.scroller, element = list.current;
    if (!scroller || !element) return;
    const update = () => {
      const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const from = -top - scroller.clientHeight, to = -top + scroller.clientHeight * 2;
      let first = 0, high = rows;
      while (first < high) { const mid = (first + high) >> 1; if (offsets[mid + 1] <= from) first = mid + 1; else high = mid; }
      let last = first;
      while (last < rows && offsets[last] < to) last++;
      setRange(r => r[0] === first && r[1] === last ? r : [first, last]);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    addEventListener('resize', update);
    return () => { scroller.removeEventListener('scroll', update); removeEventListener('resize', update); };
  }, [offsets]);
  return [Math.min(range[0], rows), Math.min(range[1], rows)];
}

// Records and Songs load a page at a time as the list nears its end. The pages loaded outlive
// the page itself, so coming Back renders the same entries at once and the scroll offset has
// somewhere to land. `request` names a page for the library cache and fetches it.
interface Paged<T> { items: T[]; count: number; done: boolean; busy: boolean; error: string | null; seed: number; keys: string[] }
const paged = new Map<string, Paged<{ id: string }>>();
const dropped = new Set<() => void>();
// A page can land after the list that asked for it was left and shown again (a search tab
// switched away from and back), so every list showing it redraws, not only the one that asked.
const landed = new Set<(list: string) => void>();
onLibraryReset(() => paged.clear());
// A list with a page the library has since invalidated is read again from the top: at once if
// it's on screen, otherwise when it's next shown. A new rating drops Top rated this way.
onInvalidate(prefix => {
  let any = false;
  for (const [list, p] of paged) if (p.keys.some(key => key.startsWith(prefix))) { paged.delete(list); any = true; }
  if (any) dropped.forEach(listener => listener());
});
// Genres can number thousands, so only the few genre lists visited last are kept, the others
// dropped oldest first. Records and Tracks keep theirs.
// Searches' tabs are bounded the same way.
const GENRE_LISTS = 8;
function touchPaged(list: string) {
  const kind = ['genre:', 'search:'].find(prefix => list.startsWith(prefix));
  if (!kind) return;
  const p = paged.get(list);
  if (p) { paged.delete(list); paged.set(list, p); }
  const genres = [...paged.keys()].filter(key => key.startsWith(kind));
  for (const key of genres.slice(0, Math.max(0, genres.length - GENRE_LISTS))) paged.delete(key);
}
type PageRequest<T> = (offset: number, seed: number) => [key: string, fetch: () => Promise<Result<T[]>>];
function usePaged<T extends { id: string }>(list: string, size: number, request: PageRequest<T>, once = false) {
  const session = useLibraryEpoch();
  const [, redraw] = useState(0);
  const more = useCallback(() => {
    let p = paged.get(list) as Paged<T> | undefined;
    if (!p) { p = { items: [], count: 0, done: false, busy: false, error: null, seed: Math.random(), keys: [] }; paged.set(list, p); touchPaged(list); }
    if (p.busy || p.done) return;
    const page = p;
    page.busy = true; page.error = null;
    const [key, loader] = request(page.count, page.seed);
    page.keys.push(key);
    void load(key, loader).then(result => {
      page.busy = false;
      if (paged.get(list) !== page) return;
      if (!result.ok) page.error = result.error;
      else {
        page.count += result.value.length;
        const seen = new Set(page.items.map(item => item.id));
        page.items = [...page.items, ...result.value.filter(item => !seen.has(item.id))];
        if (result.value.length < size || once) page.done = true;
      }
      landed.forEach(listener => listener(list));
    });
    redraw(v => v + 1);
  }, [list]);
  useEffect(() => { touchPaged(list); const p = paged.get(list); if (!p || (!p.items.length && !p.done && !p.busy)) more(); }, [more, session]);
  useEffect(() => { const listener = () => { if (!paged.has(list)) more(); }; dropped.add(listener); return () => { dropped.delete(listener); }; }, [more]);
  useEffect(() => { const listener = (changed: string) => { if (changed === list) redraw(v => v + 1); }; landed.add(listener); return () => { landed.delete(listener); }; }, [list]);
  const p = paged.get(list) as Paged<T> | undefined;
  return { items: p?.items ?? none as T[], done: p?.done ?? false, error: p?.error ?? null, more };
}
const none: never[] = [];
// Asks for more once the end of the list comes within a screen or so.
function useMore(more: () => void, count: number) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => { if (entries[0].isIntersecting) more(); }, { root: nav.scroller, rootMargin: '600px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [more, count]);
  return sentinel;
}

// Records and Tracks sort the same ways. The sort is part of the route, replaced in place, so
// Back returns to the same order and leaves the list rather than stepping through sorts.
const sorts: { type: TrackSort; label: string }[] = [
  { type: 'newest', label: 'Newest' }, { type: 'alphabeticalByName', label: 'A to Z' }, { type: 'alphabeticalByArtist', label: 'By artist' },
  { type: 'frequent', label: 'Most played' }, { type: 'recent', label: 'Recently played' }, { type: 'random', label: 'Random' },
  { type: 'highest', label: 'Top rated' },
];
function Sorts({ list, type, children }: { list: 'records' | 'tracks'; type: AlbumListType; children?: ReactNode }) {
  return <div className="choices" role="group" aria-label={`Sort ${list}`}>
    {sorts.map(sort => <button key={sort.type} type="button" aria-pressed={sort.type === type} onClick={() => {
      // Choosing Random again is asking for a new draw.
      if (sort.type === 'random' && type !== 'random') paged.delete(`${list}:random`);
      // Ratings change as you listen, so Top rated is read again each time it's chosen.
      if (sort.type === 'highest' && type !== 'highest') paged.delete(`${list}:highest`);
      nav.go(list === 'records' ? { view: 'records', sort: sort.type } : { view: 'tracks', sort: sort.type }, true);
    }}>{sort.label}</button>)}
    {children}
  </div>;
}

// Records ------------------------------------------------------------------------------

const PAGE = 60;

export function Records() {
  const route = useRoute();
  // A decade, when chosen, lists that decade's records by year; the sort waits in the route for "All".
  const decade = route.view === 'records' ? decadeOf(route.decade) : null;
  const sort = route.view === 'records' && route.sort ? route.sort : 'newest';
  const type = decade !== null ? 'byYear' : sort;
  const list = decade !== null ? `byYear:${decade}` : type;
  const albums = usePaged<Album>(`records:${list}`, PAGE, (offset, seed) =>
    [`albums:${list}:${offset}:${PAGE}${type === 'random' ? `:${seed}` : ''}`, () => decade !== null
      ? api.albums(type, offset, PAGE, { fromYear: decade, toYear: decade + 9 }) : api.albums(type, offset, PAGE)], type === 'random');
  const sentinel = useMore(albums.more, albums.items.length);
  return <>
    <Head title="Records"><Sorts list="records" type={type}><Decades sort={route.view === 'records' ? route.sort : undefined} decade={decade} /></Sorts></Head>
    {albums.items.length ? <AlbumGrid albums={albums.items} /> : albums.done
      ? <Status>{decade !== null ? `No records from the ${decade}s.`
        : type === 'frequent' || type === 'recent' ? 'Nothing played yet. Records you listen to will collect here.'
        : type === 'highest' ? 'Nothing rated yet. Records you rate will collect here, best first.' : 'No records on this server yet.'}</Status>
      : albums.error ? <Status>{albums.error}</Status> : <p className="status loading">Opening your records</p>}
    {albums.error && albums.items.length > 0 && <Status>{albums.error}</Status>}
    <div ref={sentinel} className="sentinel" />
  </>;
}

// Grids past this size render only the rows near the viewport.
const WINDOWED = 48;
// The last measured grid shape, so a remounted grid starts at the right height.
let lastGrid: { columns: number; stride: number } | null = null;
export function AlbumGrid({ albums }: { albums: Album[] }) {
  const nowAlbum = usePlayer(s => current(s)?.albumId);
  const playing = usePlayer(s => s.playing);
  const list = useRef<HTMLUListElement>(null);
  const windowed = albums.length > WINDOWED;
  const [shape, setShape] = useState(() => windowed ? lastGrid : null);
  // The CSS grid decides the columns from the page width; read them back rather than
  // duplicating the breakpoints here.
  useLayoutEffect(() => {
    const element = list.current;
    if (!windowed || !element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const item = element.querySelector('li');
      if (!item) return;
      const columns = Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length);
      const stride = item.getBoundingClientRect().height + (parseFloat(style.rowGap) || 0);
      setShape(s => s && s.columns === columns && Math.abs(s.stride - stride) < .5 ? s : (lastGrid = { columns, stride }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [windowed]);
  const active = windowed ? shape : null;
  const rows = active ? Math.ceil(albums.length / active.columns) : 0;
  const offsets = useMemo(() => active ? Array.from({ length: rows + 1 }, (_, i) => i * active.stride) : [0], [active, rows]);
  const [first, last] = useVisibleRows(list, offsets);
  const shown = active ? albums.slice(first * active.columns, last * active.columns) : windowed ? albums.slice(0, WINDOWED) : albums;
  const drags = canDrag();
  return <ul ref={list} className="grid" style={active ? { paddingTop: first * active.stride, paddingBottom: (rows - last) * active.stride } : undefined}>
    {shown.map(album => <li key={album.id} className="playable">
      <PlayOver label={splitTitle(album.name).main} play={() => playTarget({ kind: 'album', album })} />
      <button type="button" onClick={event => { travel(album.id, event.currentTarget); nav.go({ view: 'album', id: album.id }); }}
        onContextMenu={event => openMenu(event, { kind: 'album', album })}
        draggable={drags} onDragStart={event => startDrag(event, { kind: 'album', album })}>
        <Cover id={album.coverArt} name={album.name} size={300} className={album.id === morph.id ? 'morph' : undefined} />
        <span className="grid-name">{album.id === nowAlbum && <Wave playing={playing} />}<span>{splitTitle(album.name).main}</span></span>
        <span className="grid-sub">{album.artist}</span>
      </button>
    </li>)}
  </ul>;
}

// One click to play a record, playlist, or artist without opening it. It shows over the cover
// (beside an artist's name) on hover or keyboard focus; the rest of the card still opens the page.
function PlayOver({ label, play, small = false }: { label: string; play(): Promise<void>; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  return <button type="button" className={`play-over${small ? ' small' : ''}`} aria-label={`Play ${label}`} disabled={busy}
    onClick={async () => { setBusy(true); try { await play(); } finally { setBusy(false); } }}>
    <span className="disc"><Glyph kind="play" /></span>
  </button>;
}

// Album --------------------------------------------------------------------------------

export function AlbumPage({ id }: { id: string }) {
  const result = useResource(`album:${id}`, () => api.album(id));
  const playingHere = usePlayer(s => current(s)?.albumId === id);
  return <Pending result={result} waiting="Reading the tracklist">{({ album, tracks, discTitles }) => {
    const title = splitTitle(album.name);
    const facts = [album.year, album.genre, plural(tracks.length, 'song'), length(tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0))].filter(Boolean).join(', ');
    return <>
      <Head title={title.main} qualifier={title.extra} onDeck={playingHere} cover={<Cover id={album.coverArt} name={album.name} size={600} className="head-cover" />}>
        <p className="byline"><Credits text={album.artist} artistId={album.artistId} artists={album.artists} strong /> <span>{facts}</span><RatingMarks id={album.id} rating={album.userRating} /></p>
        <Actions tracks={tracks}>
          <button type="button" className="text-button" onClick={() => player.radio({ kind: 'album', id: album.id, label: title.main })}>Radio</button>
          <StarButton target="album" id={album.id} starred={album.starred} name={album.name} />
          <MoreButton target={{ kind: 'album', album }} />
        </Actions>
      </Head>
      <TrackTable tracks={tracks} album={album.name} albumArtist={album.artist} numbered="track" groups={discGroups(tracks, discTitles)} />
    </>;
  }}</Pending>;
}

function StarButton({ target, id, starred, name }: { target: 'album' | 'artist'; id: string; starred: boolean; name: string }) {
  useFavoritesVersion();
  const on = isStarred(id, starred);
  return <button type="button" className={`text-button star-text${on ? ' on' : ''}`} aria-pressed={on} onClick={() => void setStarred(target, [id], !on)}>
    <Glyph kind={on ? 'starred' : 'star'} />{on ? 'In favorites' : 'Add to favorites'}<span className="sr-only"> {name}</span></button>;
}
// A playlist file of these songs (exports.ts). Errors show under the page's heading.
function ExportButton({ name, tracks }: { name: string; tracks: Track[] }) {
  const [error, setError] = useState<string | null>(null);
  return <>
    <button type="button" className="text-button" disabled={!tracks.length} onClick={async () => { setError(await exportM3u(name, tracks)); }}>Export as M3U</button>
    {error && <p className="note" role="alert">{error}</p>}
  </>;
}
// The same menu as right-click, for people who don't right-click (and for touch).
function MoreButton({ target }: { target: Parameters<typeof openMenu>[1] }) {
  return <button type="button" className="text-button" aria-haspopup="menu" onClick={event => {
    const box = event.currentTarget.getBoundingClientRect();
    openMenu({ clientX: box.left, clientY: box.bottom + 6, preventDefault: () => {}, target: event.currentTarget }, target);
  }}>More</button>;
}

// Artists ------------------------------------------------------------------------------

export function Artists() {
  const result = useResource('artists', () => api.artists());
  return <>
    <Head title="Artists" />
    <Pending result={result} waiting="Gathering artists">{artists => <ArtistIndex artists={artists} />}</Pending>
  </>;
}

// Artists under their initials, as rows: a letter, then its names a few to a row. Row heights
// come from CSS (--letter-row, --name-row) so the list can place any row without measuring it.
type ArtistRow = { kind: 'letter'; letter: string } | { kind: 'names'; letter: string; artists: Artist[] };
let lastArtistShape: { columns: number; letter: number; name: number } | null = null;
function ArtistIndex({ artists }: { artists: Artist[] }) {
  const groups = useMemo(() => {
    const byLetter = new Map<string, Artist[]>();
    for (const artist of artists) {
      const letter = /^[a-z]/i.test(artist.name) ? artist.name[0].toUpperCase() : '#';
      let group = byLetter.get(letter);
      if (!group) byLetter.set(letter, group = []);
      group.push(artist);
    }
    return [...byLetter].sort(([a], [b]) => a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b));
  }, [artists]);
  const list = useRef<HTMLDivElement>(null);
  const [shape, setShape] = useState(lastArtistShape);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const read = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
      const gap = read('--name-gap'), min = read('--name-min') || 220;
      // A stylesheet can fix the column count (phones use one); otherwise fit as many as the width allows.
      const next = { columns: read('--name-columns') || Math.max(1, Math.floor((element.clientWidth + gap) / (min + gap))), letter: read('--letter-row') || 64, name: read('--name-row') || 34 };
      setShape(s => s && s.columns === next.columns && s.letter === next.letter && s.name === next.name ? s : (lastArtistShape = next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { rows, offsets, starts } = useMemo(() => {
    const rows: ArtistRow[] = [], offsets = [0], starts = new Map<string, number>();
    if (!shape) return { rows, offsets, starts };
    for (const [letter, names] of groups) {
      starts.set(letter, offsets[offsets.length - 1]);
      rows.push({ kind: 'letter', letter }); offsets.push(offsets[offsets.length - 1] + shape.letter);
      for (let i = 0; i < names.length; i += shape.columns) {
        rows.push({ kind: 'names', letter, artists: names.slice(i, i + shape.columns) }); offsets.push(offsets[offsets.length - 1] + shape.name);
      }
    }
    return { rows, offsets, starts };
  }, [groups, shape]);
  const [first, last] = useVisibleRows(list, offsets);
  const total = offsets[offsets.length - 1];
  const drags = canDrag();
  const jump = (letter: string) => {
    const scroller = nav.scroller, element = list.current, at = starts.get(letter);
    if (!scroller || !element || at === undefined) return;
    scroller.scrollTo({ top: scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + at });
  };
  return <>
    <nav className="index" aria-label="Jump to letter">
      {groups.map(([letter]) => <a key={letter} href={`#letter-${letter}`} onClick={event => { event.preventDefault(); jump(letter); }}>{letter}</a>)}
    </nav>
    <div ref={list} className="artist-list" style={shape ? { paddingTop: offsets[first], paddingBottom: total - offsets[last] } : undefined}>
      {rows.slice(first, last).map((row, i) => row.kind === 'letter'
        ? <h2 key={`letter-${row.letter}`} className="letter-row" id={`letter-${row.letter}`}>{row.letter}</h2>
        : <ul key={`${row.letter}-${first + i}`} className="name-row" aria-label={row.letter}
          style={{ gridTemplateColumns: `repeat(${shape!.columns}, minmax(0, 1fr))` }}>
          {row.artists.map(artist => <li key={artist.id} className="playable">
            <button type="button" onClick={() => nav.go({ view: 'artist', id: artist.id })}
              onContextMenu={event => openMenu(event, { kind: 'artist', artist })}
              draggable={drags} onDragStart={event => startDrag(event, { kind: 'artist', artist })}>
              <span className="artist-name">{artist.name}</span> <span>{artist.albumCount}</span>
            </button>
            <PlayOver small label={artist.name} play={() => playTarget({ kind: 'artist', artist })} />
          </li>)}
        </ul>)}
    </div>
  </>;
}

export function ArtistPage({ id }: { id: string }) {
  const result = useResource(`artist:${id}`, () => api.artist(id));
  const top = useResource(`top:${id}`, () => api.topSongs(id, 10));
  const info = useResource(`artistInfo:${id}`, () => api.artistInfo(id));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Every record is loaded first; if any fails, nothing plays and the reason is shown.
  const playAll = async (artist: Pick<Artist, 'id' | 'name'>, shuffle: boolean) => {
    setProblem(null); setBusy(true);
    const tracks = await tracksOf({ kind: 'artist', artist });
    setBusy(false);
    if (!tracks.ok) { setProblem(tracks.error); return; }
    if (!tracks.value.length) { setProblem(`There are no songs by ${artist.name} on this server.`); return; }
    await player.play(shuffle ? shuffled(tracks.value) : tracks.value, 0);
    showNowPlaying();
  };
  return <Pending result={result} waiting="Finding their records">{({ artist, albums }) => <>
    <Head title={artist.name}>
      <p className="byline"><span>{plural(albums.length, 'record')}</span><RatingMarks id={artist.id} rating={artist.userRating} /></p>
      <div className="actions">
        <button type="button" className="play-action" disabled={busy} onClick={() => void playAll(artist, false)}>
          <span className="disc"><Glyph kind="play" /></span>Play
        </button>
        <button type="button" className="text-button" disabled={busy} onClick={() => void playAll(artist, true)}>Shuffle</button>
        <button type="button" className="text-button" onClick={() => player.radio({ kind: 'artist', id: artist.id, label: artist.name })}>Radio</button>
        <StarButton target="artist" id={artist.id} starred={artist.starred} name={artist.name} />
        <MoreButton target={{ kind: 'artist', artist }} />
      </div>
      {problem && <p className="note" role="alert">{problem}</p>}
    </Head>
    {info?.ok && info.value.biography && <Biography text={info.value.biography} />}
    {top?.ok && top.value.length > 0 && <section className="shelf-section"><h2>Popular</h2><TrackTable tracks={top.value} showAlbum /></section>}
    <section className="shelf-section"><h2>Records</h2><AlbumGrid albums={albums} /></section>
    {info?.ok && info.value.similar.length > 0 && <SimilarArtists artists={info.value.similar} />}
  </>}</Pending>;
}

// Tracks -------------------------------------------------------------------------------
// Every track, sorted as records are. Only Navidrome's own API sorts tracks: other servers list
// them in one fixed order, and the sorts are hidden. A row plays like any song list: the tracks
// loaded so far become the queue (as much as it holds around the one clicked).

const TRACKS = 200;
// Whether the server sorts tracks, once a page has said, so the sorts don't blink on each visit.
let tracksSorted: boolean | null = null;
onLibraryReset(() => { tracksSorted = null; });

export function Tracks() {
  const route = useRoute();
  const sort = route.view === 'tracks' && route.sort ? route.sort : 'newest';
  const tracks = usePaged<Track>(`tracks:${sort}`, TRACKS, (offset, seed) => [
    `tracks:${sort}:${offset}:${TRACKS}${sort === 'random' ? `:${seed}` : ''}`,
    () => api.tracks(sort, offset, TRACKS, sort === 'random' ? String(seed) : '').then((result): Result<Track[]> => {
      if (!result.ok) return result;
      tracksSorted = result.value.sorted;
      return { ok: true, value: result.value.tracks };
    }),
  ]);
  const sentinel = useMore(tracks.more, tracks.items.length);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Shuffle draws from the whole library, not just the tracks loaded so far.
  const shuffle = async () => {
    setProblem(null); setBusy(true);
    const asked = playRequests();
    const drawn = await api.randomSongs({ size: 500 });
    setBusy(false);
    // Something else started playing while the songs were on their way; that stays.
    if (playRequests() !== asked) return;
    if (!drawn.ok) { setProblem(drawn.error); return; }
    if (drawn.value.length) { await player.play(drawn.value, 0); showNowPlaying(); }
  };
  const played = tracksSorted && (sort === 'frequent' || sort === 'recent');
  return <>
    <Head title="Tracks">
      {tracksSorted && <Sorts list="tracks" type={sort} />}
      <div className="actions">
        <button type="button" className="play-action" disabled={!tracks.items.length} onClick={() => void player.play(tracks.items, 0).then(showNowPlaying)}>
          <span className="disc"><Glyph kind="play" /></span>Play
        </button>
        <button type="button" className="text-button" disabled={busy || !tracks.items.length} onClick={() => void shuffle()}>Shuffle</button>
      </div>
      {problem && <p className="note" role="alert">{problem}</p>}
    </Head>
    {tracks.items.length ? <TrackTable tracks={tracks.items} showAlbum /> : tracks.done
      ? <Status>{played ? 'Nothing played yet. Tracks you listen to will collect here.'
        : tracksSorted && sort === 'highest' ? 'Nothing rated yet. Songs you rate will collect here, best first.' : 'No tracks on this server yet.'}</Status>
      : tracks.error ? <Status>{tracks.error}</Status> : <p className="status loading">Gathering tracks</p>}
    {tracks.error && tracks.items.length > 0 && <Status>{tracks.error}</Status>}
    <div ref={sentinel} className="sentinel" />
  </>;
}

// Playlists ----------------------------------------------------------------------------

function playlistNote(playlist: Playlist) {
  if (playlist.comment?.startsWith('Auto-imported')) return 'Kept in sync with a playlist file on the server.';
  if (playlist.readonly) return 'Managed by the server.';
  return null;
}

const PLAYLIST_MIXES = 8;
export function Playlists() {
  const playlists = useResource('playlists', () => api.playlists());
  const genres = useResource('genres', () => api.genres());
  const decades = useResource('decades', libraryDecades);
  const history = useResource('albums:frequent:0:1', () => api.albums('frequent', 0, 1));
  const mixes = useMemo(() => buildMixes(genres?.ok ? genres.value : [], decades?.ok ? decades.value : [], !!(history?.ok && history.value.length)),
    [genres, decades, history]);
  return <>
    <Head title="Playlists" />
    <section className="shelf-section" aria-labelledby="yours">
      <div className="section-head"><h2 id="yours">Yours</h2><NewPlaylist /></div>
      <Pending result={playlists} waiting="Loading playlists">{list => list.length ? <ul className="rows">
        {list.map(playlist => <PlaylistRow key={playlist.id} playlist={playlist} />)}
      </ul> : <Status>No playlists yet. Start one here, or save an automatic playlist below.</Status>}</Pending>
    </section>
    <section className="shelf-section" aria-labelledby="automatic">
      <div className="section-head"><h2 id="automatic">Automatic</h2><SeeAll what="mixes" go={() => nav.go({ view: 'mixes' })} /></div>
      <p className="section-note">Drawn from your library each session. Save one to keep it as it is.</p>
      <ul className="rows">
        {/* The first few; the Mixes page has them all. */}
        {mixes.slice(0, PLAYLIST_MIXES).map(mix =><li key={mix.id} className="playable">
          <PlayOver label={mix.name} play={async () => {
            const drawn = await mixTracks(mix);
            if (drawn.ok && drawn.value.length) { await player.play(drawn.value, 0); showNowPlaying(); }
          }} />
          <button type="button" onClick={event => { travel(mix.id, event.currentTarget); nav.go({ view: 'mix', id: mix.id }); }}>
            <MixTile mix={mix} travels={mix.id === morph.id} />
            <span className="row-text"><span className="row-name">{mix.name}</span><span className="row-sub">{mix.description}</span></span>
          </button>
        </li>)}
      </ul>
    </section>
    <Stations />
    <ExtensionSections />
  </>;
}

// A playlist on the Playlists page. It drags (its songs), and records, artists, songs, and other
// playlists drop onto it to be added at the end; held over it, a drag opens it, to be dropped
// between its songs. One the server manages refuses, saying why.
function PlaylistRow({ playlist }: { playlist: Playlist }) {
  const note = playlistNote(playlist);
  // Not onto itself.
  const notItself = () => { const drag = activeDrag(); return !(drag?.payload.kind === 'playlist' && drag.payload.ids.includes(playlist.id)); };
  const { over, handlers } = useDropTarget(payload => void dropOnPlaylist(playlist, payload, note), { enabled: !playlist.readonly, accepts: notItself });
  const spring = useSpringOpen(() => nav.go({ view: 'playlist', id: playlist.id }), () => !playlist.readonly && notItself());
  // The server's own playlists refuse: no outline, a pointer that says no, and the reason.
  const refuse = (event: DragEvent<HTMLElement>) => { if (playlist.readonly && carriesItems(event.dataTransfer)) refuseDrop(playlist, note); };
  return <li className={`playable${over ? ' drop-over' : ''}`} {...handlers}
    onDragEnter={event => { handlers.onDragEnter(event); spring.onDragEnter(event); refuse(event); }}
    onDragLeave={event => { handlers.onDragLeave(event); spring.onDragLeave(event); }}
    onDrop={event => { handlers.onDrop(event); refuse(event); }}>
    <PlayOver label={splitTitle(playlist.name).main} play={() => playTarget({ kind: 'playlist', playlist })} />
    <button type="button" onClick={event => { travel(playlist.id, event.currentTarget); nav.go({ view: 'playlist', id: playlist.id }); }}
      onContextMenu={event => openMenu(event, { kind: 'playlist', playlist })}
      draggable={canDrag()} onDragStart={event => startDrag(event, { kind: 'playlist', playlist })}>
      <Cover id={playlist.coverArt} name={playlist.name} size={160} className={playlist.id === morph.id ? 'morph' : undefined} />
      <span className="row-text">
        <span className="row-name">{splitTitle(playlist.name).main}</span>
        <span className="row-sub">{plural(playlist.songCount, 'song')}, {length(playlist.duration)}{note && `. ${note}`}</span>
      </span>
    </button>
  </li>;
}

function NewPlaylist() {
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!naming) return <button type="button" className="text-button" onClick={() => setNaming(true)}>New playlist</button>;
  return <form className="inline-form" onSubmit={async event => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    if (!name) return;
    setError(await createPlaylist(name, []));
  }}>
    <input name="name" autoFocus placeholder="Name the playlist" aria-label="New playlist name" onKeyDown={event => { if (event.key === 'Escape') setNaming(false); }} />
    <button type="submit" className="text-button">Create</button>
    <button type="button" className="text-button quiet" onClick={() => setNaming(false)}>Cancel</button>
    {error && <span className="note" role="alert">{error}</span>}
  </form>;
}

// An automatic playlist shows the sleeves it drew. The draw is loaded when the tile scrolls into view
// and kept for the session, so the tile always matches what the page will play.
function MixTile({ mix, tracks, large = false, travels = false }: { mix: Mix; tracks?: Track[] | null; large?: boolean; travels?: boolean }) {
  const [drawn, setDrawn] = useState<Track[] | null>(null);
  const tile = useRef<HTMLDivElement>(null);
  const session = useLibraryEpoch();
  useEffect(() => {
    if (tracks !== undefined || !tile.current) return;
    let live = true;
    const observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return;
      observer.disconnect();
      void mixTracks(mix).then(result => { if (live && result.ok) setDrawn(result.value); });
    }, { root: nav.scroller, rootMargin: '200px' });
    observer.observe(tile.current);
    return () => { live = false; observer.disconnect(); };
  }, [mix.id, tracks, session]);
  const list = tracks ?? drawn ?? [];
  const covers = [...new Map(list.filter(t => t.coverArt).map(t => [t.albumId ?? t.coverArt, t.coverArt!])).values()].slice(0, 4);
  const classes = `cover mix-tile${large ? ' head-cover' : ''}${travels ? ' morph' : ''}`;
  if (covers.length < 4) return <div ref={tile} className={`${classes} cover-type`} aria-hidden="true"><span>{mix.name}</span></div>;
  return <div ref={tile} className={`${classes} mosaic`} aria-hidden="true">
    {covers.map(id => <img key={id} src={api.coverUrl(id, large ? 300 : 80)} alt="" loading="lazy" decoding="async" />)}
  </div>;
}

export function PlaylistPage({ id }: { id: string }) {
  const view = usePlaylist(id);
  if (view.deleted) return <Status>This playlist has been deleted.</Status>;
  if (!view.playlist) return view.loadError ? <Status>{view.loadError}</Status> : <p className="status loading">Opening the playlist</p>;
  return <PlaylistEditor view={view} playlist={view.playlist} />;
}

// Edits show at once and are saved one at a time, in order (see PlaylistEditor in library.ts).
// A refused edit disappears and its reason is shown; later edits still apply.
function PlaylistEditor({ view, playlist }: { view: PlaylistView; playlist: Playlist }) {
  const editor = playlistEditor(playlist.id);
  const { tracks } = view;
  const [renaming, setRenaming] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const editable = !playlist.readonly;
  const stopRenaming = () => { setRenaming(false); requestAnimationFrame(() => renameButton.current?.focus()); };
  // Records, artists, and songs dropped on the page join the end; onto the list, before that song.
  const drop = useDropTarget(payload => void dropOnPlaylist(playlist, payload, null), { enabled: editable });
  return <div className={`drop-area${drop.over ? ' drop-over' : ''}`} {...drop.handlers}>
    <Head title={playlist.name} cover={<Cover id={playlist.coverArt} name={playlist.name} size={600} className="head-cover" />}>
      {renaming && <form className="inline-form" onSubmit={event => {
        event.preventDefault();
        const value = String(new FormData(event.currentTarget).get('name') ?? '').trim();
        stopRenaming();
        if (value && value !== playlist.name) void editor.rename(value);
      }}>
        <input name="name" defaultValue={playlist.name} autoFocus aria-label="Playlist name" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); stopRenaming(); } }} />
        <button type="submit" className="text-button">Save</button>
        <button type="button" className="text-button quiet" onClick={stopRenaming}>Cancel</button>
      </form>}
      <p className="byline"><span>{plural(tracks.length, 'song')}, {length(!view.saving && tracks.length === playlist.songCount
        // The server's total, as on the Playlists page; a running sum only while edits are pending.
        ? playlist.duration : tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0))}{view.saving && '. Saving changes'}</span></p>
      {(playlist.comment && !playlist.comment.startsWith('Auto-imported')) && <p className="note">{playlist.comment}</p>}
      {playlistNote(playlist) && <p className="note">{playlistNote(playlist)}</p>}
      <Actions tracks={tracks}>
        {editable && !renaming && <button ref={renameButton} type="button" className="text-button" onClick={() => setRenaming(true)}>Rename</button>}
        <MoreButton target={{ kind: 'playlist', playlist }} />
        <ExportButton name={playlist.name} tracks={tracks} />
      </Actions>
      {editable && tracks.length > 1 && <p className="note hint">Drag songs to reorder, or press Alt+Up and Alt+Down. Select with Ctrl or Shift and press Delete to remove.</p>}
      {view.error && <p className="note" role="alert">{view.error}</p>}
    </Head>
    {tracks.length ? <TrackTable tracks={tracks} showAlbum playlist={playlist}
      onMove={editable ? (from, to) => void editor.move(from, to) : undefined}
      onRemove={editable ? indexes => void editor.removeAt(indexes) : undefined}
      onDropItems={editable ? (payload, at) => void dropOnPlaylist(playlist, payload, null, at) : undefined} />
      : <Status>This playlist is empty. Right-click any song and choose Add to playlist.</Status>}
  </div>;
}

export function MixPage({ id }: { id: string }) {
  const mix = mixById(id);
  const [draw, setDraw] = useState(0);
  const [result, setResult] = useState<Result<Track[]>>();
  const [saved, setSaved] = useState<string | null>(null);
  const session = useLibraryEpoch();
  useEffect(() => {
    if (!mix) return;
    let live = true;
    setResult(undefined); setSaved(null);
    void mixTracks(mix, draw > 0).then(r => { if (live) setResult(r); });
    return () => { live = false; };
  }, [id, draw, session]);
  if (!mix) return <Status>This automatic playlist no longer exists.</Status>;
  const tracks = result?.ok ? result.value : null;
  return <>
    <Head title={mix.name} cover={<MixTile mix={mix} tracks={result ? tracks : null} large />}>
      <p className="byline"><span>{mix.description}</span></p>
      <Actions tracks={tracks}>
        {mix.id !== 'recent' && <button type="button" className="text-button" onClick={() => setDraw(d => d + 1)}>Draw again</button>}
        <button type="button" className="text-button" disabled={!tracks?.length} onClick={async () => {
          const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
          setSaved(await createPlaylist(`${mix.name}, ${date}`, tracks!.map(t => t.id)));
        }}>Save as playlist</button>
      </Actions>
      {saved && <p className="note">{saved}</p>}
    </Head>
    <Pending result={result} waiting="Choosing songs">{list => list.length
      ? <TrackTable tracks={list} showAlbum />
      : <Status>Nothing in your library fits this one yet.</Status>}</Pending>
  </>;
}

// Favorites, search, queue --------------------------------------------------------------

export function Favorites() {
  const result = useResource('starred', () => api.starred());
  return <>
    <Head title="Favorites" />
    <Pending result={result} waiting="Collecting favorites">{({ tracks, albums, artists }) => !tracks.length && !albums.length && !artists.length
      ? <Status>Nothing here yet. Use the star beside a song, record, or artist to keep it here.</Status>
      : <>
        {tracks.length > 0 && <section className="shelf-section"><h2>Songs</h2><Actions tracks={tracks} /><TrackTable tracks={tracks} showAlbum /></section>}
        {albums.length > 0 && <section className="shelf-section"><h2>Records</h2><AlbumGrid albums={albums} /></section>}
        {artists.length > 0 && <section className="shelf-section"><h2>Artists</h2><ArtistNames artists={artists} /></section>}
      </>}</Pending>
  </>;
}

function ArtistNames({ artists }: { artists: Artist[] }) {
  const drags = canDrag();
  return <ul className="names">{artists.map(artist => <li key={artist.id} className="playable">
    <button type="button" onClick={() => nav.go({ view: 'artist', id: artist.id })}
      draggable={drags} onDragStart={event => startDrag(event, { kind: 'artist', artist })}>{artist.name} <span>{artist.albumCount}</span></button>
    <PlayOver small label={artist.name} play={() => playTarget({ kind: 'artist', artist })} />
  </li>)}</ul>;
}

export function Queue() {
  const queue = usePlayer(s => s.queue);
  const index = usePlayer(s => s.index);
  const radio = usePlayer(s => s.radio);
  const repeat = usePlayer(s => s.repeat);
  const shuffle = usePlayer(s => s.shuffle);
  const [saved, setSaved] = useState<string | null>(null);
  // Records, artists, songs, and playlists dropped on the page join the end of the queue; onto
  // the list, before that song.
  const drop = useDropTarget(payload => void dropOnQueue(payload));
  const area = `drop-area${drop.over ? ' drop-over' : ''}`;
  if (!queue.length) return <div className={area} {...drop.handlers}><Head title="Queue" /><Status>Nothing queued. Play a record, playlist, or song, or right-click one and choose Add to queue.</Status></div>;
  const upcoming = queue.length - index - 1;
  const repeats = repeat === 'all' ? 'the queue repeats' : repeat === 'one' ? 'this song repeats' : null;
  const modes = shuffle ? (repeats ? `Shuffled, and ${repeats}.` : 'Shuffled.') : repeats && `${repeats[0].toUpperCase()}${repeats.slice(1)}.`;
  return <div className={area} {...drop.handlers}>
    <Head title="Queue">
      <p className="byline"><span>{upcoming > 0 ? `${plural(upcoming, 'song')} up next, ${length(queue.slice(index + 1).reduce((sum, t) => sum + (t.duration ?? 0), 0))}` : 'This is the last song.'}</span>
        {modes && <>{upcoming > 0 ? '. ' : ' '}<span>{modes}</span></>}</p>
      {radio && <p className="note">Radio from {radio.label}. Songs like these are added as you listen. <button type="button" className="link" onClick={player.stopRadio}>Stop radio</button></p>}
      <div className="actions">
        <button type="button" className="text-button" disabled={upcoming < 1} onClick={() => void player.clear()}>Clear up next</button>
        <button type="button" className="text-button" onClick={async () => {
          const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
          setSaved(await createPlaylist(`Queue, ${date}`, queue.filter(t => t.source === 'navidrome').map(t => t.id)));
        }}>Save as playlist</button>
      </div>
      {saved && <p className="note" role="alert">{saved}</p>}
      <p className="note hint">Drag to reorder, or press Alt+Up and Alt+Down. Select with Ctrl or Shift and press Delete to remove.</p>
    </Head>
    <TrackTable tracks={queue} showAlbum queue onPick={(i, entry) => player.jump(i, entry)} onMove={(from, to) => void player.move(from, to)} onRemove={indexes => void player.remove(indexes)}
      onDropItems={(payload, at) => void dropOnQueue(payload, at)} />
  </div>;
}

export function LyricsPage() {
  return <Lyrics />;
}

export function SettingsView() {
  const settings = useSettings();
  const error = useSettingsError();
  const mode = usePlayer(s => s.mode);
  const devices = usePlayer(s => s.devices);
  const row = (key: Exclude<keyof typeof settings, 'outputDevice' | 'checkForUpdates'>, title: string, detail: string) => <label className="setting">
    <input type="checkbox" checked={settings[key]} onChange={event => void updateSettings({ [key]: event.target.checked })} />
    <span><strong>{title}</strong><span>{detail}</span></span>
  </label>;
  return <>
    <Head title="Settings" />
    <section className="settings">
      <h2>Lyrics</h2>
      {row('lyricsLookup', 'Look up missing lyrics on LRCLIB', 'Lyrics in your files always come first. For songs without them, the song\'s title, artist, and album are sent to lrclib.net.')}
      <h2>Your server</h2>
      {row('reportPlays', 'Report what you play', 'Navidrome counts plays, which fills Most played, Recently played, and the history-based automatic playlists.')}
      {row('syncQueue', 'Keep the queue in sync', 'The queue and position are saved on your server, so you can pick up on another device.')}
      <Disconnect />
      {mode === 'web' && <SignOut />}
      {mode === 'desktop' && <>
        <h2>Sound</h2>
        <label className="setting choice">
          <span><strong>Output</strong><span>Where Squiggly plays. If this device isn't connected when Squiggly starts, it uses the system default.</span></span>
          <select value={settings.outputDevice} onChange={event => void updateSettings({ outputDevice: event.target.value })}>
            {!devices.some(d => d.name === settings.outputDevice) && <option value={settings.outputDevice}>{settings.outputDevice === 'auto' ? 'System default' : `${settings.outputDevice} (not connected)`}</option>}
            {devices.map(d => <option key={d.name} value={d.name}>{d.name === 'auto' ? 'System default' : d.description}</option>)}
          </select>
        </label>
        {row('exclusiveOutput', 'Exclusive output', 'Ask the output device for exclusive use so the system mixer does not resample or mix. Other apps go quiet while Squiggly plays. Windows supports this; many Linux setups ignore it.')}
        <UpdateSettings />
        <h2>Window</h2>
        {row('closeToTray', 'Keep playing when the window closes', 'Closing the window leaves Squiggly in the tray. Quit from the tray menu.')}
        {row('miniOnTop', 'Keep the mini player on top', 'The mini player stays above other windows.')}
      </>}
      {error && <p className="note" role="alert">{error}</p>}
      <ThemeSettings />
      <KeySettings />
      {mode === 'desktop' && <ExtensionsSettings />}
      <SharesSettings />
    </section>
  </>;
}

// Updates from GitHub releases (apps/desktop/main/updates.ts). Development builds have none.
function UpdateSettings() {
  const update = usePlayer(s => s.update);
  const settings = useSettings();
  if (!update || update.mode === 'off') return null;
  const bridge = window.squiggly!.updates;
  const status = {
    idle: `This is Squiggly ${update.current}.`,
    checking: 'Checking for updates.',
    'up-to-date': `Squiggly ${update.current} is the latest version.`,
    available: `Squiggly ${update.version} is out. You have ${update.current}.`,
    downloading: `Downloading Squiggly ${update.version}${update.percent !== null ? `, ${update.percent}%` : ''}.`,
    ready: `Squiggly ${update.version} is ready. It installs when you restart or quit.`,
    error: update.error ?? 'Couldn\'t check for updates.',
  }[update.status];
  return <>
    <h2>Updates</h2>
    <label className="setting">
      <input type="checkbox" checked={settings.checkForUpdates} onChange={event => void updateSettings({ checkForUpdates: event.target.checked })} />
      <span><strong>Check for updates</strong><span>{update.mode === 'install'
        ? 'Asks GitHub for new releases at launch and every six hours, and downloads them in the background. Nothing else about you is sent.'
        : 'Asks GitHub for new releases at launch and every six hours. This copy can\'t update itself, so you download new versions from the release page. Nothing else about you is sent.'}</span></span>
    </label>
    <div className="setting-action">
      <p><span role="status">{status}</span></p>
      {update.status === 'ready' && <button type="button" className="text-button" onClick={() => void bridge.install()}>Restart to update</button>}
      {update.status === 'available' && <button type="button" className="text-button" onClick={() => void bridge.open()}>Open the release page</button>}
      {!['checking', 'downloading', 'ready'].includes(update.status) && <button type="button" className="text-button" onClick={() => void bridge.check()}>Check now</button>}
    </div>
  </>;
}

// The browser build: the page's own sign-in, when the host asks for a password. Without one the
// page is open to whoever can reach it, and there is nothing here to sign out of.
function SignOut() {
  const access = usePlayer(s => s.access);
  const serverName = usePlayer(s => s.serverName);
  const pageConnection = usePlayer(s => s.pageConnection);
  const [busy, setBusy] = useState(false);
  if (access !== 'signed-in' && access !== 'open') return null;
  // Disconnect above covers a server this page connected to itself.
  if (access === 'open' && pageConnection) return null;
  return <div className="setting-action">
    <p><strong>Sign out</strong>
      <span>{access === 'signed-in'
        ? `This page is signed in with its own password; the ${serverName ?? 'server'} account stays with the host. Signing out asks for the page's password again.`
        : `This page has no password of its own: whoever can open it uses the host's ${serverName ?? 'server'} account. There is nothing to sign out of here.`}</span></p>
    {access === 'signed-in' && <button type="button" className="text-button" disabled={busy} onClick={async () => { setBusy(true); await player.signOut(); setBusy(false); }}>
      {busy ? 'Signing out' : 'Sign out'}</button>}
  </div>;
}
// The desktop's main process, the Android bridge, or (in the browser) the host forgets the
// server and stops playback, and the app returns to the connect screen. In the browser only a
// server the page connected to itself can be dropped; the host's configured one stays, and the
// page can open the connect screen over it instead.
function Disconnect() {
  const serverName = usePlayer(s => s.serverName);
  const connected = usePlayer(s => s.connected);
  const web = usePlayer(s => s.mode === 'web');
  const pageConnection = usePlayer(s => s.pageConnection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!connected) return null;
  // The host's configured server isn't the page's to drop, but the page can use another instead.
  if (web && !pageConnection) return <div className="setting-action">
    <p><strong>Connect to another server</strong>
      <span>This page uses the host's own server, {serverName ?? 'your server'}. You can connect it to another Navidrome server instead. That stops playback and empties the queue; the host keeps its own server for other browsers, and this page goes back to it when you disconnect.</span></p>
    <button type="button" className="text-button" onClick={() => player.chooseServer(true)}>Connect to another server</button>
  </div>;
  return <div className="setting-action">
    <p><strong>Disconnect or switch server</strong>
      <span>Connected to {serverName ?? 'your server'}. Disconnecting stops playback, empties the queue, and goes back to the connect screen, where you can connect to this server or another. {web
        ? 'The host that serves this page forgets the password too, so have it ready.'
        : 'It also forgets the saved sign-in, so have your password ready.'}</span></p>
    <button type="button" className="text-button" disabled={busy} onClick={async () => {
      setBusy(true); setError(null);
      const result = await (web ? player : (window.squiggly ?? window.squigglyAndroid!.session)).disconnect();
      setBusy(false);
      if (!result.ok) setError(result.error);
    }}>{busy ? 'Disconnecting' : 'Disconnect'}</button>
    {error && <p className="note" role="alert">{error}</p>}
  </div>;
}

export function DiagnosticsView() {
  const diagnostics = usePlayer(s => s.diagnostics);
  const mode = usePlayer(s => s.mode);
  const audio = usePlayer(s => s.audio);
  const [message, setMessage] = useState<string | null>(null);
  if (mode === 'web') return <><Head title="Diagnostics" /><Status>Process and memory figures come from the desktop app. The browser version has none to show.</Status></>;
  if (mode === 'android') return <><Head title="Diagnostics" /><Status>Process and memory figures come from the desktop app. Android shows them in Settings › Apps › Squiggly.</Status></>;
  return <>
    <Head title="Diagnostics">
      <p className="byline"><span>Running {length(diagnostics.uptimeSeconds)}{diagnostics.startupMs !== null && `, started in ${Math.round(diagnostics.startupMs)} ms`}</span></p>
      <div className="actions"><button type="button" className="text-button" onClick={async () => {
        const result = await window.squiggly!.exportDiagnostics(); setMessage(result.ok ? 'Report saved.' : result.error);
      }}>Save a report</button></div>
      {message && <p className="note">{message}</p>}
    </Head>
    <table className="facts"><tbody>
      {diagnostics.processes.map(p => <tr key={p.name}><th>{p.name}</th><td>{p.memoryMB.toFixed(0)} MB</td><td>{p.cpuPercent.toFixed(1)}% CPU</td></tr>)}
      <tr><th>Total memory</th><td>{diagnostics.processes.reduce((sum, p) => sum + p.memoryMB, 0).toFixed(0)} MB</td><td /></tr>
      <tr><th>Main thread delay</th><td>{diagnostics.eventLoopDelayMs.toFixed(1)} ms</td><td /></tr>
      <tr><th>Audio host messages</th><td>{diagnostics.playerMessagesPerSecond.toFixed(1)} per second</td><td /></tr>
      {/* What mpv decoded into and handed to the system. The system mixer's final format isn't reported. */}
      {audio?.decoderFormat && <tr><th>Decoded</th><td>{[audio.decoderFormat, kHz(audio.decoderRate)].filter(Boolean).join(' · ')}</td><td /></tr>}
      {audio?.outputBackend && <tr><th>Handed to</th><td>{[audio.outputBackend, kHz(audio.outputRate), audio.outputFormat].filter(Boolean).join(' · ')}</td><td /></tr>}
    </tbody></table>
  </>;
}

// Artist bios and similar artists ---------------------------------------------------------
// What the server's agents (Last.fm, Spotify) know. Nothing shows when they know nothing.

// The first few sentences, and the rest behind More. The text is plain (client.ts strips the
// server's HTML), and it is rendered as text.
const BIO_SENTENCES = 3, BIO_LENGTH = 420;
function bioSummary(text: string): string {
  const sentences = text.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)\s*/g) ?? [text];
  let summary = '';
  for (const sentence of sentences.slice(0, BIO_SENTENCES)) {
    if (summary && summary.length + sentence.length > BIO_LENGTH) break;
    summary += sentence;
  }
  summary = summary.trim();
  // One long sentence: cut at a word.
  if (summary.length > BIO_LENGTH) summary = `${summary.slice(0, BIO_LENGTH).replace(/\s+\S*$/, '')}…`;
  return summary;
}
function Biography({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => bioSummary(text), [text]);
  const more = summary !== text;
  return <section className="bio" aria-label="About">
    <p>{open || !more ? text : summary}{more && <>
      {' '}<button type="button" className="link" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Less' : 'More'}</button>
    </>}</p>
  </section>;
}
function SimilarArtists({ artists }: { artists: ArtistInfo['similar'] }) {
  return <section className="shelf-section" aria-labelledby="similar-artists">
    <h2 id="similar-artists">Similar artists</h2>
    <ul className="similar">{artists.map(artist => <li key={artist.id}>
      <button type="button" className="link" onClick={() => nav.go({ view: 'artist', id: artist.id })}>{artist.name}</button>
    </li>)}</ul>
  </section>;
}

// Discs --------------------------------------------------------------------------------------
// A record on more than one disc gets a heading per disc: its title where the files name one,
// else its number. A record on one disc, or with songs whose disc is unknown, stays one list.
function discGroups(tracks: Track[], titles: DiscTitle[] = []): TrackGroup[] | undefined {
  const discs = tracks.map(track => track.discNumber ?? null);
  if (discs.some(disc => disc === null) || new Set(discs).size < 2) return undefined;
  const named = new Map(titles.map(item => [item.disc, item.title]));
  return discs.flatMap((disc, i) => i > 0 && discs[i - 1] === disc ? [] : [{ at: i, label: named.get(disc!) ?? `Disc ${disc}` }]);
}

// Decades on Records ---------------------------------------------------------------------------
// The decades the automatic playlists found (mixes.ts), shared with the Playlists page. They are
// asked for only once Decade is opened (a handful of small requests), not on every visit to
// Records. Choosing one replaces the place, as a sort does, so Back returns with the filter on.
const decadeOf = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9990 && value % 10 === 0 ? value : null;
function Decades({ sort, decade }: { sort: AlbumListType | undefined; decade: number | null }) {
  const [open, setOpen] = useState(decade !== null);
  const shown = open || decade !== null;
  const found = useResource(shown ? 'decades' : null, libraryDecades);
  const known = found?.ok ? found.value : [];
  const decades = decade !== null && !known.includes(decade) ? [...known, decade].sort((a, b) => b - a) : known;
  const choose = (chosen: number | null) => nav.go({ view: 'records', ...(sort ? { sort } : {}), ...(chosen !== null ? { decade: chosen } : {}) }, true);
  return <>
    <button type="button" className={`decade-toggle${decade !== null ? ' on' : ''}`} aria-expanded={shown}
      onClick={() => { if (decade !== null) choose(null); setOpen(!shown); }}>Decade</button>
    {shown && <div className="decades" role="group" aria-label="Decade">
      {!found ? <span className="status-inline">Finding the decades in your library</span>
        : !found.ok ? <span className="status-inline">{found.error}</span>
        : !decades.length ? <span className="status-inline">No decade has enough songs yet.</span>
        : <>
          <button type="button" aria-pressed={decade === null} onClick={() => choose(null)}>All</button>
          {decades.map(value => <button key={value} type="button" aria-pressed={decade === value} onClick={() => choose(value)}>{value}s</button>)}
        </>}
    </div>}
  </>;
}

// Genres ---------------------------------------------------------------------------------------

const bySongs = (a: Genre, b: Genre) => b.songCount - a.songCount || a.name.localeCompare(b.name);
export function Genres() {
  const result = useResource('genres', () => api.genres());
  return <>
    <Head title="Genres" />
    <Pending result={result} waiting="Gathering genres">{genres => genres.length ? <GenreList genres={genres} />
      : <Status>No genres yet. Genres come from the tags in your files.</Status>}</Pending>
  </>;
}
// A library can hold thousands of genres (every tag its files use), so only the rows near the
// viewport are rendered, as on Artists. The grid's own columns and its first row's height give
// the rows their size; until they're measured, the first few genres stand in.
function GenreList({ genres }: { genres: Genre[] }) {
  const sorted = useMemo(() => [...genres].sort(bySongs), [genres]);
  const list = useRef<HTMLUListElement>(null);
  const [shape, setShape] = useState<{ columns: number; row: number } | null>(null);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const measure = () => {
      const item = element.firstElementChild;
      if (!item) return;
      const style = getComputedStyle(element);
      const next = { columns: Math.max(1, style.gridTemplateColumns.split(' ').length), row: item.getBoundingClientRect().height + (parseFloat(style.rowGap) || 0) };
      setShape(s => s && s.columns === next.columns && s.row === next.row ? s : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const offsets = useMemo(() => shape ? Array.from({ length: Math.ceil(sorted.length / shape.columns) + 1 }, (_, i) => i * shape.row) : [0], [sorted.length, shape]);
  const [first, last] = useVisibleRows(list, offsets);
  const shown = shape ? sorted.slice(first * shape.columns, last * shape.columns) : sorted.slice(0, 24);
  return <ul ref={list} className="rows genres" style={shape ? { paddingTop: offsets[first], paddingBottom: offsets[offsets.length - 1] - offsets[last] } : undefined}>
    {shown.map(genre => <li key={genre.name}>
      <button type="button" onClick={() => nav.go({ view: 'genre', name: genre.name })}>
        <span className="row-text">
          <span className="row-name">{genre.name}</span>
          <span className="row-sub">{plural(genre.songCount, 'song')}, {plural(genre.albumCount, 'record')}</span>
        </span>
      </button>
    </li>)}
  </ul>;
}

// One genre's songs, 200 at a time as the list nears its end, like Tracks.
const GENRE_PAGE = 200;
export function GenrePage({ name }: { name: string }) {
  const tracks = usePaged<Track>(`genre:${name}`, GENRE_PAGE, offset => [`genre:${name}:${offset}:${GENRE_PAGE}`, () => api.songsByGenre(name, offset, GENRE_PAGE)]);
  const sentinel = useMore(tracks.more, tracks.items.length);
  const genres = useResource('genres', () => api.genres());
  const genre = genres?.ok ? genres.value.find(g => g.name === name) : undefined;
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Shuffle draws from the whole genre, not just the songs loaded so far.
  const shuffle = async () => {
    setProblem(null); setBusy(true);
    const asked = playRequests();
    const drawn = await api.randomSongs({ size: 500, genre: name });
    setBusy(false);
    // Something else started playing while the songs were on their way; that stays.
    if (playRequests() !== asked) return;
    if (!drawn.ok) { setProblem(drawn.error); return; }
    if (drawn.value.length) { await player.play(drawn.value, 0); showNowPlaying(); }
  };
  return <>
    <Head title={name}>
      {genre && <p className="byline"><span>{plural(genre.songCount, 'song')}, {plural(genre.albumCount, 'record')}</span></p>}
      <div className="actions">
        <button type="button" className="play-action" disabled={!tracks.items.length} onClick={() => void player.play(tracks.items, 0).then(showNowPlaying)}>
          <span className="disc"><Glyph kind="play" /></span>Play
        </button>
        <button type="button" className="text-button" disabled={busy || !tracks.items.length} onClick={() => void shuffle()}>Shuffle</button>
      </div>
      {problem && <p className="note" role="alert">{problem}</p>}
    </Head>
    {tracks.items.length ? <TrackTable tracks={tracks.items} showAlbum /> : tracks.done
      ? <Status>No songs are tagged {name}.</Status>
      : tracks.error ? <Status>{tracks.error}</Status> : <p className="status loading">Gathering songs</p>}
    {tracks.error && tracks.items.length > 0 && <Status>{tracks.error}</Status>}
    <div ref={sentinel} className="sentinel" />
  </>;
}

// Home ---------------------------------------------------------------------------------------------
// Where the app opens. Each shelf loads on its own, so a slow answer holds up only the shelves
// that need it: Your mixes waits for Most played's list, which says whether there is history. A
// shelf stays hidden while it loads and when it has nothing to show. A shelf holds twelve at
// most, and a mix's tile draws its songs only once it scrolls into view, from the same cached
// draw the Playlists and Mixes pages use, so opening Home asks the server for little.
const SHELF = 12;
export function Home() {
  return <>
    <Head title="Home" />
    <PickUp />
    <RecordShelf type="recent" title="Played lately" />
    {/* Records carry no date added, so this is the newest twelve rather than a week's worth. */}
    <RecordShelf type="newest" title="Newest" />
    <RecordShelf type="frequent" title="Most played" />
    <HomeMixes />
    <Elsewhere />
  </>;
}

function SeeAll({ what, go }: { what: string; go(): void }) {
  return <button type="button" className="text-button" onClick={go}>See all<span className="sr-only"> {what}</span></button>;
}

// The queue saved on the server, the one the deck offers too. Gone once it plays, or once
// anything else does.
function PickUp() {
  const saved = usePlayer(s => s.queue.length ? null : s.resumable);
  const track = saved?.tracks[saved.currentIndex];
  if (!saved || !track) return null;
  return <section className="shelf-section" aria-labelledby="home-resume">
    <h2 id="home-resume">Pick up where you left off</h2>
    <div className="pick-up">
      <Cover id={track.coverArt} name={track.album} size={160} />
      <p className="row-text">
        <span className="row-name">{splitTitle(track.title, track.album).main}</span>
        <span className="row-sub">{track.artist}, at {time(saved.positionSeconds)}{saved.changedBy ? `, from ${saved.changedBy}` : ''}</span>
      </p>
      <button type="button" className="play-action" onClick={() => void player.resume()}><span className="disc"><Glyph kind="play" /></span>Resume</button>
    </div>
  </section>;
}

// A row of sleeves from one of the Records sorts. See all opens Records in that sort.
function RecordShelf({ type, title }: { type: 'recent' | 'newest' | 'frequent'; title: string }) {
  const result = useResource(`albums:${type}:0:${SHELF}`, () => api.albums(type, 0, SHELF));
  if (!result || (result.ok && !result.value.length)) return null;
  const id = `home-${type}`;
  return <section className="shelf-section home-shelf" aria-labelledby={id}>
    <div className="section-head">
      <h2 id={id}>{title}</h2>
      {result.ok && <SeeAll what={title.toLowerCase()} go={() => nav.go(type === 'newest' ? { view: 'records' } : { view: 'records', sort: type })} />}
    </div>
    {result.ok ? <AlbumGrid albums={result.value} /> : <Status>{result.error}</Status>}
  </section>;
}

// The automatic playlists, as the Playlists page lists them. The decades appear once something
// has found them (Records' Decade, the Playlists page, or Mixes): looking for them takes nine requests.
function HomeMixes() {
  const genres = useResource('genres', () => api.genres());
  // The same list as Most played, so it costs nothing more.
  const history = useResource(`albums:frequent:0:${SHELF}`, () => api.albums('frequent', 0, SHELF));
  // Wait for both, so the row doesn't reshuffle as they arrive.
  if (!genres || !history) return null;
  const decades = peek<number[]>('decades');
  const mixes = buildMixes(genres.ok ? genres.value : [], decades?.ok ? decades.value : [], history.ok && history.value.length > 0).slice(0, SHELF);
  return <section className="shelf-section home-shelf" aria-labelledby="home-mixes">
    <div className="section-head"><h2 id="home-mixes">Your mixes</h2><SeeAll what="mixes" go={() => nav.go({ view: 'mixes' })} /></div>
    <ul className="grid">
      {mixes.map(mix => <li key={mix.id} className="playable">
        <PlayOver label={mix.name} play={() => playMix(mix)} />
        <button type="button" onClick={event => { travel(mix.id, event.currentTarget); nav.go({ view: 'mix', id: mix.id }); }}>
          <MixTile mix={mix} travels={mix.id === morph.id} />
          <span className="grid-name"><span>{mix.name}</span></span>
          <span className="grid-sub">{mix.description}</span>
        </button>
      </li>)}
    </ul>
  </section>;
}

// Other accounts on this server and what they're playing. Read afresh on each visit.
function Elsewhere() {
  const result = useResource('nowPlaying', () => api.nowPlaying());
  useEffect(() => () => invalidate('nowPlaying'), []);
  if (!result?.ok || !result.value.length) return null;
  return <section className="shelf-section" aria-labelledby="home-elsewhere">
    <h2 id="home-elsewhere">Playing elsewhere</h2>
    <ul className="elsewhere">
      {result.value.slice(0, SHELF).map(({ username, track }) => <li key={`${username}/${track.id}`}>
        <span className="elsewhere-user">{username}</span>{' · '}
        {track.albumId ? <button type="button" className="link" onClick={() => nav.go({ view: 'album', id: track.albumId! })}>{splitTitle(track.title, track.album).main}</button>
          : splitTitle(track.title, track.album).main} by {track.artist}
      </li>)}
    </ul>
  </section>;
}

// Search -----------------------------------------------------------------------------------------
// All shows a few of each kind, as many as search3 gives by default (8 artists, 16 records, 40
// songs). A kind that came back full may have more, and offers "See all": its own tab, which
// lists that kind alone, a page at a time as the list nears its end. Subsonic doesn't say how
// many there are, so neither does the link. The tab is part of the route, replaced in place like
// a sort, so Back returns to it and leaves the search rather than stepping through tabs.
type SearchType = 'artists' | 'albums' | 'songs';
const searchTabs: { type: SearchType | undefined; label: string }[] = [
  { type: undefined, label: 'All' }, { type: 'artists', label: 'Artists' }, { type: 'albums', label: 'Records' }, { type: 'songs', label: 'Songs' },
];
const searchTypeOf = (value: unknown): SearchType | undefined => value === 'artists' || value === 'albums' || value === 'songs' ? value : undefined;
const showSearch = (query: string, type: SearchType | undefined) => nav.go({ view: 'search', query, ...(type ? { type } : {}) }, true);
// A tab's page: songs 100 at a time, records as Records pages them. The other kinds are skipped.
const SEARCH_PAGES: Record<SearchType, number> = { artists: 100, albums: PAGE, songs: 100 };
const skipped = { artistCount: 0, albumCount: 0, songCount: 0 };
const searchPage = (type: SearchType, offset: number, size: number): SearchOptions => type === 'artists' ? { ...skipped, artistCount: size, artistOffset: offset }
  : type === 'albums' ? { ...skipped, albumCount: size, albumOffset: offset } : { ...skipped, songCount: size, songOffset: offset };
// What Enter in the search field focuses: the first song, record, or artist, in page order.
const FIRST_RESULT = '.tracks .track, .grid li > button:not(.play-over), .names li > button:not(.play-over)';
// Long lists render only the rows near the viewport, so the first one on the page may not be the
// list's first: a song row knows its index, and a record grid pads the rows above the window.
const listStart = (result: HTMLElement) => {
  const item = result.closest('li'), list = item?.parentElement;
  if (!item || !list) return false;
  return item.dataset.index !== undefined ? item.dataset.index === '0' : !parseFloat(list.style.paddingTop || '0');
};

export function Search({ query, type }: { query: string; type?: SearchType }) {
  const text = query.trim();
  const kind = searchTypeOf(type);
  const results = useRef<HTMLDivElement>(null);
  // Enter in the field: focus the first result once it's there. A search that found nothing (or
  // failed) drops the request, so it can't pull focus out of the field later.
  useEffect(() => {
    const element = results.current;
    if (!element) return;
    const attempt = () => {
      if (!focusWaiting(text)) return;
      const first = element.querySelector<HTMLElement>(FIRST_RESULT);
      if (first && listStart(first)) { dropFocusRequest(); first.focus(); return; }
      // A long list scrolled down: back to the top, and focus once the first rows are drawn.
      if (first) { nav.scroller?.scrollTo(0, 0); return; }
      if (element.querySelector('.status:not(.loading)')) dropFocusRequest();
    };
    attempt();
    const stop = onFocusFirstResult(attempt);
    const observer = new MutationObserver(attempt);
    observer.observe(element, { childList: true, subtree: true });
    return () => { stop(); observer.disconnect(); };
  }, [text, kind]);
  // Opening or playing something a search found makes it one worth remembering.
  const used = (event: ReactMouseEvent) => { if ((event.target as Element).closest('button, a')) rememberSearch(text); };
  if (!text) return <>
    <Head title="Search" />
    <Status>Type an artist, record, or song.</Status>
    <RecentSearches type={kind} />
  </>;
  return <>
    <Head title={`“${text}”`}>
      <div className="choices" role="group" aria-label="Show">
        {searchTabs.map(tab => <button key={tab.label} type="button" aria-pressed={tab.type === kind} onClick={() => showSearch(query, tab.type)}>{tab.label}</button>)}
      </div>
    </Head>
    <div ref={results} className="search-results" onClickCapture={used} onContextMenuCapture={used}>
      {kind === 'songs' ? <SearchPages<Track> key={`songs:${text.toLowerCase()}`} query={text} type="songs" pick={found => found.tracks} none="No songs match">
        {tracks => <TrackTable tracks={tracks} showAlbum />}</SearchPages>
        : kind === 'albums' ? <SearchPages<Album> key={`albums:${text.toLowerCase()}`} query={text} type="albums" pick={found => found.albums} none="No records match">
          {albums => <AlbumGrid albums={albums} />}</SearchPages>
        : kind === 'artists' ? <SearchPages<Artist> key={`artists:${text.toLowerCase()}`} query={text} type="artists" pick={found => found.artists} none="No artists match">
          {artists => <ArtistNames artists={artists} />}</SearchPages>
        : <SearchAll query={text} />}
    </div>
  </>;
}

function SearchAll({ query }: { query: string }) {
  const result = useResource(`search:${query.toLowerCase()}`, () => api.search(query));
  return <Pending result={result} waiting="Searching">{({ artists, albums, tracks, capped }) => !artists.length && !albums.length && !tracks.length
    ? <Status>Nothing matches “{query}”. Check the spelling or try fewer words.</Status>
    : <>
      {tracks.length > 0 && <SearchGroup title="Songs" query={query} type="songs" more={capped.tracks}><TrackTable tracks={tracks} showAlbum /></SearchGroup>}
      {albums.length > 0 && <SearchGroup title="Records" query={query} type="albums" more={capped.albums}><AlbumGrid albums={albums} /></SearchGroup>}
      {artists.length > 0 && <SearchGroup title="Artists" query={query} type="artists" more={capped.artists}><ArtistNames artists={artists} /></SearchGroup>}
    </>}</Pending>;
}
function SearchGroup({ title, query, type, more, children }: { title: string; query: string; type: SearchType; more: boolean; children: ReactNode }) {
  return <section className="shelf-section">
    <div className="section-head">
      <h2>{title}</h2>
      {more && <button type="button" className="link see-all" onClick={() => showSearch(query, type)}>See all<span className="sr-only"> {title.toLowerCase()}</span></button>}
    </div>
    {children}
  </section>;
}
// One kind, a page at a time, as Tracks and Records load theirs.
function SearchPages<T extends { id: string }>({ query, type, pick, none, children }: {
  query: string; type: SearchType; pick(found: SearchResults): T[]; none: string; children(items: T[]): ReactNode;
}) {
  const size = SEARCH_PAGES[type], name = `${type}:${query.toLowerCase()}`;
  const pages = usePaged<T>(`search:${name}`, size, offset => [`searchPage:${name}:${offset}:${size}`,
    () => api.search(query, searchPage(type, offset, size)).then((result): Result<T[]> => result.ok ? { ok: true, value: pick(result.value) } : result)]);
  const sentinel = useMore(pages.more, pages.items.length);
  return <>
    {pages.items.length ? children(pages.items) : pages.done ? <Status>{none} “{query}”. Check the spelling, or look under All.</Status>
      : pages.error ? <Status>{pages.error}</Status> : <p className="status loading">Searching</p>}
    {pages.error && pages.items.length > 0 && <Status>{pages.error}</Status>}
    <div ref={sentinel} className="sentinel" />
  </>;
}

// Recent searches, under the empty field. Choosing one searches it again, on the tab last shown.
function RecentSearches({ type }: { type: SearchType | undefined }) {
  const recent = useRecentSearches();
  if (!recent.length) return null;
  return <section className="shelf-section" aria-labelledby="recent-searches">
    <div className="section-head">
      <h2 id="recent-searches">Recent searches</h2>
      <button type="button" className="text-button quiet" onClick={() => { clearSearches(); document.querySelector<HTMLInputElement>('.search')?.focus(); }}>
        Clear<span className="sr-only"> recent searches</span></button>
    </div>
    <ul className="similar recent-searches">{recent.map(query => <li key={query}>
      <button type="button" className="link" onClick={() => { rememberSearch(query); showSearch(query, type); }}>{query}</button>
    </li>)}</ul>
  </section>;
}

// Stations -----------------------------------------------------------------------------
// The server's internet radio stations, on the Playlists page below the automatic playlists.
// A station plays as a live stream: its stream address stays with the host, and the queue holds
// it like a song (stationTrack). The app opens no outside pages, so a station's home page shows
// as its host name, as text.

const homeHost = (url: string | null) => { if (!url) return null; try { return new URL(url).host.replace(/^www\./, ''); } catch { return null; } };
async function playStation(station: RadioStation) {
  await player.play([stationTrack(station)], 0);
  showNowPlaying();
}
function Stations() {
  const stations = useResource('radioStations', () => api.radioStations());
  return <section className="shelf-section" aria-labelledby="stations">
    <h2 id="stations">Stations</h2>
    <p className="section-note">Internet radio from your server. Stations play live, so there is nothing to skip through.</p>
    <Pending result={stations} waiting="Loading stations">{list => list.length ? <ul className="rows">
      {list.map(station => <li key={station.id} className="playable">
        <PlayOver label={station.name} play={() => playStation(station)} />
        <button type="button" onClick={() => void playStation(station)}
          onContextMenu={event => openMenu(event, { kind: 'tracks', tracks: [stationTrack(station)] })}>
          <Cover id={null} name={station.name} size={160} />
          <span className="row-text">
            <span className="row-name">{station.name}</span>
            <span className="row-sub">{homeHost(station.homePageUrl) ?? 'Live stream'}</span>
          </span>
        </button>
      </li>)}
    </ul> : <Status>Your server has no internet radio stations. Navidrome's administrators can add them.</Status>}</Pending>
  </section>;
}

// Mixes ------------------------------------------------------------------------------------------
// Every automatic playlist the library can build, grouped by what it draws from. The two every
// library has come first; the groups after them are hidden when they have nothing, and show the
// error when their lookup failed, since a failure says nothing about what's there. This is the
// page for the decades, so it looks for them (nine small requests, kept under the same key the
// Playlists page and Records' Decade use), and their group appears once they're found.
const historyMixes = new Set(['repeat', 'lately']);
export function Mixes() {
  const genres = useResource('genres', () => api.genres());
  const history = useResource('albums:frequent:0:1', () => api.albums('frequent', 0, 1));
  const decades = useResource('decades', libraryDecades);
  // Wait for the genres and the history, so the groups don't shift as they arrive. The decades
  // come last on the page, so they join whenever they're ready.
  if (!genres || !history) return <>
    <MixesHead />
    <p className="status loading">Gathering mixes</p>
  </>;
  const mixes = buildMixes(genres.ok ? genres.value : [], decades?.ok ? decades.value : [], history.ok && history.value.length > 0);
  const played = mixes.filter(mix => historyMixes.has(mix.id));
  const byGenre = mixes.filter(mix => mix.id.startsWith('genre:'));
  const byDecade = mixes.filter(mix => mix.id.startsWith('decade:'));
  const always = mixes.filter(mix => !played.includes(mix) && !byGenre.includes(mix) && !byDecade.includes(mix));
  return <>
    <MixesHead />
    <div className="shelf-section"><MixGrid mixes={always} /></div>
    {!history.ok ? <MixGroup id="mixes-played" title="From what you play"><Status>{history.error}</Status></MixGroup>
      : played.length > 0 && <MixGroup id="mixes-played" title="From what you play"><MixGrid mixes={played} /></MixGroup>}
    {!genres.ok ? <MixGroup id="mixes-genre" title="By genre"><Status>{genres.error}</Status></MixGroup>
      : byGenre.length > 0 && <MixGroup id="mixes-genre" title="By genre"><MixGrid mixes={byGenre} /></MixGroup>}
    {decades && !decades.ok ? <MixGroup id="mixes-decade" title="By decade"><Status>{decades.error}</Status></MixGroup>
      : byDecade.length > 0 && <MixGroup id="mixes-decade" title="By decade"><MixGrid mixes={byDecade} /></MixGroup>}
  </>;
}
function MixesHead() {
  return <Head title="Mixes"><p className="byline"><span>Playlists Squiggly builds from your library. They change as it does.</span></p></Head>;
}
function MixGroup({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section className="shelf-section" aria-labelledby={id}><h2 id={id}>{title}</h2>{children}</section>;
}
// Plays a tile's mix from its draw. If something else started playing while the draw was on its
// way, that stays, as with Tracks' Shuffle.
async function playMix(mix: Mix) {
  const asked = playRequests();
  const drawn = await mixTracks(mix);
  if (playRequests() !== asked) return;
  if (!drawn.ok) player.showError(drawn.error);
  else if (drawn.value.length) { await player.play(drawn.value, 0); showNowPlaying(); }
}
// Each tile plays from its button and opens its mix, as on the Playlists page.
function MixGrid({ mixes }: { mixes: Mix[] }) {
  return <ul className="grid">
    {mixes.map(mix => <li key={mix.id} className="playable">
      <PlayOver label={mix.name} play={() => playMix(mix)} />
      <button type="button" onClick={event => { travel(mix.id, event.currentTarget); nav.go({ view: 'mix', id: mix.id }); }}>
        <MixTile mix={mix} travels={mix.id === morph.id} />
        <span className="grid-name"><span>{mix.name}</span></span>
        <span className="grid-sub">{mix.description}</span>
      </button>
    </li>)}
  </ul>;
}
