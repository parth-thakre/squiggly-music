import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from 'react';
import type { Album, AlbumListType, Artist, Playlist, Result, Track, TrackSort } from '../../../../../packages/core/contracts';
import type { ArtistInfo, DiscTitle, Genre } from '../../../../../packages/core/contracts';
import type { RadioStation } from '../../../../../packages/core/contracts';
import { stationTrack } from '../../../../../packages/core/stations';
import { sinkSentence } from '../../../../../packages/core/sinks';
import { addedRuns } from '../../../../../packages/core/autoplay';
import { api, load, onInvalidate, onLibraryReset, playlistEditor, useKept, useLibraryEpoch, usePlaylist, useResource, type PlaylistView } from './library';
import { buildMixes, knownDecades, libraryDecades, mixById, mixTracks, type Mix } from './mixes';
import { current, outputDescription, player, playRequests, usePlayer } from './player';
import { isStarred, setStarred, useFavoritesVersion } from './favorites';
import { createPlaylist, openMenu, playTarget, tracksOf } from './menu';
import { showNowPlaying } from './nowPlaying';
import { Credits } from './credits';
import { activeDrag, canDrag, carriesItems, dropOnPlaylist, dropOnQueue, refuseDrop, startDrag, useDropTarget, useSpringOpen } from './drag';
import { FitTitle, formatBytes, formatTrackSpec, OrderMenu, splitSingers, SquiggleRule, type OrderOption } from './editorial';
import { morph, nav, useRoute } from './route';
import { diagnosticsBuilt, updateSettings, useSettings, useSettingsError } from './settings';
import { PLAY_COUNTS_AT, type PlayCountsAt } from '../../../../../packages/core/plays';
import { STREAM_QUALITIES, type StreamQuality } from '../../../../../packages/core/streamQuality';
import { Lyrics } from './lyrics';
import { TrackTable, type TrackGroup } from './TrackTable';
import { Cover, Glyph, kHz, length, plural, shuffled, splitTitle, Status, Wave } from './ui';
import { KeySettings } from './commands/KeySettings';
import { ExtensionsSettings } from './extensions';
import { ExtensionSections } from './extensions';
import { ThemeSettings } from './theme/ThemeSettings';
import { RatingStars } from './ratings';
import { invalidate } from './library';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { List, MoreHorizontal, Plus, Radio as RadioIcon, Shuffle as ShuffleIcon } from 'lucide-react';
import type { SearchOptions, SearchResults } from '../../../../../packages/core/contracts';
import { clearSearches, dropFocusRequest, focusWaiting, onFocusFirstResult, rememberSearch, useRecentSearches } from './searches';
import { exportM3u } from './exports';
import { SharesSettings } from './share';
import { ContainerMark, KeepButton, KeptSection, KeptSettings } from './kept';
import { keptSupported } from './keptState';
import { TOP_SONGS } from './warm';

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
function Head({ title, qualifier, cover, kind, onDeck = false, children }: { title: string; qualifier?: string; cover?: ReactNode; kind?: string; onDeck?: boolean; children?: ReactNode }) {
  return <header className={`head${cover ? ' with-cover' : ''}${kind ? ' feature' : ''}${onDeck ? ' on-deck' : ''}`}>
    {cover}
    <div className="head-text">
      {kind && <p className="kind">{kind}</p>}
      <h1 className={title.length > 28 ? 'long' : undefined}>{title}</h1>
      {qualifier && <p className="qualifier">{qualifier}</p>}
      {children}
    </div>
  </header>;
}
function Actions({ tracks, children }: { tracks: Track[] | null; children?: ReactNode }) {
  return <div className="actions">
    <button type="button" className="play-action" disabled={!tracks?.length} onClick={() => tracks && void player.play(tracks, 0).then(showNowPlaying)}>
      <span className="disc"><Glyph kind="play" /></span><span className="action-label">Play</span>
    </button>
    <button type="button" className="text-button icon-action" title="Shuffle" disabled={!tracks?.length} onClick={() => tracks && void player.play(shuffled(tracks), 0).then(showNowPlaying)}><ShuffleIcon aria-hidden="true" /><span className="action-label">Shuffle</span></button>
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
const sorts: readonly OrderOption<TrackSort>[] = [
  { value: 'newest', label: 'Newest', triggerLabel: 'newest first' },
  { value: 'alphabeticalByName', label: 'A to Z' },
  { value: 'alphabeticalByArtist', label: 'By artist', triggerLabel: 'by artist' },
  { value: 'frequent', label: 'Most played', triggerLabel: 'most played' },
  { value: 'recent', label: 'Recently played', triggerLabel: 'recently played' },
  { value: 'random', label: 'Random', triggerLabel: 'random' },
  { value: 'highest', label: 'Top rated', triggerLabel: 'top rated' },
];
const trackSorts: readonly OrderOption<TrackSort>[] = sorts.map(s => ({ value: s.value, label: s.label }));
function pickSort(list: 'records' | 'tracks', currentType: AlbumListType, next: TrackSort) {
  if (next === 'random' && currentType !== 'random') paged.delete(`${list}:random`);
  if (next === 'highest' && currentType !== 'highest') paged.delete(`${list}:highest`);
  nav.go(list === 'records' ? { view: 'records', sort: next } : { view: 'tracks', sort: next }, true);
}

// Records ------------------------------------------------------------------------------

const PAGE = 60;

export function Records() {
  const route = useRoute();
  const decade = route.view === 'records' ? decadeOf(route.decade) : null;
  const sort = route.view === 'records' && route.sort ? route.sort : 'newest';
  const type = decade !== null ? 'byYear' : sort;
  const list = decade !== null ? `byYear:${decade}` : type;
  const albums = usePaged<Album>(`records:${list}`, PAGE, (offset, seed) =>
    [`albums:${list}:${offset}:${PAGE}${type === 'random' ? `:${seed}` : ''}`, () => decade !== null
      ? api.albums(type, offset, PAGE, { fromYear: decade, toYear: decade + 9 }) : api.albums(type, offset, PAGE)], type === 'random');
  const sentinel = useMore(albums.more, albums.items.length);
  // Year dividers in the crate when browsing newest or a decade and albums carry years.
  const yearGroups = useMemo(() => {
    if (type !== 'newest' && type !== 'byYear') return null;
    if (!albums.items.some(a => a.year)) return null;
    const groups: { year: number | null; albums: Album[] }[] = [];
    for (const album of albums.items) {
      const y = album.year ?? null;
      const last = groups[groups.length - 1];
      if (!last || last.year !== y) groups.push({ year: y, albums: [album] });
      else last.albums.push(album);
    }
    // Only use year sections when records actually cluster into years (otherwise a flat shelf is cleaner).
    return groups.length < albums.items.length || type === 'byYear' ? groups : null;
  }, [albums.items, type]);
  return <div className="records-page">
    <p className="facts crate-line">
      {albums.items.length > 0 && <>{plural(albums.items.length, 'record')}{albums.done ? '' : '+'},{' '}</>}
      <OrderMenu value={sort} options={sorts} onSelect={next => pickSort('records', type, next)} ariaLabel="Order" className="crate-order-menu" />
      <Decades sort={route.view === 'records' ? route.sort : undefined} decade={decade} />
    </p>
    {albums.items.length ? (yearGroups ? <div className="crate">
      {yearGroups.map((group, idx) => <section key={`${group.year ?? 'undated'}-${idx}`} className="crate-year" aria-label={group.year ? String(group.year) : 'Undated'}>
        {group.year && <h2 className="crate-year-name">{group.year}</h2>}
        <AlbumGrid albums={group.albums} cols={5} />
      </section>)}
    </div> : <AlbumGrid albums={albums.items} cols={5} />) : albums.done
      ? <Status>{decade !== null ? `No records from the ${decade}s.`
        : type === 'frequent' || type === 'recent' ? 'Nothing played yet.'
        : type === 'highest' ? 'Nothing rated yet.' : 'No records on this server yet.'}</Status>
      : albums.error ? <Status>{albums.error}</Status> : <p className="status loading">Opening your records</p>}
    {albums.error && albums.items.length > 0 && <Status>{albums.error}</Status>}
    <div ref={sentinel} className="sentinel" />
  </div>;
}

// Grids past this size render only the rows near the viewport.
const WINDOWED = 48;
let lastGrid: { columns: number; stride: number } | null = null;
export function AlbumGrid({ albums, cols, sub = 'artist', wideSingle = false }: {
  albums: Album[]; cols?: number; sub?: 'artist' | 'year'; wideSingle?: boolean;
}) {
  const nowAlbum = usePlayer(s => current(s)?.albumId);
  const playing = usePlayer(s => s.playing);
  const list = useRef<HTMLUListElement>(null);
  const windowed = albums.length > WINDOWED;
  const [shape, setShape] = useState(() => windowed ? lastGrid : null);
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
  const wide = wideSingle && albums.length === 1;
  const style: CSSProperties | undefined = {
    ...(cols ? { '--cols': cols } as CSSProperties : {}),
    ...(active ? { paddingTop: first * active.stride, paddingBottom: (rows - last) * active.stride } : {}),
  };
  return <ul ref={list} className={`grid${cols ? ' shelf-cols' : ''}${wide ? ' shelf-wide-one' : ''}`} style={Object.keys(style).length ? style : undefined}>
    {shown.map(album => {
      const title = splitTitle(album.name);
      return <li key={album.id} className={`playable${wide ? ' sleeve-wide' : ''}`}>
        <PlayOver label={title.main} play={() => playTarget({ kind: 'album', album })} />
        <button type="button" data-warm={`album:${album.id}`} onClick={event => { travel(album.id, event.currentTarget); nav.go({ view: 'album', id: album.id }); }}
          onContextMenu={event => openMenu(event, { kind: 'album', album })}
          draggable={drags} onDragStart={event => startDrag(event, { kind: 'album', album })}>
          <Cover id={album.coverArt} name={album.name} size={300} className={album.id === morph.id ? 'morph' : undefined} />
          <span className="sleeve-words">
            <span className="grid-name">{album.id === nowAlbum && <Wave playing={playing} />}<span>{title.main}</span></span>
            {title.extra && <span className="grid-tail">{title.extra}</span>}
            {sub === 'year' && album.year ? <span className="grid-sub grid-year">{album.year}</span> : null}
            {wide && <span className="grid-sub">{[sub === 'year' ? null : album.year, album.songCount ? plural(album.songCount, 'song') : null].filter(Boolean).join(', ')}</span>}
          </span>
          <ContainerMark kind="album" id={album.id} />
        </button>
        {sub === 'artist' && <span className="grid-sub"><Credits text={album.artist} artistId={album.artistId} artists={album.artists} /></span>}
      </li>;
    })}
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
  const result = useKept(`album:${id}`, from => from.album(id));
  const playingHere = usePlayer(s => current(s)?.albumId === id);
  return <Pending result={result} waiting="Reading the tracklist">{({ album, tracks, discTitles }) => {
    const title = splitTitle(album.name);
    const facts = [album.year, album.genre, plural(tracks.length, 'song'), length(tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0))].filter(Boolean).join(', ');
    return <div className="record-page">
      <header className={`head with-cover feature record-head${playingHere ? ' on-deck' : ''}`}>
        <Cover id={album.coverArt} name={album.name} size={600} className="head-cover record-sleeve" />
        <div className="head-text record-title">
          <FitTitle title={title.main}>{title.main}</FitTitle>
          {title.extra && <p className="qualifier display-tail">{title.extra}</p>}
          <p className="byline facts"><Credits text={album.artist} artistId={album.artistId} artists={album.artists} strong /> <span>{facts}</span><RatingStars target="album" id={album.id} rating={album.userRating} name={album.name} /></p>
          <Actions tracks={tracks}>
            <button type="button" className="text-button icon-action labelled" title="Radio" onClick={() => player.radio({ kind: 'album', id: album.id, label: title.main })}><RadioIcon aria-hidden="true" /><span className="action-label">Radio</span></button>
            <StarButton target="album" id={album.id} starred={album.starred} name={album.name} />
            <MoreButton target={{ kind: 'album', album }} />
            <KeepButton kind="album" id={album.id} name={album.name} artist={album.artist} coverArt={album.coverArt} tracks={tracks} />
          </Actions>
        </div>
      </header>
      <section className="record-songs" aria-label="Songs">
        <TrackTable tracks={tracks} album={album.name} albumArtist={album.artist} numbered="track" groups={discGroups(tracks, discTitles)} columns="auto" large="auto" />
      </section>
      <RecordCredits albumId={album.id} tracks={tracks} />
      <RecordMore album={album} />
    </div>;
  }}</Pending>;
}

// Liner notes under the tracklist: who sings on which song (collated when multiple voices appear
// across multiple songs) and honest file specs reported by the server. Unknown stays absent.
function RecordCredits({ albumId, tracks }: { albumId: string; tracks: Track[] }) {
  const { cast, files } = useMemo(() => {
    const voices = new Map<string, { id?: string; tracks: number[] }>();
    tracks.forEach((t, i) => {
      const no = t.trackNumber ?? i + 1;
      if (t.artists?.length) {
        for (const a of t.artists) {
          const entry = voices.get(a.name) ?? { id: a.id, tracks: [] };
          entry.tracks.push(no);
          voices.set(a.name, entry);
        }
      } else {
        for (const name of splitSingers(t.artist)) {
          const entry = voices.get(name) ?? { id: t.artistId ?? undefined, tracks: [] };
          entry.tracks.push(no);
          voices.set(name, entry);
        }
      }
    });
    const castList = tracks.length > 1 && voices.size > 1
      ? [...voices].map(([name, info]) => ({ name, id: info.id, on: info.tracks.length === tracks.length ? 'every song' : info.tracks.join(', ') }))
      : [];
    const kinds = new Map<string, { count: number; size: number }>();
    for (const t of tracks) {
      const kind = formatTrackSpec(t);
      if (!kind && !t.size) continue;
      const key = kind || 'Audio';
      const g = kinds.get(key) ?? { count: 0, size: 0 };
      g.count += 1;
      g.size += t.size ?? 0;
      kinds.set(key, g);
    }
    const fileList = [...kinds].map(([kind, g]) => ({
      kind,
      detail: [kinds.size > 1 ? plural(g.count, 'song') : null, g.size > 0 ? formatBytes(g.size) : null].filter(Boolean).join(', '),
    }));
    return { cast: castList, files: fileList };
  }, [tracks]);
  if (!cast.length && !files.length) return null;
  return <>
    <SquiggleRule seed={`${albumId} notes`} className="record-break" />
    <section className="credits" aria-label="Credits">
      {cast.length > 0 && <p className="credits-cast">
        {cast.map((c, i) => <span key={c.name} className="who">
          {i > 0 && ', '}
          {c.id ? <button type="button" className="link" data-warm={`artist:${c.id}`} onClick={() => nav.go({ view: 'artist', id: c.id! })}>{c.name}</button> : c.name}
          {' '}<span className="on">({c.on})</span>
        </span>)}
      </p>}
      {files.length > 0 && <p className="credits-files">
        {files.map((f, i) => <span key={f.kind} className="credits-file-row">
          {i > 0 && <br />}
          <span className="who">{f.kind}{f.detail ? ',' : ''}</span>{f.detail ? ` ${f.detail}` : ''}
        </span>)}
      </p>}
    </section>
  </>;
}

// More records under a record's page: artist's other records, others from the same year, and played
// lately share a single 6-column editorial row (or two rows when the artist has 6+ records).
function RecordMore({ album }: { album: Album }) {
  const byArtistRes = useKept(album.artistId ? `artist:${album.artistId}` : null, from => from.artist(album.artistId!));
  const byYearRes = useKept(album.year ? `albums:byYear:${album.year}:0:7` : null, from => from.albums('byYear', 0, 7, { fromYear: album.year!, toYear: album.year! }));
  const recentRes = useKept('albums:recent:0:12', from => from.albums('recent', 0, 12));

  const rows = useMemo(() => {
    const seen = new Set<string>([`${splitTitle(album.name).main.toLowerCase()}|${album.artist.toLowerCase()}`]);
    const fresh = (list: Album[]) => list.filter(r => {
      const k = `${splitTitle(r.name).main.toLowerCase()}|${r.artist.toLowerCase()}`;
      if (r.id === album.id || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const artistAll = byArtistRes?.ok ? fresh(byArtistRes.value.albums) : [];
    const artistShown = artistAll.slice(0, 6).sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
    const yearShown = byYearRes?.ok ? fresh(byYearRes.value) : [];
    const recentShown = recentRes?.ok ? fresh(recentRes.value) : [];

    type Group = { id: string; title: string; records: Album[]; sub: 'artist' | 'year'; onHeading?: () => void; fill?: boolean };
    const artistGroup: Group = {
      id: 'more-by', title: `More by ${album.artist}`, records: artistShown, sub: 'year',
      onHeading: album.artistId && artistAll.length > 6 ? () => nav.go({ view: 'artist', id: album.artistId! }) : undefined,
    };
    const yearGroup: Group = { id: 'more-from', title: `Also from ${album.year}`, records: yearShown, sub: 'artist' };
    const latelyGroup: Group = { id: 'more-lately', title: 'Played lately', records: recentShown, sub: 'artist', fill: true };

    const pack = (groups: Group[]) => {
      const out: (Group & { cols: number; wide: boolean })[] = [];
      let left = 6;
      for (const g of groups) {
        const fits = g.fill ? left >= 1 : left >= 2;
        if (!g.records.length || !fits) continue;
        const recs = g.records.slice(0, left);
        const cols = g.fill ? left : Math.min(left, Math.max(recs.length, 2));
        const wide = recs.length === 1 && cols >= 2;
        out.push({ ...g, records: recs, cols, wide });
        left -= cols;
      }
      return out;
    };

    const built: ReturnType<typeof pack>[] = [];
    if (artistGroup.records.length >= 6) {
      built.push(pack([artistGroup]));
      if (yearGroup.records.length) built.push(pack([yearGroup, latelyGroup]));
    } else {
      const one = pack([artistGroup, yearGroup, latelyGroup]);
      if (one.length) built.push(one);
    }
    return built.filter(r => r.length > 0);
  }, [album, byArtistRes, byYearRes, recentRes]);

  if (!rows.length) return null;
  return <section className="record-more" aria-label="More records">
    {rows.map((groups, ri) => <div key={ri} className="shelf-row">
      {groups.map(g => <section key={g.id} className="shelf-group" style={{ gridColumn: `span ${g.cols}` }} aria-labelledby={g.id}>
        <div className="heading heading-small">
          <h2 id={g.id}>{g.onHeading ? <button type="button" className="heading-link" onClick={g.onHeading}>{g.title}</button> : g.title}</h2>
        </div>
        <AlbumGrid albums={g.records} cols={g.wide ? 1 : g.cols} sub={g.sub} wideSingle={g.wide} />
      </section>)}
    </div>)}
  </section>;
}

function StarButton({ target, id, starred, name }: { target: 'album' | 'artist'; id: string; starred: boolean; name: string }) {
  useFavoritesVersion();
  const on = isStarred(id, starred);
  return <button type="button" className={`text-button star-text icon-action${on ? ' on' : ''}`} aria-pressed={on} title={on ? 'In favorites' : 'Add to favorites'} onClick={() => void setStarred(target, [id], !on)}>
    <Glyph kind={on ? 'hearted' : 'heart'} /><span className="action-label">{on ? 'In favorites' : 'Add to favorites'}</span><span className="sr-only"> {name}</span></button>;
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
  return <button type="button" className="text-button more-button icon-action" aria-haspopup="menu" aria-label="More" title="More" onClick={event => {
    const box = event.currentTarget.getBoundingClientRect();
    openMenu({ clientX: box.left, clientY: box.bottom + 6, preventDefault: () => {}, target: event.currentTarget }, target);
  }}><MoreHorizontal aria-hidden="true" /></button>;
}

// Artists ------------------------------------------------------------------------------

export function Artists() {
  const result = useKept('artists', from => from.artists());
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
            <button type="button" data-warm={`artist:${artist.id}`} onClick={() => nav.go({ view: 'artist', id: artist.id })}
              onContextMenu={event => openMenu(event, { kind: 'artist', artist })}
              draggable={drags} onDragStart={event => startDrag(event, { kind: 'artist', artist })}>
              <span className="artist-name">{artist.name}</span> <span>{plural(artist.albumCount, 'record')}</span>
            </button>
            <PlayOver small label={artist.name} play={() => playTarget({ kind: 'artist', artist })} />
          </li>)}
        </ul>)}
    </div>
  </>;
}

// An artist's page asks for three things, which reaching for a link to it asks for early (warm.ts).
// Whether any artist has had popular songs this run: a server whose agents find none (no Last.fm,
// say) never has, and its pages don't keep room for them.
let popularFound: boolean | null = null;
// How long the rest of a page waits for the about and popular songs above its records, so they
// don't push the records down when they arrive.
const TOGETHER_MS = 700;
export function ArtistPage({ id }: { id: string }) {
  const result = useKept(`artist:${id}`, from => from.artist(id));
  const top = useKept(`top:${id}`, from => from.topSongs(id, TOP_SONGS));
  const info = useKept(`artistInfo:${id}`, from => from.artistInfo(id));
  if (top?.ok) popularFound = popularFound || top.value.length > 0;
  const [waited, setWaited] = useState<string | null>(null);
  const arrived = !!result;
  useEffect(() => {
    if (!arrived) return;
    const timer = setTimeout(() => setWaited(id), TOGETHER_MS);
    return () => clearTimeout(timer);
  }, [arrived, id]);
  const together = waited === id || (top !== undefined && info !== undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const playAll = async (artist: Pick<Artist, 'id' | 'name'>, shuffle: boolean) => {
    setProblem(null); setBusy(true);
    const tracks = await tracksOf({ kind: 'artist', artist });
    setBusy(false);
    if (!tracks.ok) { setProblem(tracks.error); return; }
    if (!tracks.value.length) { setProblem(`There are no songs by ${artist.name} on this server.`); return; }
    await player.play(shuffle ? shuffled(tracks.value) : tracks.value, 0);
    showNowPlaying();
  };
  return <Pending result={result} waiting="Finding their records">{({ artist, albums, appearsOn }) => {
    const totalSongs = albums.reduce((sum, a) => sum + (a.songCount ?? 0), 0);
    const totalSeconds = albums.reduce((sum, a) => sum + (a.duration ?? 0), 0);
    const facts = albums.length || !appearsOn
      ? [plural(Math.max(artist.albumCount ?? 0, albums.length), 'record'), totalSongs > 0 ? plural(totalSongs, 'song') : null, totalSeconds > 0 ? length(totalSeconds) : null].filter(Boolean).join(', ')
      : `${plural(appearsOn.tracks.length, 'song')} on ${plural(appearsOn.albums.length, 'record')}`;
    const openAllSongs = () => nav.go({ view: 'tracks', sort: 'alphabeticalByName', artistId: artist.id, artistName: artist.name });
    const topShown = top?.ok ? top.value.slice(0, 6) : [];
    return <div className="artist-page">
      <header className="head feature artist-head">
        <div className="head-text">
          <FitTitle sizes={[88, 78, 68]} wrapped={[72, 64, 56, 48, 40]} title={artist.name}>{artist.name}</FitTitle>
          <p className="byline facts"><span>{facts}</span><RatingStars target="artist" id={artist.id} rating={artist.userRating} name={artist.name} /></p>
          <div className="actions">
            <button type="button" className="play-action" disabled={busy} onClick={() => void playAll(artist, false)}>
              <span className="disc"><Glyph kind="play" /></span><span className="action-label">Play</span>
            </button>
            <button type="button" className="text-button icon-action" title="Shuffle" disabled={busy} onClick={() => void playAll(artist, true)}><ShuffleIcon aria-hidden="true" /><span className="action-label">Shuffle</span></button>
            <button type="button" className="text-button icon-action labelled" title="Radio" onClick={() => player.radio({ kind: 'artist', id: artist.id, label: artist.name })}><RadioIcon aria-hidden="true" /><span className="action-label">Radio</span></button>
            <button type="button" className="text-button icon-action labelled" onClick={openAllSongs}><List aria-hidden="true" /><span className="action-label">All songs</span></button>
            <StarButton target="artist" id={artist.id} starred={artist.starred} name={artist.name} />
            <MoreButton target={{ kind: 'artist', artist }} />
          </div>
          {problem && <p className="note" role="alert">{problem}</p>}
        </div>
      </header>
      {!together ? <p className="status loading">Finding their songs</p> : <>
        {topShown.length > 0 && <section className="artist-top" aria-labelledby="artist-most-played">
          <div className="heading">
            <h2 id="artist-most-played"><button type="button" className="heading-link" onClick={openAllSongs}>Most played</button></h2>
          </div>
          <TrackTable tracks={topShown} albumArtist={artist.name} leadingCover columns={2}
            noteOf={t => t.playCount ? plural(t.playCount, 'play') : null} />
        </section>}
        {top === undefined && popularFound !== false && <section className="artist-top" aria-busy="true"><h2>Most played</h2>
          <p className="status loading popular-waiting">Finding their popular songs</p></section>}
        {albums.length > 0 && <>
          <SquiggleRule seed={`${artist.name} records`} className="artist-break" />
          <ArtistDiscography albums={albums} />
        </>}
        {appearsOn && <section className="shelf-section"><h2>Appears on</h2><AlbumGrid albums={appearsOn.albums} cols={5} /></section>}
        {info?.ok && info.value.biography && <Biography text={info.value.biography} />}
        {info?.ok && info.value.similar.length > 0 && <SimilarArtists artists={info.value.similar} />}
      </>}
    </div>;
  }}</Pending>;
}

// Chronological discography printed like a catalogue: oldest first, full-width year groups with
// the year on the left and that year's records two across beside it.
function ArtistDiscography({ albums }: { albums: Album[] }) {
  const drags = canDrag();
  const years = useMemo(() => {
    const sorted = [...albums].sort((a, b) => {
      const ya = a.year ?? Number.MAX_SAFE_INTEGER, yb = b.year ?? Number.MAX_SAFE_INTEGER;
      return ya - yb || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    });
    const out: { year: number | null; records: Album[] }[] = [];
    for (const album of sorted) {
      const y = album.year ?? null;
      const last = out[out.length - 1];
      if (!last || last.year !== y) out.push({ year: y, records: [album] });
      else last.records.push(album);
    }
    return out;
  }, [albums]);
  return <section className="discography" aria-label="Records">
    {years.map((group, idx) => <section key={`${group.year ?? 'undated'}-${idx}`} className="disc-group" aria-label={group.year ? String(group.year) : 'Other records'}>
      <h2 className="disc-year">{group.year ?? '—'}</h2>
      <ol className="disc-records">
        {group.records.map(album => {
          const title = splitTitle(album.name);
          const facts = [album.songCount ? plural(album.songCount, 'song') : null, album.duration ? length(album.duration) : null].filter(Boolean).join(', ');
          return <li key={album.id} className="disc playable">
            <PlayOver small label={title.main} play={() => playTarget({ kind: 'album', album })} />
            <button type="button" className="disc-record" data-warm={`album:${album.id}`}
              onClick={event => { travel(album.id, event.currentTarget); nav.go({ view: 'album', id: album.id }); }}
              onContextMenu={event => openMenu(event, { kind: 'album', album })}
              draggable={drags} onDragStart={event => startDrag(event, { kind: 'album', album })}>
              <Cover id={album.coverArt} name={album.name} size={160} className={`disc-sleeve${album.id === morph.id ? ' morph' : ''}`} />
              <span className="disc-words">
                <span className="disc-name">{title.main}</span>
                {title.extra && <span className="disc-tail">{title.extra}</span>}
                {facts && <span className="disc-facts">{facts}</span>}
              </span>
              <ContainerMark kind="album" id={album.id} />
            </button>
          </li>;
        })}
      </ol>
    </section>)}
  </section>;
}

// Tracks -------------------------------------------------------------------------------
// Every track, set like the index at the back of a book. Also serves one artist's full song list
// when opened from their Artist page ("All songs").

const TRACKS = 200;
let tracksSorted: boolean | null = null;
let tracksPlainHttp = false;
onLibraryReset(() => { tracksSorted = null; tracksPlainHttp = false; });

export function Tracks() {
  const route = useRoute();
  if (route.view === 'tracks' && route.artistId && route.artistName) {
    return <ArtistTracks artistId={route.artistId} artistName={route.artistName} sort={route.sort ?? 'alphabeticalByName'} />;
  }
  return <LibraryTracks sort={route.view === 'tracks' && route.sort ? route.sort : 'newest'} />;
}

function LibraryTracks({ sort }: { sort: TrackSort }) {
  const tracks = usePaged<Track>(`tracks:${sort}`, TRACKS, (offset, seed) => [
    `tracks:${sort}:${offset}:${TRACKS}${sort === 'random' ? `:${seed}` : ''}`,
    () => api.tracks(sort, offset, TRACKS, sort === 'random' ? String(seed) : '').then((result): Result<Track[]> => {
      if (!result.ok) return result;
      tracksSorted = result.value.sorted; tracksPlainHttp = !!result.value.plainHttp;
      return { ok: true, value: result.value.tracks };
    }),
  ]);
  const sentinel = useMore(tracks.more, tracks.items.length);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shuffle = async () => {
    setProblem(null); setBusy(true);
    const asked = playRequests();
    const drawn = await api.randomSongs({ size: 500 });
    setBusy(false);
    if (playRequests() !== asked) return;
    if (!drawn.ok) { setProblem(drawn.error); return; }
    if (drawn.value.length) { await player.play(drawn.value, 0); showNowPlaying(); }
  };
  const played = tracksSorted && (sort === 'frequent' || sort === 'recent');
  const alpha = sort === 'alphabeticalByName';
  return <div className="tracks-page">
    <div className="tracks-head-bar">
      <div className="actions">
        <button type="button" className="play-action" disabled={!tracks.items.length} onClick={() => void player.play(tracks.items, 0).then(showNowPlaying)}>
          <span className="disc"><Glyph kind="play" /></span><span className="action-label">Play</span>
        </button>
        <button type="button" className="text-button icon-action" title="Shuffle" disabled={busy || !tracks.items.length} onClick={() => void shuffle()}><ShuffleIcon aria-hidden="true" /><span className="action-label">Shuffle</span></button>
      </div>
      {tracksSorted && <OrderMenu value={sort} options={trackSorts} onSelect={next => pickSort('tracks', sort, next)} ariaLabel="Order" className="tracks-order-menu" />}
    </div>
    {problem && <p className="note" role="alert">{problem}</p>}
    {tracksPlainHttp && <p className="note">In the server's order. Sorting a library this big needs HTTPS.</p>}
    {tracks.items.length ? <section className="tracks-index" aria-label="Songs">
      <TrackTable tracks={tracks.items} bookIndex lettered={alpha} numbered={alpha ? 'none' : 'position'} />
    </section> : tracks.done
      ? <Status>{played ? 'Nothing played yet.'
        : tracksSorted && sort === 'highest' ? 'Nothing rated yet.' : 'No tracks on this server yet.'}</Status>
      : tracks.error ? <Status>{tracks.error}</Status> : <p className="status loading">Gathering tracks</p>}
    {tracks.error && tracks.items.length > 0 && <Status>{tracks.error}</Status>}
    <div ref={sentinel} className="sentinel" />
  </div>;
}

const artistTrackSorts: readonly OrderOption<'alphabeticalByName' | 'frequent' | 'highest'>[] = [
  { value: 'alphabeticalByName', label: 'A to Z' },
  { value: 'frequent', label: 'Most played' },
  { value: 'highest', label: 'Top rated' },
];
function ArtistTracks({ artistId, artistName, sort }: { artistId: string; artistName: string; sort: TrackSort }) {
  const result = useResource(`artistTracks:${artistId}`, () => tracksOf({ kind: 'artist', artist: { id: artistId, name: artistName } }));
  const order: 'alphabeticalByName' | 'frequent' | 'highest' = sort === 'frequent' || sort === 'highest' ? sort : 'alphabeticalByName';
  const sorted = useMemo(() => {
    if (!result?.ok) return [];
    const list = [...result.value];
    if (order === 'frequent') return list.sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0) || a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
    if (order === 'highest') return list.sort((a, b) => (b.userRating ?? 0) - (a.userRating ?? 0) || a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
    return list.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base', numeric: true }) || a.album.localeCompare(b.album));
  }, [result, order]);
  const totalSeconds = useMemo(() => sorted.reduce((sum, t) => sum + (t.duration ?? 0), 0), [sorted]);
  return <div className="tracks-page">
    <header className="tracks-artist">
      <FitTitle title={artistName}><button type="button" className="heading-link" onClick={() => nav.go({ view: 'artist', id: artistId })}>{artistName}</button></FitTitle>
      {result?.ok && <p className="facts">{plural(sorted.length, 'song')}, {length(totalSeconds)}</p>}
    </header>
    <div className="tracks-head-bar">
      <div className="actions">
        <button type="button" className="play-action" disabled={!sorted.length} onClick={() => void player.play(sorted, 0).then(showNowPlaying)}>
          <span className="disc"><Glyph kind="play" /></span><span className="action-label">Play</span>
        </button>
        <button type="button" className="text-button icon-action" title="Shuffle" disabled={!sorted.length} onClick={() => void player.play(shuffled(sorted), 0).then(showNowPlaying)}><ShuffleIcon aria-hidden="true" /><span className="action-label">Shuffle</span></button>
      </div>
      <OrderMenu value={order} options={artistTrackSorts}
        onSelect={next => nav.go({ view: 'tracks', sort: next, artistId, artistName }, true)} ariaLabel="Order" className="tracks-order-menu" />
    </div>
    <Pending result={result} waiting="Gathering songs">{() => sorted.length
      ? <section className="tracks-index" aria-label="Songs">
        <TrackTable tracks={sorted} albumArtist={artistName} bookIndex lettered={order === 'alphabeticalByName'} numbered={order === 'alphabeticalByName' ? 'none' : 'position'} />
      </section>
      : <Status>There are no songs by {artistName} on this server.</Status>}</Pending>
  </div>;
}

// Playlists ----------------------------------------------------------------------------

function playlistNote(playlist: Playlist) {
  if (playlist.comment?.startsWith('Auto-imported')) return 'Kept in sync with a playlist file on the server.';
  if (playlist.readonly) return 'Managed by the server.';
  return null;
}

const PLAYLIST_MIXES = 8;
export function Playlists() {
  const playlists = useKept('playlists', from => from.playlists());
  const genres = useKept('genres', from => from.genres());
  const decades = useResource('decades', libraryDecades);
  const history = useKept('albums:frequent:0:1', from => from.albums('frequent', 0, 1));
  const mixes = useMemo(() => buildMixes(genres?.ok ? genres.value : [], decades?.ok ? decades.value : [], !!(history?.ok && history.value.length)),
    [genres, decades, history]);
  return <>
    <Head title="Playlists" />
    <section className="shelf-section" aria-labelledby="yours">
      <div className="section-head"><h2 id="yours">Yours</h2><NewPlaylist /></div>
      <Pending result={playlists} waiting="Loading playlists">{list => list.length ? <ul className="rows">
        {list.map(playlist => <PlaylistRow key={playlist.id} playlist={playlist} />)}
      </ul> : <Status>No playlists yet.</Status>}</Pending>
    </section>
    <section className="shelf-section" aria-labelledby="automatic">
      <div className="section-head"><h2 id="automatic">Automatic</h2><SeeAll what="mixes" go={() => nav.go({ view: 'mixes' })} /></div>
      <ul className="rows">
        {/* The first few; the Mixes page has them all. */}
        {mixes.slice(0, PLAYLIST_MIXES).map(mix =><li key={mix.id} className="playable">
          <PlayOver label={mix.name} play={async () => {
            const drawn = await mixTracks(mix);
            if (drawn.ok && drawn.value.length) { await player.play(drawn.value, 0); showNowPlaying(); }
          }} />
          <button type="button" onClick={event => { travel(mix.id, event.currentTarget); nav.go({ view: 'mix', id: mix.id }); }}>
            <MixTile mix={mix} travels={mix.id === morph.id} />
            <span className="row-text"><span className="row-name">{mix.name}</span><span className="row-sub row-desc">{mix.description}</span></span>
          </button>
        </li>)}
      </ul>
    </section>
    <KeptSection />
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
        <span className="row-sub">{plural(playlist.songCount, 'song')}, {length(playlist.duration)}</span>
        {note?.startsWith('Kept in sync') && <span className="row-badge" title={note}>Synced from a file</span>}
      </span>
      <ContainerMark kind="playlist" id={playlist.id} />
    </button>
  </li>;
}

function NewPlaylist() {
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!naming) return <button type="button" className="text-button new-playlist" onClick={() => setNaming(true)}><Plus aria-hidden="true" />New playlist</button>;
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
  const [sleeves, setSleeves] = useState<string[] | null>(null);
  const tile = useRef<HTMLDivElement>(null);
  const session = useLibraryEpoch();
  useEffect(() => {
    if (tracks !== undefined || !tile.current) return;
    let live = true;
    const observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return;
      observer.disconnect();
      // A mix of whole records shows their sleeves from the list of them, not from a draw that
      // reads every record's songs.
      if (mix.covers) void mix.covers().then(result => { if (live && result.ok) setSleeves(result.value); });
      else void mixTracks(mix).then(result => { if (live && result.ok) setDrawn(result.value); });
    }, { root: nav.scroller, rootMargin: '200px' });
    observer.observe(tile.current);
    return () => { live = false; observer.disconnect(); };
  }, [mix.id, tracks, session]);
  const list = tracks ?? drawn ?? [];
  const covers = (tracks === undefined && sleeves ? [...new Set(sleeves)] : [...new Map(list.filter(t => t.coverArt).map(t => [t.albumId ?? t.coverArt, t.coverArt!])).values()]).slice(0, 4);
  const classes = `cover mix-tile${large ? ' head-cover' : ''}${travels ? ' morph' : ''}`;
  // Four records' sleeves in a square; with fewer (a decade with little in it), the first record's
  // whole; with none yet, or none at all, the mix's name.
  if (!covers.length) return <div ref={tile} className={`${classes} cover-type`} aria-hidden="true"><span>{mix.name}</span></div>;
  if (covers.length < 4) return <div ref={tile} className={`${classes} mosaic single`} aria-hidden="true">
    <img src={api.coverUrl(covers[0], large ? 600 : 300)} alt="" loading="lazy" decoding="async" />
  </div>;
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
        {!view.saving && <KeepButton kind="playlist" id={playlist.id} name={playlist.name} coverArt={playlist.coverArt} tracks={tracks} />}
      </Actions>
      {view.error && <p className="note" role="alert">{view.error}</p>}
    </Head>
    {tracks.length ? <TrackTable tracks={tracks} showAlbum playlist={playlist}
      onMove={editable ? (from, to) => void editor.move(from, to) : undefined}
      onRemove={editable ? indexes => void editor.removeAt(indexes) : undefined}
      onDropItems={editable ? (payload, at) => void dropOnPlaylist(playlist, payload, null, at) : undefined} />
      : <Status>This playlist is empty.</Status>}
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
        {tracks && <KeepButton kind="mix" id={mix.id} name={mix.name} tracks={tracks} />}
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
  const result = useKept('starred', from => from.starred());
  return <>
    <Head title="Favorites" />
    <Pending result={result} waiting="Collecting favorites">{({ tracks, albums, artists }) => !tracks.length && !albums.length && !artists.length
      ? <Status>No favorites yet.</Status>
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
    <button type="button" data-warm={`artist:${artist.id}`} onClick={() => nav.go({ view: 'artist', id: artist.id })}
      draggable={drags} onDragStart={event => startDrag(event, { kind: 'artist', artist })}>
      {/* The server's picture of the artist (a photo, or one of their sleeves); only for the eye. */}
      <span className="artist-thumb" aria-hidden="true"><Cover id={artist.coverArt} name={artist.name} size={96} portrait /></span>
      <span className="artist-label">{artist.name}{artist.albumCount > 0 && <> <span>{plural(artist.albumCount, 'record')}</span></>}</span></button>
    <PlayOver small label={artist.name} play={() => playTarget({ kind: 'artist', artist })} />
  </li>)}</ul>;
}

// Past this many songs the queue is windowed, and windowed rows can't fold away.
const QUEUE_FOLD_LIMIT = 120;
export function Queue() {
  const queue = usePlayer(s => s.queue);
  const entryIds = usePlayer(s => s.entryIds);
  const index = usePlayer(s => s.index);
  const playing = usePlayer(s => s.playing);
  const radio = usePlayer(s => s.radio);
  const repeat = usePlayer(s => s.repeat);
  const shuffle = usePlayer(s => s.shuffle);
  const autoplay = usePlayer(s => s.autoplay);
  const away = usePlayer(s => s.reach.away);
  const settings = useSettings();
  const [saved, setSaved] = useState<string | null>(null);
  const [showPlayed, setShowPlayed] = useState(false);
  const foldable = index > 0 && queue.length <= QUEUE_FOLD_LIMIT;
  const folded = foldable && !showPlayed;
  const nowTrack = queue[index];
  // Group upcoming songs by record when the record changes (first run stays unheaded while it is
  // still the playing record), and keep quiet autoplay labels where autoplay appended runs.
  const groups = useMemo<TrackGroup[]>(() => {
    const added = addedRuns(autoplay, entryIds).map(at => ({ at, label: 'Added by autoplay', quiet: true }));
    const addedAt = new Set(added.map(g => g.at));
    const parts: TrackGroup[] = [];
    if (index > 0 && !folded) parts.push({ at: 0, label: 'Played', quiet: true });
    if (queue.length <= QUEUE_FOLD_LIMIT && nowTrack) {
      let prevKey = nowTrack.albumId ?? nowTrack.album;
      for (let i = index + 1; i < queue.length; i++) {
        const track = queue[i];
        if (isStation(track)) { prevKey = ''; continue; }
        const recKey = track.albumId ?? track.album;
        if (recKey && recKey !== prevKey && !addedAt.has(i)) {
          let end = i + 1;
          while (end < queue.length && !isStation(queue[end]) && (queue[end].albumId ?? queue[end].album) === recKey && !addedAt.has(end)) end++;
          const run = queue.slice(i, end);
          const recTitle = splitTitle(track.album);
          const dur = run.reduce((sum, t) => sum + (t.duration ?? 0), 0);
          parts.push({
            at: i,
            label: recTitle.main,
            record: {
              id: track.albumId,
              name: recTitle.main,
              coverArt: track.coverArt,
              sub: [track.artist, recTitle.extra, plural(run.length, 'song'), dur > 0 ? length(dur) : null].filter(Boolean).join(', '),
            },
          });
        }
        prevKey = recKey;
      }
    }
    return [...parts, ...added].sort((a, b) => a.at - b.at);
  }, [autoplay, entryIds, index, folded, queue, nowTrack]);
  const drop = useDropTarget(payload => void dropOnQueue(payload));
  const area = `drop-area queue-page${drop.over ? ' drop-over' : ''}`;
  if (!queue.length || !nowTrack) return <div className={area} {...drop.handlers}><Status>Nothing queued.</Status></div>;
  const upcoming = queue.length - index - 1;
  const upcomingSeconds = queue.slice(index + 1).reduce((sum, t) => sum + (t.duration ?? 0), 0);
  const repeats = repeat === 'all' ? 'the queue repeats' : repeat === 'one' ? 'this song repeats' : null;
  const modes = shuffle ? (repeats ? `Shuffled, and ${repeats}.` : 'Shuffled.') : repeats && `${repeats[0].toUpperCase()}${repeats.slice(1)}.`;
  const follows = !radio && repeat === 'off';
  const endsOnSong = follows && upcoming === 0 && queue.at(-1)?.source === 'navidrome';
  const offer = endsOnSong && !settings.autoplay && !away;
  const nowTitle = splitTitle(nowTrack.title, nowTrack.album);
  return <div className={area} {...drop.handlers}>
    <header className="queue-now" onContextMenu={event => openMenu(event, { kind: 'tracks', tracks: [nowTrack], indexes: [index], from: { queue: true } })}>
      <FitTitle sizes={[56, 48, 40]} wrapped={[40, 34]} title={nowTitle.main}>
        <span className="queue-mark"><Wave playing={playing} /></span>
        <button type="button" className="queue-now-toggle" onClick={player.toggle}>{nowTitle.main}</button>
      </FitTitle>
      {nowTitle.extra && <p className="display-tail">{nowTitle.extra}</p>}
      <p className="facts">
        <Credits text={nowTrack.artist} artistId={nowTrack.artistId} artists={nowTrack.artists} strong />
        {nowTrack.album && (nowTrack.albumId && !isStation(nowTrack)
          ? <button type="button" className="link queue-from" data-warm={`album:${nowTrack.albumId}`} onClick={() => nav.go({ view: 'album', id: nowTrack.albumId! })}>{splitTitle(nowTrack.album).main}</button>
          : <span className="queue-from">{splitTitle(nowTrack.album).main}</span>)}
      </p>
    </header>
    <div className="queue-tally">
      <p>
        {upcoming > 0 ? <><b>{plural(upcoming, 'song')} to come,</b> {length(upcomingSeconds)}</> : <b>This is the last song.</b>}
        {modes && <>{' · '}<span>{modes}</span></>}
        {offer && <>{' '}<button type="button" className="link" onClick={() => void updateSettings({ autoplay: true })}>Keep playing similar songs</button></>}
      </p>
      <div className="actions">
        <button type="button" className="text-button" onClick={async () => {
          const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
          setSaved(await createPlaylist(`Queue, ${date}`, queue.filter(t => t.source === 'navidrome').map(t => t.id)));
        }}>Save as playlist</button>
        {foldable && <button type="button" className="text-button" aria-expanded={showPlayed} onClick={() => setShowPlayed(v => !v)}>{showPlayed ? 'Hide played' : `Show played`}</button>}
        <button type="button" className="text-button quiet clear-queue" disabled={upcoming < 1} onClick={() => void player.clear()}>Clear</button>
      </div>
    </div>
    {saved && <p className="note" role="alert">{saved}</p>}
    <div className={`queue-next${folded ? ' played-folded' : ''}`}>
      <TrackTable tracks={queue} queue hideIndex={!showPlayed && queue.length <= QUEUE_FOLD_LIMIT ? index : -1}
        onPick={(i, entry) => player.jump(i, entry)} onMove={(from, to) => void player.move(from, to)} onRemove={indexes => void player.remove(indexes)}
        onDropItems={(payload, at) => void dropOnQueue(payload, at)} groups={groups} />
    </div>
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
  const row = (key: Exclude<keyof typeof settings, 'outputDevice' | 'checkForUpdates' | 'keptLimitMb' | 'diagnostics' | 'playCountsAt' | 'streamQuality'>, title: string, detail?: string) => <label className="setting">
    <input type="checkbox" checked={settings[key]} onChange={event => void updateSettings({ [key]: event.target.checked })} />
    <span><strong>{title}</strong>{detail && <span>{detail}</span>}</span>
  </label>;
  return <>
    <Head title="Settings" />
    <section className="settings">
      <h2>Lyrics</h2>
      {row('lyricsLookup', 'Look up missing lyrics on LRCLIB', 'Sends the title, artist, and album to lrclib.net.')}
      <h2>Queue</h2>
      {row('autoplay', 'Keep playing similar songs when the queue ends')}
      <h2>Your server</h2>
      {row('reportPlays', 'Report what you play')}
      {settings.reportPlays && <label className="setting choice">
        <span><strong>Count a play after</strong></span>
        <select value={settings.playCountsAt} onChange={event => void updateSettings({ playCountsAt: Number(event.target.value) as PlayCountsAt })}>
          {PLAY_COUNTS_AT.map(percent => <option key={percent} value={percent}>{percent}% of the song</option>)}
        </select>
      </label>}
      <QueuedPlays />
      {row('syncQueue', 'Sync the queue across devices')}
      <div className="server-actions"><Disconnect />{mode === 'web' && <SignOut />}</div>
      {keptSupported && <KeptSettings />}
      {mode === 'desktop' && <>
        <h2>Sound</h2>
        <label className="setting choice">
          <span><strong>Output</strong></span>
          <select value={settings.outputDevice} onChange={event => void updateSettings({ outputDevice: event.target.value })}>
            {!devices.some(d => d.name === settings.outputDevice) && <option value={settings.outputDevice}>{settings.outputDevice === 'auto' ? 'System default' : `${outputDescription(settings.outputDevice) ?? settings.outputDevice} (disconnected)`}</option>}
            {devices.map(d => <option key={d.name} value={d.name}>{d.name === 'auto' ? 'System default' : d.description}</option>)}
          </select>
        </label>
        <label className="setting choice">
          <span><strong>Streaming quality</strong><span>Applies from the next song.</span></span>
          <select value={settings.streamQuality} onChange={event => void updateSettings({ streamQuality: event.target.value === 'original' ? 'original' : Number(event.target.value) as StreamQuality })}>
            {STREAM_QUALITIES.map(quality => <option key={quality} value={quality}>{quality === 'original' ? 'Original file' : `MP3, ${quality} kbps`}</option>)}
          </select>
        </label>
        {row('exclusiveOutput', 'Exclusive output', 'Other apps go quiet while Squiggly plays.')}
        <UpdateSettings />
        <h2>Window</h2>
        {row('closeToTray', 'Keep playing in the tray when the window closes')}
        {row('miniOnTop', 'Keep the mini player on top')}
        {diagnosticsBuilt && <><h2>Diagnostics</h2><DiagnosticsSwitch /></>}
      </>}
      {error && <p className="note" role="alert">{error}</p>}
      <ThemeSettings />
      <KeySettings />
      {mode === 'desktop' && <ExtensionsSettings />}
      <SharesSettings />
    </section>
  </>;
}

// Finished plays waiting while the server was out of reach (desktop and Android).
function QueuedPlays() {
  const count = usePlayer(s => s.queuedPlays);
  if (!count) return null;
  return <p className="note">{plural(count, 'play')} waiting for your server.</p>;
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
      <span><strong>Check for updates</strong></span>
    </label>
    <div className="setting-action">
      <p><span role="status">{status}</span></p>
      {update.status === 'ready' && <button type="button" className="text-button" onClick={() => void bridge.install()}>Restart to update</button>}
      {update.status === 'available' && <button type="button" className="text-button" onClick={() => void bridge.open()}>Open the release page</button>}
      {!['checking', 'downloading', 'ready'].includes(update.status) && <button type="button" className="text-button" onClick={() => void bridge.check()}>Check now</button>}
    </div>
  </>;
}

// Desktop betas with remote diagnostics built in (apps/desktop/main/remoteDiagnostics.ts). Off,
// the main process sends and writes nothing until it's turned on again. The beta marker
// (App.tsx) opens Settings here with the switch focused.
let focusDiagnostics = false;
const diagnosticsFocus = new Set<() => void>();
export function showDiagnosticsSetting() {
  focusDiagnostics = true;
  nav.go({ view: 'settings' });
  // Already on Settings: the switch is there to take focus now.
  diagnosticsFocus.forEach(take => take());
}
export function DiagnosticsSwitch() {
  const settings = useSettings();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const take = () => {
      if (!focusDiagnostics || !input.current) return;
      focusDiagnostics = false;
      input.current.scrollIntoView({ block: 'center' });
      input.current.focus({ preventScroll: true });
    };
    take();
    diagnosticsFocus.add(take);
    return () => { diagnosticsFocus.delete(take); };
  }, []);
  return <label className="setting">
    <input ref={input} type="checkbox" checked={settings.diagnostics} onChange={event => void updateSettings({ diagnostics: event.target.checked })} />
    <span><strong>Send diagnostics to the developer</strong><span>Errors and logs. Never passwords or tokens.</span></span>
  </label>;
}

// The browser build: the page's own sign-in, when the host asks for a password. Without one the
// page is open to whoever can reach it, and there is nothing here to sign out of.
function SignOut() {
  const access = usePlayer(s => s.access);
  const [busy, setBusy] = useState(false);
  if (access !== 'signed-in') return null;
  return <div className="setting-action">
    <button type="button" className="text-button" disabled={busy} onClick={async () => { setBusy(true); await player.signOut(); setBusy(false); }}>
      {busy ? 'Signing out' : 'Sign out'}</button>
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
    <p><span>Using {serverName ?? 'the host\'s server'}. Switching stops playback and empties the queue.</span></p>
    <button type="button" className="text-button" onClick={() => player.chooseServer(true)}>Connect to another server</button>
  </div>;
  return <div className="setting-action">
    <p><strong>Disconnect or switch server</strong>
      <span>Connected to {serverName ?? 'your server'}. {web ? 'You\'ll need the password again.'
        : keptSupported ? 'Forgets the saved sign-in and everything kept on this device.' : 'Forgets the saved sign-in.'}</span></p>
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
  if (mode === 'web') return <><Head title="Diagnostics" /><Status>Only in the desktop app.</Status></>;
  if (mode === 'android') return <><Head title="Diagnostics" /><Status>Only in the desktop app.</Status></>;
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
      {/* What mpv decoded into and handed to the system, and on Linux what the sound server says it
          runs the sink at. What the DAC receives isn't reported. */}
      {audio?.decoderFormat && <tr><th>Decoded</th><td>{[audio.decoderFormat, kHz(audio.decoderRate)].filter(Boolean).join(' · ')}</td><td /></tr>}
      {audio?.outputBackend && <tr><th>Handed to</th><td>{[audio.outputBackend, kHz(audio.outputRate), audio.outputFormat].filter(Boolean).join(' · ')}</td><td /></tr>}
      {audio?.sink && <tr><th>Sink</th><td>{audio.sink.name}</td><td>{sinkSentence(audio.sink, audio.outputRate)}</td></tr>}
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
      <button type="button" className="link" data-warm={`artist:${artist.id}`} onClick={() => nav.go({ view: 'artist', id: artist.id })}>{artist.name}</button>
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
  const result = useKept('genres', from => from.genres());
  return <>
    <Head title="Genres" />
    <Pending result={result} waiting="Gathering genres">{genres => genres.length ? <GenreList genres={genres} />
      : <Status>No genres yet.</Status>}</Pending>
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
  const genres = useKept('genres', from => from.genres());
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
          <span className="disc"><Glyph kind="play" /></span><span className="action-label">Play</span>
        </button>
        <button type="button" className="text-button icon-action" title="Shuffle" disabled={busy || !tracks.items.length} onClick={() => void shuffle()}><ShuffleIcon aria-hidden="true" /><span className="action-label">Shuffle</span></button>
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
// The inside of the sleeve: the record played last (or newest when nothing has been played yet) to
// pick up again, then a 58/42 split for Most played (numbered ranking) and Played lately (two
// sleeves across), followed by a hand-drawn squiggle rule, New arrivals, Your mixes, and Elsewhere.
const SHELF = 12;
export function Home() {
  const recent = useKept(`albums:recent:0:${SHELF}`, from => from.albums('recent', 0, SHELF));
  const newest = useKept(`albums:newest:0:${SHELF}`, from => from.albums('newest', 0, SHELF));
  const frequent = useKept(`albums:frequent:0:${SHELF}`, from => from.albums('frequent', 0, SHELF));
  const playingAlbumId = usePlayer(s => current(s)?.albumId);

  const recentList = recent?.ok ? recent.value : [];
  const newestList = newest?.ok ? newest.value : [];
  const frequentList = frequent?.ok ? frequent.value : [];

  // Lead with the record played last; if that one is already on the deck, lead with the one before
  // it. With no history yet, lead with the newest arrival.
  const leadFromRecent = recentList.length > 0;
  const pool = leadFromRecent ? recentList : newestList;
  const lead = pool.length > 1 && pool[0].id === playingAlbumId ? pool[1] : pool[0] ?? null;
  const lately = recentList.filter(r => r.id !== lead?.id).slice(0, 6);
  const arrivals = leadFromRecent ? newestList : newestList.filter(r => r.id !== lead?.id);

  const showMost = !frequent || !frequent.ok || frequentList.length > 0;
  const showLately = !recent || !recent.ok || lately.length > 0;

  return <div className="home-page">
    {lead && <HomeLead album={lead} reason={leadFromRecent ? 'played last' : 'new arrival'} />}
    {(showMost || showLately) && <div className={`home-lower${showMost && showLately ? '' : ' single'}`}>
      {showMost && <section className="home-most" aria-labelledby="home-frequent" aria-busy={!frequent || undefined}>
        <div className="heading">
          <h2 id="home-frequent"><button type="button" className="heading-link" onClick={() => nav.go({ view: 'records', sort: 'frequent' })}>Most played</button></h2>
        </div>
        {!frequent ? <p className="status loading">Gathering your most played</p>
          : !frequent.ok ? <Status>{frequent.error}</Status>
          : <HomeRanks albums={frequentList.slice(0, 12)} />}
      </section>}
      {showLately && <section className="home-lately" aria-labelledby="home-recent" aria-busy={!recent || undefined}>
        <div className="heading">
          <h2 id="home-recent"><button type="button" className="heading-link" onClick={() => nav.go({ view: 'records', sort: 'recent' })}>Played lately</button></h2>
        </div>
        {!recent ? <p className="status loading">Checking what you played lately</p>
          : !recent.ok ? <Status>{recent.error}</Status>
          : <AlbumGrid albums={lately} cols={2} />}
      </section>}
    </div>}
    {(!newest || !newest.ok || arrivals.length > 0) && <>
      {(lead || showMost || showLately) && <SquiggleRule seed="home arrivals" className="home-break" />}
      <section className="home-new" aria-labelledby="home-newest" aria-busy={!newest || undefined}>
        <div className="heading">
          <h2 id="home-newest"><button type="button" className="heading-link" onClick={() => nav.go({ view: 'records' })}>New arrivals</button></h2>
        </div>
        {!newest ? <ShelfWaiting id="home-newest-wait" title="New arrivals" bare />
          : !newest.ok ? <Status>{newest.error}</Status>
          : <AlbumGrid albums={arrivals} cols={4} />}
      </section>
    </>}
    <HomeMixes />
    <Elsewhere />
  </div>;
}

function HomeLead({ album, reason }: { album: Album; reason: string }) {
  const firstRef = useRef<HTMLElement>(null);
  const sleeveRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const title = splitTitle(album.name);
  const facts = [album.year, album.songCount ? plural(album.songCount, 'song') : null, album.duration ? length(album.duration) : null, reason].filter(Boolean).join(', ');
  const open = (event: ReactMouseEvent<HTMLElement>) => { travel(album.id, event.currentTarget); nav.go({ view: 'album', id: album.id }); };
  const play = async () => { setBusy(true); try { await playTarget({ kind: 'album', album }); } finally { setBusy(false); } };
  return <div className="home-lead">
    <header ref={firstRef} className="home-first">
      <FitTitle sizes={[88]} wrapped={[88, 78, 68, 60, 52, 46, 40]} maxLines={3}
        maxHeightOf={() => ({ box: firstRef.current, limit: sleeveRef.current })} title={title.main}>
        <button type="button" className="heading-link" data-warm={`album:${album.id}`} onClick={open}>{title.main}</button>
      </FitTitle>
      {title.extra && <p className="display-tail">{title.extra}</p>}
      <p className="facts">
        <Credits text={album.artist} artistId={album.artistId} artists={album.artists} strong />
        <span className="home-facts">{facts}</span>
      </p>
      <div className="actions">
        <button type="button" className="play-action" disabled={busy} aria-label={`Play ${title.main}`} onClick={() => void play()}>
          <span className="disc"><Glyph kind="play" /></span><span className="action-label">Play</span>
        </button>
      </div>
    </header>
    <div ref={sleeveRef} className="home-sleeve">
      <button type="button" className="home-sleeve-btn" data-warm={`album:${album.id}`} title={album.name} onClick={open}
        onContextMenu={event => openMenu(event, { kind: 'album', album })}
        draggable={canDrag()} onDragStart={event => startDrag(event, { kind: 'album', album })}>
        <Cover id={album.coverArt} name={album.name} size={600} className={`home-art${album.id === morph.id ? ' morph' : ''}`} />
      </button>
    </div>
  </div>;
}

function HomeRanks({ albums }: { albums: Album[] }) {
  const drags = canDrag();
  return <ol className="home-ranks">
    {albums.map((album, i) => {
      const title = splitTitle(album.name);
      return <li key={album.id} className="home-rank playable">
        <PlayOver small label={title.main} play={() => playTarget({ kind: 'album', album })} />
        <span className="song-no">{i + 1}</span>
        <button type="button" className="home-rank-link" data-warm={`album:${album.id}`}
          onClick={event => { travel(album.id, event.currentTarget); nav.go({ view: 'album', id: album.id }); }}
          onContextMenu={event => openMenu(event, { kind: 'album', album })}
          draggable={drags} onDragStart={event => startDrag(event, { kind: 'album', album })}>
          <Cover id={album.coverArt} name={album.name} size={96} className="song-sleeve" />
          <span className="song-words">
            <span className="song-line">
              <span className="song-title">{title.main}{title.extra && <span className="song-tail"> {title.extra}</span>}</span>
              {album.playCount ? <><span className="song-lead" aria-hidden="true" /><span className="song-time">{plural(album.playCount, 'play')}</span></> : null}
            </span>
            <span className="song-by">{album.artist}</span>
          </span>
        </button>
      </li>;
    })}
  </ol>;
}

function SeeAll({ what, go }: { what: string; go(): void }) {
  return <button type="button" className="text-button" onClick={go}>See all<span className="sr-only"> {what}</span></button>;
}

const WAITING_SLEEVES = 4;
function ShelfWaiting({ id, title, bare = false }: { id: string; title: string; bare?: boolean }) {
  const grid = <ul className="grid shelf-cols" style={{ '--cols': 4 } as CSSProperties} aria-hidden="true">
    {Array.from({ length: WAITING_SLEEVES }, (_, i) => <li key={i}>
      <div className="cover" /><span className="grid-name">&nbsp;</span><span className="grid-sub">&nbsp;</span>
    </li>)}
  </ul>;
  if (bare) return grid;
  return <section className="shelf-section home-shelf" aria-labelledby={id} aria-busy="true">
    <div className="heading"><h2 id={id}>{title}</h2></div>
    {grid}
  </section>;
}

// The automatic playlists, as the Playlists page lists them.
function HomeMixes() {
  const genres = useKept('genres', from => from.genres());
  const history = useKept(`albums:frequent:0:${SHELF}`, from => from.albums('frequent', 0, SHELF));
  if (!genres || !history) return <ShelfWaiting id="home-mixes" title="Your mixes" />;
  const mixes = buildMixes(genres.ok ? genres.value : [], knownDecades(), history.ok && history.value.length > 0).slice(0, SHELF);
  return <section className="shelf-section home-shelf" aria-labelledby="home-mixes">
    <div className="heading"><h2 id="home-mixes"><button type="button" className="heading-link" onClick={() => nav.go({ view: 'mixes' })}>Your mixes</button></h2></div>
    <ul className="grid shelf-cols" style={{ '--cols': 4 } as CSSProperties}>
      {mixes.slice(0, 8).map(mix => <li key={mix.id} className="playable">
        <PlayOver label={mix.name} play={() => playMix(mix)} />
        <button type="button" onClick={event => { travel(mix.id, event.currentTarget); nav.go({ view: 'mix', id: mix.id }); }}>
          <MixTile mix={mix} travels={mix.id === morph.id} />
          <span className="sleeve-words">
            <span className="grid-name"><span>{mix.name}</span></span>
            <span className="grid-sub">{mix.description}</span>
          </span>
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
        {track.albumId ? <button type="button" className="link" data-warm={`album:${track.albumId}`} onClick={() => nav.go({ view: 'album', id: track.albumId! })}>{splitTitle(track.title, track.album).main}</button>
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
const FIRST_RESULT = '.tracks .track-play, .grid li > button:not(.play-over), .names li > button:not(.play-over)';
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

// All shows a few songs under the artists and records; See all has the rest.
const ALL_SONGS = 5;
const ALL_RECORDS = 6;
function SearchAll({ query }: { query: string }) {
  const result = useResource(`search:${query.toLowerCase()}`, () => api.search(query));
  return <Pending result={result} waiting="Searching">{({ artists, albums, tracks, capped }) => !artists.length && !albums.length && !tracks.length
    ? <Status>Nothing matches “{query}”.</Status>
    : <>
      {artists.length > 0 && <SearchGroup title="Artists" query={query} type="artists" more={capped.artists}><ArtistNames artists={artists} /></SearchGroup>}
      {albums.length > 0 && <SearchGroup title="Records" query={query} type="albums" more={capped.albums || albums.length > ALL_RECORDS}><AlbumGrid albums={albums.slice(0, ALL_RECORDS)} /></SearchGroup>}
      {tracks.length > 0 && <SearchGroup title="Songs" query={query} type="songs" more={capped.tracks || tracks.length > ALL_SONGS}><TrackTable tracks={tracks.slice(0, ALL_SONGS)} showAlbum /></SearchGroup>}
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
    {pages.items.length ? children(pages.items) : pages.done ? <Status>{none} “{query}”.</Status>
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
  const stations = useKept('radioStations', from => from.radioStations());
  return <section className="shelf-section" aria-labelledby="stations">
    <h2 id="stations">Stations</h2>
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
    </ul> : <Status>No stations on your server.</Status>}</Pending>
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
  const genres = useKept('genres', from => from.genres());
  const history = useKept('albums:frequent:0:1', from => from.albums('frequent', 0, 1));
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
  return <Head title="Mixes" />;
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
