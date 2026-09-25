import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Album, AlbumListType, Artist, Playlist, Result, Track } from '../../../../../packages/core/contracts';
import { api, invalidate, load, onLibraryReset, playlistEditor, useLibraryEpoch, usePlaylist, useResource, type PlaylistView } from './library';
import { buildMixes, libraryDecades, mixById, mixTracks, type Mix } from './mixes';
import { current, player, usePlayer } from './player';
import { isStarred, setStarred, useFavoritesVersion } from './favorites';
import { openMenu, tracksOf } from './menu';
import { morph, nav, useRoute } from './route';
import { updateSettings, useSettings, useSettingsError } from './settings';
import { Lyrics } from './lyrics';
import { TrackTable } from './TrackTable';
import { Cover, Glyph, length, plural, splitTitle, Status, Wave } from './ui';

// Tag the touched sleeve so it travels to the page it opens (see transition() in route.ts).
const travel = (id: string, target: EventTarget) => {
  morph.id = id;
  document.querySelectorAll('.morph').forEach(element => element.classList.remove('morph'));
  (target as HTMLElement).querySelector('.cover')?.classList.add('morph');
};
const shuffled = <T,>(items: T[]) => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
};
function Pending<T>({ result, children, waiting }: { result: Result<T> | undefined; children(value: T): ReactNode; waiting: string }) {
  if (!result) return <p className="status loading">{waiting}</p>;
  if (!result.ok) return <Status>{result.error}</Status>;
  return <>{children(result.value)}</>;
}

function Head({ title, qualifier, cover, children }: { title: string; qualifier?: string; cover?: ReactNode; children?: ReactNode }) {
  return <header className={`head${cover ? ' with-cover' : ''}`}>
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
    <button type="button" className="play-action" disabled={!tracks?.length} onClick={() => tracks && player.play(tracks, 0)}>
      <span className="disc"><Glyph kind="play" /></span>Play
    </button>
    <button type="button" className="text-button" disabled={!tracks?.length} onClick={() => tracks && player.play(shuffled(tracks), 0)}>Shuffle</button>
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

// Records ------------------------------------------------------------------------------

const sorts: { type: AlbumListType; label: string }[] = [
  { type: 'newest', label: 'Newest' }, { type: 'alphabeticalByName', label: 'A to Z' }, { type: 'alphabeticalByArtist', label: 'By artist' },
  { type: 'frequent', label: 'Most played' }, { type: 'recent', label: 'Recently played' }, { type: 'random', label: 'Random' },
];
const PAGE = 60;
// The pages loaded for each sort outlive the page itself, so coming Back renders the same
// records at once and the scroll offset has somewhere to land.
interface Paged { albums: Album[]; count: number; done: boolean; busy: boolean; error: string | null; seed: number }
const paged = new Map<AlbumListType, Paged>();
onLibraryReset(() => paged.clear());
function usePagedAlbums(type: AlbumListType) {
  const session = useLibraryEpoch();
  const [, redraw] = useState(0);
  const more = useCallback(() => {
    let p = paged.get(type);
    if (!p) { p = { albums: [], count: 0, done: false, busy: false, error: null, seed: Math.random() }; paged.set(type, p); }
    if (p.busy || p.done) return;
    const page = p;
    page.busy = true; page.error = null;
    const offset = page.count;
    const key = `albums:${type}:${offset}:${PAGE}${type === 'random' ? `:${page.seed}` : ''}`;
    void load(key, () => api.albums(type, offset, PAGE)).then(result => {
      page.busy = false;
      if (paged.get(type) !== page) return;
      if (!result.ok) page.error = result.error;
      else {
        page.count += result.value.length;
        const seen = new Set(page.albums.map(a => a.id));
        page.albums = [...page.albums, ...result.value.filter(a => !seen.has(a.id))];
        if (result.value.length < PAGE || type === 'random') page.done = true;
      }
      redraw(v => v + 1);
    });
    redraw(v => v + 1);
  }, [type]);
  useEffect(() => { const p = paged.get(type); if (!p || (!p.albums.length && !p.done && !p.busy)) more(); }, [more, session]);
  const p = paged.get(type);
  return { albums: p?.albums ?? none, done: p?.done ?? false, error: p?.error ?? null, more };
}
const none: Album[] = [];

export function Records() {
  const route = useRoute();
  const type = route.view === 'records' && route.sort ? route.sort : 'newest';
  const albums = usePagedAlbums(type);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => { if (entries[0].isIntersecting) albums.more(); }, { root: nav.scroller, rootMargin: '600px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [albums.more, albums.albums.length]);
  return <>
    <Head title="Records">
      <div className="choices" role="group" aria-label="Sort records">
        {sorts.map(sort => <button key={sort.type} type="button" aria-pressed={sort.type === type} onClick={() => {
          // Choosing Random again is asking for a new draw.
          if (sort.type === 'random' && type !== 'random') paged.delete('random');
          nav.go({ view: 'records', sort: sort.type }, true);
        }}>{sort.label}</button>)}
      </div>
    </Head>
    {albums.albums.length ? <AlbumGrid albums={albums.albums} /> : albums.done
      ? <Status>{type === 'frequent' || type === 'recent' ? 'Nothing played yet. Records you listen to will collect here.' : 'No records on this server yet.'}</Status>
      : albums.error ? <Status>{albums.error}</Status> : <p className="status loading">Opening your records</p>}
    {albums.error && albums.albums.length > 0 && <Status>{albums.error}</Status>}
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
  return <ul ref={list} className="grid" style={active ? { paddingTop: first * active.stride, paddingBottom: (rows - last) * active.stride } : undefined}>
    {shown.map(album => <li key={album.id}>
      <button type="button" onClick={event => { travel(album.id, event.currentTarget); nav.go({ view: 'album', id: album.id }); }}
        onContextMenu={event => openMenu(event, { kind: 'album', album })}>
        <Cover id={album.coverArt} name={album.name} size={300} className={album.id === morph.id ? 'morph' : undefined} />
        <span className="grid-name">{album.id === nowAlbum && <Wave playing={playing} />}<span>{splitTitle(album.name).main}</span></span>
        <span className="grid-sub">{album.artist}</span>
      </button>
    </li>)}
  </ul>;
}

// Album --------------------------------------------------------------------------------

export function AlbumPage({ id }: { id: string }) {
  const result = useResource(`album:${id}`, () => api.album(id));
  return <Pending result={result} waiting="Reading the tracklist">{({ album, tracks }) => {
    const title = splitTitle(album.name);
    const facts = [album.year, album.genre, plural(tracks.length, 'song'), length(tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0))].filter(Boolean).join(', ');
    return <>
      <Head title={title.main} qualifier={title.extra} cover={<Cover id={album.coverArt} name={album.name} size={600} className="head-cover" />}>
        <p className="byline">{album.artistId
          ? <button type="button" className="link" onClick={() => nav.go({ view: 'artist', id: album.artistId! })}>{album.artist}</button>
          : <strong>{album.artist}</strong>} <span>{facts}</span></p>
        <Actions tracks={tracks}>
          <button type="button" className="text-button" onClick={() => player.radio({ kind: 'album', id: album.id, label: title.main })}>Radio</button>
          <StarButton target="album" id={album.id} starred={album.starred} name={album.name} />
          <MoreButton target={{ kind: 'album', album }} />
        </Actions>
      </Head>
      <TrackTable tracks={tracks} album={album.name} albumArtist={album.artist} numbered="track" />
    </>;
  }}</Pending>;
}

function StarButton({ target, id, starred, name }: { target: 'album' | 'artist'; id: string; starred: boolean; name: string }) {
  useFavoritesVersion();
  const on = isStarred(id, starred);
  return <button type="button" className={`text-button star-text${on ? ' on' : ''}`} aria-pressed={on} onClick={() => void setStarred(target, [id], !on)}>
    <Glyph kind={on ? 'starred' : 'star'} />{on ? 'In favorites' : 'Add to favorites'}<span className="sr-only"> {name}</span></button>;
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
          {row.artists.map(artist => <li key={artist.id}>
            <button type="button" onClick={() => nav.go({ view: 'artist', id: artist.id })}
              onContextMenu={event => openMenu(event, { kind: 'artist', artist })}>
              <span className="artist-name">{artist.name}</span> <span>{artist.albumCount}</span>
            </button>
          </li>)}
        </ul>)}
    </div>
  </>;
}

export function ArtistPage({ id }: { id: string }) {
  const result = useResource(`artist:${id}`, () => api.artist(id));
  const top = useResource(`top:${id}`, () => api.topSongs(id, 10));
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
  };
  return <Pending result={result} waiting="Finding their records">{({ artist, albums }) => <>
    <Head title={artist.name}>
      <p className="byline"><span>{plural(albums.length, 'record')}</span></p>
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
    {top?.ok && top.value.length > 0 && <section className="shelf-section"><h2>Popular</h2><TrackTable tracks={top.value} showAlbum /></section>}
    <section className="shelf-section"><h2>Records</h2><AlbumGrid albums={albums} /></section>
  </>}</Pending>;
}

// Playlists ----------------------------------------------------------------------------

const decadesResult = () => libraryDecades().then((value): Result<number[]> => ({ ok: true, value }));
function playlistNote(playlist: Playlist) {
  if (playlist.comment?.startsWith('Auto-imported')) return 'Kept in sync with a playlist file on the server.';
  if (playlist.readonly) return 'Managed by the server.';
  return null;
}

export function Playlists() {
  const playlists = useResource('playlists', () => api.playlists());
  const genres = useResource('genres', () => api.genres());
  const decades = useResource('decades', decadesResult);
  const history = useResource('albums:frequent:0:1', () => api.albums('frequent', 0, 1));
  const mixes = useMemo(() => buildMixes(genres?.ok ? genres.value : [], decades?.ok ? decades.value : [], !!(history?.ok && history.value.length)),
    [genres, decades, history]);
  return <>
    <Head title="Playlists" />
    <section className="shelf-section" aria-labelledby="yours">
      <div className="section-head"><h2 id="yours">Yours</h2><NewPlaylist /></div>
      <Pending result={playlists} waiting="Loading playlists">{list => list.length ? <ul className="rows">
        {list.map(playlist => <li key={playlist.id}>
          <button type="button" onClick={event => { travel(playlist.id, event.currentTarget); nav.go({ view: 'playlist', id: playlist.id }); }}
            onContextMenu={event => openMenu(event, { kind: 'playlist', playlist })}>
            <Cover id={playlist.coverArt} name={playlist.name} size={160} className={playlist.id === morph.id ? 'morph' : undefined} />
            <span className="row-text">
              <span className="row-name">{splitTitle(playlist.name).main}</span>
              <span className="row-sub">{plural(playlist.songCount, 'song')}, {length(playlist.duration)}{playlistNote(playlist) && `. ${playlistNote(playlist)}`}</span>
            </span>
          </button>
        </li>)}
      </ul> : <Status>No playlists yet. Start one here, or save an automatic playlist below.</Status>}</Pending>
    </section>
    <section className="shelf-section" aria-labelledby="automatic">
      <h2 id="automatic">Automatic</h2>
      <p className="section-note">Drawn from your library each session. Save one to keep it as it is.</p>
      <ul className="rows">
        {mixes.map(mix => <li key={mix.id}>
          <button type="button" onClick={event => { travel(mix.id, event.currentTarget); nav.go({ view: 'mix', id: mix.id }); }}>
            <MixTile mix={mix} travels={mix.id === morph.id} />
            <span className="row-text"><span className="row-name">{mix.name}</span><span className="row-sub">{mix.description}</span></span>
          </button>
        </li>)}
      </ul>
    </section>
  </>;
}

function NewPlaylist() {
  const [naming, setNaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!naming) return <button type="button" className="text-button" onClick={() => setNaming(true)}>New playlist</button>;
  return <form className="inline-form" onSubmit={async event => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    if (!name) return;
    const created = await api.createPlaylist(name, []);
    if (!created.ok) { setError(created.error); return; }
    invalidate('playlists');
    nav.go({ view: 'playlist', id: created.value.id });
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
  return <>
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
      </Actions>
      {editable && tracks.length > 1 && <p className="note hint">Drag songs to reorder, or press Alt+Up and Alt+Down. Select with Ctrl or Shift and press Delete to remove.</p>}
      {view.error && <p className="note" role="alert">{view.error}</p>}
    </Head>
    {tracks.length ? <TrackTable tracks={tracks} showAlbum playlist={playlist}
      onMove={editable ? (from, to) => void editor.move(from, to) : undefined}
      onRemove={editable ? indexes => void editor.removeAt(indexes) : undefined} />
      : <Status>This playlist is empty. Right-click any song and choose Add to playlist.</Status>}
  </>;
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
          const created = await api.createPlaylist(`${mix.name}, ${date}`, tracks!.map(t => t.id));
          if (!created.ok) { setSaved(created.error); return; }
          invalidate('playlists');
          nav.go({ view: 'playlist', id: created.value.id });
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
  return <ul className="names">{artists.map(artist => <li key={artist.id}>
    <button type="button" onClick={() => nav.go({ view: 'artist', id: artist.id })}>{artist.name} <span>{artist.albumCount}</span></button>
  </li>)}</ul>;
}

export function Search({ query }: { query: string }) {
  const result = useResource(query.trim() ? `search:${query.trim().toLowerCase()}` : null, () => api.search(query.trim()));
  if (!query.trim()) return <Status>Type an artist, record, or song.</Status>;
  return <>
    <Head title={`“${query.trim()}”`} />
    <Pending result={result} waiting="Searching">{({ artists, albums, tracks }) => !artists.length && !albums.length && !tracks.length
      ? <Status>Nothing matches “{query.trim()}”. Check the spelling or try fewer words.</Status>
      : <>
        {tracks.length > 0 && <section className="shelf-section"><h2>Songs</h2><TrackTable tracks={tracks} showAlbum /></section>}
        {albums.length > 0 && <section className="shelf-section"><h2>Records</h2><AlbumGrid albums={albums} /></section>}
        {artists.length > 0 && <section className="shelf-section"><h2>Artists</h2><ArtistNames artists={artists} /></section>}
      </>}</Pending>
  </>;
}

export function Queue() {
  const queue = usePlayer(s => s.queue);
  const index = usePlayer(s => s.index);
  const radio = usePlayer(s => s.radio);
  const [saved, setSaved] = useState<string | null>(null);
  if (!queue.length) return <><Head title="Queue" /><Status>Nothing queued. Play a record, playlist, or song, or right-click one and choose Add to queue.</Status></>;
  const upcoming = queue.length - index - 1;
  return <>
    <Head title="Queue">
      <p className="byline"><span>{upcoming > 0 ? `${plural(upcoming, 'song')} up next, ${length(queue.slice(index + 1).reduce((sum, t) => sum + (t.duration ?? 0), 0))}` : 'This is the last song.'}</span></p>
      {radio && <p className="note">Radio from {radio.label}. Songs like these are added as you listen. <button type="button" className="link" onClick={player.stopRadio}>Stop radio</button></p>}
      <div className="actions">
        <button type="button" className="text-button" disabled={upcoming < 1} onClick={() => void player.clear()}>Clear up next</button>
        <button type="button" className="text-button" onClick={async () => {
          const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
          const created = await api.createPlaylist(`Queue, ${date}`, queue.filter(t => t.source === 'navidrome').map(t => t.id));
          if (!created.ok) { setSaved(created.error); return; }
          invalidate('playlists'); nav.go({ view: 'playlist', id: created.value.id });
        }}>Save as playlist</button>
      </div>
      {saved && <p className="note" role="alert">{saved}</p>}
      <p className="note hint">Drag to reorder, or press Alt+Up and Alt+Down. Select with Ctrl or Shift and press Delete to remove.</p>
    </Head>
    <TrackTable tracks={queue} showAlbum queue onPick={(i, entry) => player.jump(i, entry)} onMove={(from, to) => void player.move(from, to)} onRemove={indexes => void player.remove(indexes)} />
  </>;
}

export function LyricsPage() {
  return <Lyrics />;
}

export function SettingsView() {
  const settings = useSettings();
  const error = useSettingsError();
  const mode = usePlayer(s => s.mode);
  const row = (key: keyof typeof settings, title: string, detail: string) => <label className="setting">
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
      {mode === 'desktop' && <>
        <h2>Sound</h2>
        {row('exclusiveOutput', 'Exclusive output', 'Ask the output device for exclusive use so the system mixer does not resample or mix. Other apps go quiet while Squiggly plays. Windows supports this; many Linux setups ignore it.')}
        <h2>Window</h2>
        {row('closeToTray', 'Keep playing when the window closes', 'Closing the window leaves Squiggly in the tray. Quit from the tray menu.')}
        {row('miniOnTop', 'Keep the mini player on top', 'The mini player stays above other windows.')}
      </>}
      {error && <p className="note" role="alert">{error}</p>}
    </section>
  </>;
}

export function DiagnosticsView() {
  const diagnostics = usePlayer(s => s.diagnostics);
  const mode = usePlayer(s => s.mode);
  const [message, setMessage] = useState<string | null>(null);
  if (mode === 'web') return <><Head title="Diagnostics" /><Status>Process and memory figures come from the desktop app. The browser version has none to show.</Status></>;
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
    </tbody></table>
  </>;
}
