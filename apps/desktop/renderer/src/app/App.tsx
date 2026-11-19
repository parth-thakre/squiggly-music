import { ChevronLeft, ListMusic, MessageSquareQuote, PictureInPicture2, Search as SearchIcon } from 'lucide-react';
import { createContext, memo, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import type { Connection, Track } from '../../../../../packages/core/contracts';
import { current, currentEntry, optimisticVolume, outputDescription, player, usePlayer } from './player';
import { nav, useCanGoBack, useRoute, type Route } from './route';
import { DeckLyrics, Lyrics } from './lyrics';
import { ContextMenu, onMenuError, openMenu } from './menu';
import { Cover, Glyph, kHz, neutral, splitTitle, useNextCover, useNextCoverAsked } from './ui';
import { paletteStyle, Position, TransportButtons, useRoomPalette } from './transport';
import { FavoriteToggle, RepeatButton, ShuffleButton, SleepNote } from './transport';
import { asHex } from './palette';
import { following } from '../../../../../packages/core/playOrder';
import { isStation } from '../../../../../packages/core/stations';
import { resampledNote } from '../../../../../packages/core/sinks';
import { Credits } from './credits';
import { CommandPalette, keysFor, openPalette, PALETTE, shell, useCommandKeys, useKeymap } from './commands';
import { ExtensionNotices, ExtensionPage } from './extensions';
import { DeckSlots } from './extensions';
import { useSwipeSongs } from './swipe';
import { RatingStars } from './ratings';
import { CoverScreen } from './CoverScreen';
import { useCoverScreen } from './nowPlaying';
import { AlbumPage, ArtistPage, Artists, DiagnosticsView, Favorites, LyricsPage, MixPage, PlaylistPage, Playlists, Queue, Records, Search, SettingsView, Tracks } from './views';
import { GenrePage, Genres, Mixes } from './views';
import { Home } from './views';
import { dropFocusRequest, focusFirstResult, rememberSearch } from './searches';
import { dropOnQueue, useDropTarget, useFileDrops, useSpringOpen } from './drag';
import { ShareDialog } from './share';
import { Kept, OfflineNotice } from './kept';
import { keptCount, keptSupported, useKeptVersion } from './keptState';
import { pageFor, serverPages } from './offline';
import { DiagnosticsSwitch, showDiagnosticsSetting } from './views';
import { diagnosticsBuilt, useSettings } from './settings';
import { formatTrackSpec } from './editorial';
import { startWarming } from './warm';

onMenuError(message => player.showError(message));

const sections: { view: 'records' | 'artists' | 'tracks' | 'playlists' | 'favorites' | 'genres'; label: string }[] = [
  { view: 'records', label: 'Records' }, { view: 'artists', label: 'Artists' }, { view: 'tracks', label: 'Tracks' },
  { view: 'playlists', label: 'Playlists' }, { view: 'favorites', label: 'Favorites' },
  { view: 'genres', label: 'Genres' },
];
const PaletteContext = createContext(neutral);
const sectionOf = (route: Route) => route.view === 'album' ? 'records' : route.view === 'artist' ? 'artists'
  : route.view === 'playlist' || route.view === 'mix' || route.view === 'mixes' || route.view === 'kept' ? 'playlists' : route.view === 'genre' ? 'genres' : route.view;

// App re-renders only when the connection or the playing record's sleeve changes. Position
// snapshots reach the deck's own subscribers, never the page.
export function App() {
  const mode = usePlayer(s => s.mode);
  const connected = usePlayer(s => s.connected);
  const access = usePlayer(s => s.access);
  const hasQueue = usePlayer(s => s.queue.length > 0);
  // The browser's connect screen, opened from Settings over the host's configured server.
  const choosing = usePlayer(s => s.choosingServer);
  // The room takes the colour of the record that is playing, unless the theme fixes its colours.
  const palette = useRoomPalette(usePlayer(s => current(s)?.coverArt ?? null));
  // At the deck's size (see Deck).
  useNextCover(usePlayer(s => s.queue[following(s.index, s.queue.length, s.repeat, 'skip')]?.coverArt ?? null), 600);
  useCommandKeys();
  useFileDrops();
  useEffect(startWarming, []);
  // On phones the status bar takes the room colour too.
  useEffect(() => { document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.ground); }, [palette.ground]);
  // Without a title bar, the window's own buttons take the room's ink, and its edges the ground.
  useEffect(() => { if (window.squiggly?.window.frameless) void window.squiggly.window.tintControls(asHex(palette.ink), asHex(palette.ground)); }, [palette.ink, palette.ground]);
  // While the server is away, coming back to the window or to the network asks it again (at most
  // every few seconds). The app never moves to another page on its own when the server goes.
  const away = usePlayer(s => s.reach.away);
  useEffect(() => {
    if (!away) return;
    const check = () => { if (document.visibilityState === 'visible') void player.retryServer(true); };
    addEventListener('online', check); addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => { removeEventListener('online', check); removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [away]);
  // Songs from this computer play without a server: the deck, queue, and settings stay usable.
  const shell = (connected && !choosing) || (mode === 'desktop' && hasQueue);
  const cover = useCoverScreen();
  return <PaletteContext.Provider value={palette}><div className="room" data-scheme={palette.scheme} data-accent={palette.neutralAccent ? 'neutral' : 'colour'} style={paletteStyle(palette)}>
    {/* First, so everything clickable after it wins: Electron applies drag regions in page order,
        and a later drag region would swallow the header's buttons where they overlap it. */}
    {window.squiggly?.window.frameless && <div className="drag-strip" aria-hidden="true" />}
    {shell && cover ? <CoverScreen palette={palette} /> : shell ? <>
      <Bar />
      <Deck />
      <main className="page" ref={nav.attach} tabIndex={-1}><View /></main>
    </> : access === 'checking' ? null : mode === 'web' && access === 'sign-in' ? <SignIn /> : <Connect />}
    <ContextMenu />
    <ExtensionNotices />
    <CommandPalette />
    <ShareDialog />
  </div></PaletteContext.Provider>;
}

// The mark: a short wave, the playhead tick, a dot.
function Mark() {
  return <svg className="mark" width="34" height="20" viewBox="0 0 34 20" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12.5C3.6 6.5 6.2 5.6 8 10.2s4 6.3 6 1.2S18 3.2 20.2 9.4" />
    <path d="M25.5 3.5v13" />
    <circle cx="31" cy="10" r="1.5" fill="currentColor" stroke="none" />
  </svg>;
}

const Bar = memo(function Bar() {
  const route = useRoute();
  const canGoBack = useCanGoBack();
  const [query, setQuery] = useState(route.view === 'search' ? route.query : '');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The search route this field last went to. Any other route change came from elsewhere
  // (Back, a section, a link): the field shows that route's query and a pending search is dropped.
  const own = useRef<Route | null>(null);
  useEffect(() => {
    if (route === own.current) return;
    // The empty search page arriving (its key, pressed) while the listener is already typing: the
    // page draws a moment after the field takes the keys, and must not wipe them.
    if (route.view === 'search' && !route.query && document.activeElement?.classList.contains('search')) return;
    clearTimeout(timer.current);
    setQuery(route.view === 'search' ? route.query : '');
    // Enter's wait for a first result ends when the search is left.
    if (route.view !== 'search') dropFocusRequest();
  }, [route]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // On the search page a new query replaces the place and keeps its tab.
  const search = (value: string) => {
    const target: Route = { view: 'search', query: value, ...(route.view === 'search' && route.type ? { type: route.type } : {}) };
    own.current = target; nav.go(target, route.view === 'search');
  };
  const active = sectionOf(route);
  return <header className="bar">
    <div className="bar-top">
    {/* The wordmark goes home, as a site's logo does. */}
    <button type="button" className="wordmark" aria-label="Squiggly home" aria-current={route.view === 'home' ? 'page' : undefined}
      onClick={() => nav.go({ view: 'home' })}><Mark />Squiggly</button>
    {canGoBack && <button type="button" className="text-button back" aria-label="Back" title="Back" onClick={() => nav.back()}><ChevronLeft aria-hidden="true" /><span className="back-word">Back</span></button>}
    <label className="search-field"><SearchIcon aria-hidden="true" />
    <input className="search" type="search" placeholder="Find anything" aria-label="Search your library" value={query}
      onChange={event => {
        const value = event.target.value; setQuery(value);
        clearTimeout(timer.current); dropFocusRequest();
        // Emptied on the search page, the field stays there and the page shows recent searches.
        timer.current = setTimeout(() => { if (value.trim() || route.view === 'search') search(value); }, 250);
      }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        // Enter searches at once, remembers the search, and moves to its first result.
        if (event.key === 'Enter' && query.trim()) {
          event.preventDefault(); clearTimeout(timer.current);
          search(query); rememberSearch(query); focusFirstResult(query);
        }
        // Escape empties the field and leaves the search for the page before it.
        if (event.key === 'Escape' && (query || route.view === 'search')) {
          event.preventDefault(); clearTimeout(timer.current); dropFocusRequest();
          setQuery('');
          if (route.view === 'search') { if (canGoBack) nav.back(); else nav.go({ view: 'records' }, true); }
        }
      }} /></label>
    {/* Phones have no Ctrl+K; the palette opens from here. */}
    <button type="button" className="text-button bar-commands" onClick={openPalette}>Commands</button>
    </div>
    {/* On phones this row moves to the bottom of the screen, under the thumb. */}
    <nav className="sections" aria-label="Library">
      {sections.map(s => <SectionButton key={s.view} view={s.view} label={s.label} current={active === s.view} />)}
    </nav>
  </header>;
});

// A drag held over a section opens it, so what it carries can reach that section's pages.
function SectionButton({ view, label, current }: { view: (typeof sections)[number]['view']; label: string; current: boolean }) {
  const spring = useSpringOpen(() => { if (nav.current.view !== view) nav.go({ view }); });
  return <button type="button" aria-current={current ? 'page' : undefined} onClick={() => nav.go({ view })} {...spring}>{label}</button>;
}

// Memoized with no props: only a route change (or the connection) re-renders the page.
const View = memo(function View() {
  const route = useRoute();
  const connected = usePlayer(s => s.connected);
  const away = usePlayer(s => s.reach.away);
  if (!connected && serverPages.has(route.view)) return <Connect embedded />;
  // Away: Home is what is kept, and pages that need the server say it's out of reach.
  const page = pageFor(route, away, keptSupported);
  if (page === 'kept') return <Kept />;
  if (page === 'notice') return <OfflineNotice />;
  switch (route.view) {
    case 'records': return <Records />;
    case 'artists': return <Artists />;
    case 'tracks': return <Tracks />;
    case 'playlists': return <Playlists />;
    case 'favorites': return <Favorites />;
    case 'album': return <AlbumPage key={route.id} id={route.id} />;
    case 'artist': return <ArtistPage key={route.id} id={route.id} />;
    case 'playlist': return <PlaylistPage key={route.id} id={route.id} />;
    case 'mix': return <MixPage key={route.id} id={route.id} />;
    case 'search': return <Search query={route.query} type={route.type} />;
    case 'queue': return <Queue />;
    case 'lyrics': return <LyricsPage />;
    case 'settings': return <SettingsView />;
    case 'diagnostics': return <DiagnosticsView />;
    case 'extension': return <ExtensionPage key={route.id} id={route.id} />;
    case 'genres': return <Genres />;
    case 'genre': return <GenrePage key={route.name} name={route.name} />;
    case 'home': return <Home />;
    case 'mixes': return <Mixes />;
    case 'kept': return <Kept />;
  }
});

// The deck: whatever is on the platter, always in view. It re-renders for a new song, play
// and pause, errors, and radio; the position lives in DeckPosition alone.
const Deck = memo(function Deck() {
  const track = usePlayer(current);
  const away = usePlayer(s => s.reach.away);
  const playing = usePlayer(s => s.playing);
  // What Next plays: the first song after the last one under repeat all.
  const upNext = usePlayer(s => s.queue[following(s.index, s.queue.length, s.repeat, 'skip')] as Track | undefined);
  // Its sleeve shows once it has been fetched ahead (useNextCover), at the size the deck will use.
  const nextAsked = useNextCoverAsked(upNext?.coverArt);
  const error = usePlayer(s => s.error);
  const engine = usePlayer(s => s.engine);
  const radio = usePlayer(s => s.radio);
  const starting = usePlayer(s => s.radioStarting);
  // Autoplay asked about the last song, playing now, and found nothing new to follow it.
  const autoplayOn = useSettings().autoplay;
  const missed = usePlayer(s => s.index === s.queue.length - 1 && s.autoplay.missed !== null && s.autoplay.missed === s.entryIds[s.index]) && autoplayOn;
  // A station's byline: what it says is on, when it says (see useByline).
  const announced = usePlayer(s => s.stationTitle);
  const [expanded, setExpanded] = useState(false);
  const [sheetLyrics, setSheetLyrics] = useState(false);
  const route = useRoute();
  const palette = useContext(PaletteContext);
  const entry = usePlayer(currentEntry);
  const deck = useRef<HTMLElement>(null);
  useSwipeSongs(deck, entry ?? track?.id);
  // Folding to the cover screen unmounts the deck; its open sheet's history entry goes with it.
  useEffect(() => { if (expanded) return () => nav.closeOverlay(); }, [expanded]);
  // Nothing on the platter: the saved queue's song where there is one (the one place it's
  // offered), else a line saying how to start. No empty sleeve.
  if (!track) return <aside className="deck deck-idle" aria-label="Now playing">
    {starting ? <p className="deck-empty" role="status">Finding songs like {starting}…</p>
      : <Resume fallback={<p className="deck-empty">Nothing playing.</p>} />}
    {engine === 'unavailable' || engine === 'crashed' ? <EngineError /> : error && <DeckError message={error} />}
    <DeckLinks />
  </aside>;
  const name = splitTitle(track.title, track.album);
  // Phones show a strip; tapping it opens the full deck as a sheet the back gesture closes.
  const open = () => nav.openOverlay(() => setExpanded(true), () => setExpanded(false));
  shell.openNowPlaying = expanded ? null : open;
  const toggleLyrics = () => route.view === 'lyrics' ? nav.back() : nav.go({ view: 'lyrics' });
  return <aside ref={deck} className={`deck${expanded ? ' open' : ''}${expanded && sheetLyrics ? ' lyrics-open' : ''}`} aria-label="Now playing"
    onContextMenu={event => { if (!(event.target as HTMLElement).closest('input, select')) openMenu(event, { kind: 'tracks', tracks: [track] }); }}>
    <div className="deck-top">
      <div className="deck-sheet-bar">
        <button type="button" className="deck-hide text-button" onClick={() => nav.closeOverlay()}>Hide</button>
        <button type="button" className="deck-hide text-button" aria-pressed={sheetLyrics} onClick={() => setSheetLyrics(v => !v)}>{sheetLyrics ? 'Sleeve' : 'Lyrics'}</button>
      </div>
      {/* Keyed by song, so a new sleeve settles in rather than snapping. */}
      {expanded && sheetLyrics ? <Lyrics compact />
        : track.albumId && !isStation(track)
          ? <button type="button" className="deck-sleeve-btn" aria-label={`Open ${splitTitle(track.album).main}`} data-warm={`album:${track.albumId}`} onClick={() => nav.go({ view: 'album', id: track.albumId! })}>
              <Cover key={track.id} id={track.coverArt} name={track.album || track.title} size={600} className="deck-cover" />
            </button>
          : <Cover key={track.id} id={track.coverArt} name={track.album || track.title} size={600} className="deck-cover" />}
    </div>
    <div className="deck-bottom">
      <div className="deck-text">
        <h2 className={`deck-title${name.main.length > 27 ? ' longer' : name.main.length > 20 ? ' long' : ''}`} title={name.main}>{name.main}{name.extra && <span className="deck-tail"> {name.extra}</span>}</h2>
        <p className="deck-sub">
          {isStation(track) ? announced ?? 'Internet radio' : <>
            <span className="deck-artists"><Credits text={track.artist} artistId={track.artistId} artists={track.artists} /></span>
            {track.album && <span className="deck-album">
              <span className="deck-on">{' on '}</span>
              {track.albumId ? <button type="button" className="link" data-warm={`album:${track.albumId}`} onClick={() => nav.go({ view: 'album', id: track.albumId! })}>{splitTitle(track.album).main}</button> : splitTitle(track.album).main}
            </span>}
          </>}
        </p>
        <DeckSlots placement="under-title" track={track} />
      </div>
      <button type="button" className="deck-open" aria-label={`Open now playing: ${name.main}`} onClick={open} />
      <Position track={track} palette={palette} />
      <div className="transport">
        <ShuffleButton />
        <TransportButtons playing={playing} />
        <RepeatButton />
        <Volume />
      </div>
      {/* What the page shows next to the deck: Lyrics, Queue, Mini player, plus inline rating and heart. */}
      <div className="deck-actions">
        <button type="button" className="icon-button labelled" aria-label="Lyrics" title="Lyrics" aria-pressed={route.view === 'lyrics'} aria-current={route.view === 'lyrics' ? 'page' : undefined} onClick={toggleLyrics}><MessageSquareQuote aria-hidden="true" /><span className="icon-label" aria-hidden="true">Lyrics</span></button>
        <QueueToggle open={route.view === 'queue'} />
        {window.squiggly && <button type="button" className="icon-button" aria-label="Mini player" title="Mini player" onClick={() => void window.squiggly!.window.toggleMini()}><PictureInPicture2 aria-hidden="true" /></button>}
        <span className="deck-set">
          {track.source === 'navidrome' && !away && <RatingStars target="track" id={track.id} rating={track.userRating} name={track.title} className="deck-rating" />}
          <FavoriteToggle track={track} />
        </span>
      </div>
      <DeckSlots placement="under-controls" track={track} />
      <div className="deck-foot">
        <DeckLyrics />
        {/* The next song: compact sleeve, title, artist. Label stays screen-reader accessible. */}
        {upNext && <p className="up-next"><span className="up-next-label">Next: </span><button type="button" className="link next-song" onClick={() => nav.go({ view: 'queue' })}>
          {!upNext.coverArt || nextAsked || upNext.coverArt === track.coverArt
            ? <Cover id={upNext.coverArt} name={upNext.album || upNext.title} size={upNext.coverArt ? 600 : 80} /> : <span className="cover" />}
          <span className="next-text"><span className="next-title">{splitTitle(upNext.title).main}</span>{!isStation(upNext) && upNext.artist && <span className="next-artist">{upNext.artist}</span>}</span>
        </button></p>}
        {!upNext && missed && <p className="up-next">Autoplay found nothing new like this song.</p>}
        {starting ? <p className="up-next" role="status">Finding songs like {starting}…</p>
          : radio && <p className="up-next">Radio from {radio.label}. <button type="button" className="link" onClick={player.stopRadio}>Stop</button></p>}
        <SignalPath track={track} />
        <DeckSlots placement="quiet-line" track={track} />
        <SleepNote />
        {engine === 'unavailable' || engine === 'crashed' ? <EngineError /> : error && <DeckError message={error} />}
        <DeckLinks />
      </div>
    </div>
  </aside>;
});

// Records, artists, songs, and playlists dropped on it join the end of the queue. Held over it,
// a drag opens the queue, to be dropped between its songs.
function QueueToggle({ open }: { open: boolean }) {
  const { over, handlers } = useDropTarget(payload => void dropOnQueue(payload));
  const spring = useSpringOpen(() => { if (nav.current.view !== 'queue') nav.go({ view: 'queue' }); });
  return <button type="button" className={`icon-button labelled${over ? ' drop-over' : ''}`} aria-label="Queue" title="Queue" aria-pressed={open} aria-current={open ? 'page' : undefined}
    onClick={() => open ? nav.back() : nav.go({ view: 'queue' })} {...handlers}
    onDragEnter={event => { handlers.onDragEnter(event); spring.onDragEnter(event); }}
    onDragLeave={event => { handlers.onDragLeave(event); spring.onDragLeave(event); }}><ListMusic aria-hidden="true" /><span className="icon-label" aria-hidden="true">Queue</span></button>;
}

// A downloaded update, or a newer release for a copy that can't update itself. Shown under the
// deck, and on the connect screen, which has no deck.
function UpdateLink() {
  const update = usePlayer(s => s.update);
  if (update?.status === 'ready') return <button type="button" className="quiet-link update-link" onClick={() => void window.squiggly!.updates.install()}>Restart to update to {update.version}</button>;
  if (update?.status === 'available') return <button type="button" className="quiet-link update-link" onClick={() => void window.squiggly!.updates.open()}>Squiggly {update.version} is out</button>;
  return null;
}
// Desktop betas with remote diagnostics built in say so, under the deck and on the connect
// screen. Under the deck it opens the switch in Settings; the connect screen has no Settings,
// so there it shows the switch in place.
function BetaMarker({ inPlace = false }: { inPlace?: boolean }) {
  const on = useSettings().diagnostics;
  const [open, setOpen] = useState(false);
  if (!diagnosticsBuilt) return null;
  const label = on ? 'Beta · sends diagnostics' : 'Beta · diagnostics off';
  if (!inPlace) return <button type="button" className="quiet-link beta-link" onClick={showDiagnosticsSetting}>{label}</button>;
  return <div className="connect-beta">
    <button type="button" className="quiet-link beta-link" aria-expanded={open} onClick={() => setOpen(value => !value)}>{label}</button>
    {open && <DiagnosticsSwitch />}
  </div>;
}
// Opening files from this computer lives here rather than in the header, which has to leave
// room for the window's buttons.
const openFiles = async () => { const result = await window.squiggly!.openFiles(); if (!result.ok) player.showError(result.error); };
function DeckLinks() {
  // The browser's own connection; one the host was started with isn't the page's to drop.
  const pageConnection = usePlayer(s => s.mode === 'web' && s.connected && s.pageConnection);
  const mode = usePlayer(s => s.mode);
  const key = keysFor(useKeymap().keymap, PALETTE)[0];
  const here = useRoute().view;
  return <p className="deck-links">
    <UpdateLink />
    <BetaMarker />
    <button type="button" className="quiet-link commands-link" title={key ? `Commands (${key.join(' then ')})` : undefined} onClick={openPalette}>Commands</button>
    <button type="button" className="quiet-link" aria-current={here === 'settings' ? 'page' : undefined} onClick={() => nav.go({ view: 'settings' })}>Settings</button>
    <button type="button" className="quiet-link" aria-current={here === 'diagnostics' ? 'page' : undefined} onClick={() => nav.go({ view: 'diagnostics' })}>Diagnostics</button>
    {mode === 'desktop' && <button type="button" className="quiet-link" onClick={() => void openFiles()}>Open files</button>}
    {pageConnection && <button type="button" className="quiet-link" onClick={() => void player.disconnect().then(result => { if (!result.ok) player.showError(result.error); })}>Disconnect</button>}
  </p>;
}
// A queue saved on the server (maybe from another device), offered once when nothing plays: its
// song sits on the deck as a playing one would, with Resume and Not now.
function Resume({ fallback }: { fallback: ReactNode }) {
  const saved = usePlayer(s => s.resumable);
  const track = saved?.tracks[saved.currentIndex];
  if (!saved || !track) return fallback;
  const minutes = Math.floor(saved.positionSeconds / 60), seconds = Math.floor(saved.positionSeconds % 60);
  return <>
    <Cover key={track.id} id={track.coverArt} name={track.album || track.title} size={600} className="deck-cover resume-cover" />
    <div className="resume">
      <p className="resume-label">Pick up where you left off</p>
      <h2 className="deck-title">{splitTitle(track.title, track.album).main}</h2>
      <p className="deck-sub">{track.artist}, at {minutes}:{String(seconds).padStart(2, '0')}{saved.changedBy ? `, from ${saved.changedBy}` : ''}</p>
      <p className="resume-actions">
        <button type="button" className="play-action" onClick={() => void player.resume()}><span className="disc"><Glyph kind="play" /></span>Resume</button>
        <button type="button" className="text-button" onClick={player.dismissResume}>Not now</button>
      </p>
    </div>
  </>;
}

function DeckError({ message }: { message: string }) {
  return <p className="deck-error" role="alert">{message} <button type="button" className="link" onClick={player.dismissError}>Dismiss</button></p>;
}
function EngineError() {
  const error = usePlayer(s => s.error);
  return <p className="deck-error" role="alert">{error ?? 'The audio engine stopped.'}{' '}
    <button type="button" className="link" onClick={() => window.squiggly?.command({ type: 'restart' })}>Restart the audio engine</button></p>;
}

function Volume() {
  const confirmed = usePlayer(s => s.volume);
  const optimistic = useSyncExternalStore(listener => optimisticVolume?.subscribe(listener) ?? (() => {}), () => optimisticVolume?.value ?? null);
  useEffect(() => { optimisticVolume?.confirm(confirmed); }, [confirmed]);
  const value = Math.round(optimistic ?? confirmed);
  return <label className="volume">
    <Glyph kind="volume" />
    <input type="range" min="0" max="100" value={value} aria-label="Volume" style={{ '--fill': `${value}%` } as CSSProperties}
      onChange={event => player.volume(Number(event.target.value))}
      onPointerUp={event => player.volume(Number(event.currentTarget.value), true)}
      onKeyUp={event => player.volume(Number(event.currentTarget.value), true)} />
    <span className="figure">{value}%</span>
  </label>;
}

// The signal path: two stops on a line — what the file is, and what the player honestly knows
// about where it goes. Unknown stays unknown; a raw stream request never claims bit-perfect output.
function SignalPath({ track }: { track: Track }) {
  const volume = usePlayer(s => Math.round(s.volume));
  const mode = usePlayer(s => s.mode);
  const buffering = usePlayer(s => s.buffering);
  const delivery = usePlayer(s => s.delivery);
  const streamKbps = usePlayer(s => s.streamKbps);
  const audio = usePlayer(s => s.audio);
  const device = usePlayer(s => s.device);
  const resampled = usePlayer(s => resampledNote(s.audio?.sink));
  const format = formatTrackSpec(track);
  const notes = [
    delivery === 'mp3-fallback' && 'Playing a 320 kbps MP3.',
    delivery === 'reduced' && `Streaming a ${streamKbps} kbps MP3.`,
    delivery === 'device' && 'Playing the kept copy.',
    volume < 100 && `Volume at ${volume}%.`,
    resampled,
    buffering && delivery !== 'device' && 'Buffering.',
  ].filter(Boolean).join(' ');
  const decoded = [audio?.codec?.toUpperCase(), kHz(audio?.decoderRate)].filter(Boolean).join(', ');
  const live = mode === 'desktop' && decoded ? `Live stream, ${decoded}` : 'A live stream.';
  const fileLine = isStation(track) ? live : mode !== 'web' ? format : '';
  // The second stop on the desktop, when nothing above changed what plays: the device mpv was
  // asked for (the sound server can move the stream elsewhere, docs/audio.md), else the output
  // mpv uses, and that exclusive use was asked for, never that it was granted. A sink whose rate
  // matches says nothing here; Diagnostics says it.
  const asked = device !== 'auto' ? outputDescription(device) : null;
  const backend = backendName(audio?.outputBackend);
  const exclusive = audio?.exclusiveRequested === true;
  const desktopOut = mode !== 'desktop' || notes ? ''
    : asked ? `Asked for ${asked}${exclusive ? ', exclusive' : ''}`
    : backend ? (exclusive ? `${backend}, exclusive use requested` : backend)
    : exclusive ? 'Exclusive use requested' : '';
  const outLine = notes || desktopOut;
  if (!fileLine && !outLine) return null;
  const both = Boolean(fileLine && outLine);
  return <div className={`signal${both ? ' signal-two' : ''}`} role="group" aria-label="Signal path">
    {both && <svg className="signal-path" width="11" height="44" viewBox="0 0 11 44" fill="none" aria-hidden="true">
      <circle cx="5.5" cy="11" r="3.4" />
      <path d="M5.5 16v11.5" strokeLinecap="round" />
      <circle className="signal-out-dot" cx="5.5" cy="33" r="4" />
    </svg>}
    <p>
      {fileLine && <span className="signal-file">{fileLine}</span>}
      {both && <span className="sr-only">. </span>}
      {outLine && <span className={`signal-out${notes ? ' signal-notes' : ''}`}>{outLine}</span>}
    </p>
  </div>;
}

// mpv's audio output by the name the system gives it.
const backends: Record<string, string> = { pipewire: 'PipeWire', pulse: 'PulseAudio', alsa: 'ALSA', jack: 'JACK', wasapi: 'WASAPI', coreaudio: 'Core Audio', avfoundation: 'AVFoundation' };
const backendName = (backend: string | null | undefined) => backend ? backends[backend] ?? backend : null;

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
// The server login on every build. The desktop's main process, the Android bridge, or the
// browser build's host keeps it. Embedded, it stands in for a library page while songs from this
// computer play without a server.
function Connect({ embedded = false }: { embedded?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only plain HTTP answered the address: the sign-in, and the http:// address to use if they agree.
  const [plainHttp, setPlainHttp] = useState<{ connection: Connection; url: string } | null>(null);
  const android = window.squigglyAndroid?.session;
  const web = usePlayer(s => s.mode === 'web');
  // Opened over the host's configured server: it stays the host's, and the page can go back to it.
  const choosing = usePlayer(s => s.choosingServer);
  const serverName = usePlayer(s => s.serverName);
  const connect = async (connection: Connection) => {
    setBusy(true); setError(null); setPlainHttp(null);
    const result = await (window.squiggly ? window.squiggly.connect(connection) : android ? android.connect(connection) : player.connect(connection));
    setBusy(false);
    if (!result.ok) setError(result.error);
    else if (result.value.type === 'plain-http') setPlainHttp({ connection, url: result.value.url });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void connect({ url: String(data.get('url')), username: String(data.get('username')), password: String(data.get('password')) });
  };
  const retry = async () => {
    setBusy(true); setError(null);
    await android?.reconnect();
    setBusy(false);
  };
  const openFiles = async () => {
    setError(null);
    const result = await window.squiggly!.openFiles();
    if (!result.ok) setError(result.error);
  };
  const Frame = embedded ? 'section' : 'main';
  const { saved, canRemember, reconnecting, reconnectError } = usePlayer(s => s.signIn);
  if (reconnecting && saved) return <Frame className="connect">
    <h1>{embedded ? 'Connect to your library' : 'Squiggly'}</h1>
    <p>Connecting to {hostOf(saved.url)} as {saved.username}.</p>
  </Frame>;
  return <Frame className="connect">
    <h1>{embedded ? 'Connect to your library' : 'Squiggly'}</h1>
    {(!embedded || (web && choosing) || (!web && !canRemember)) && <p>{!embedded && 'Connect to your Navidrome server.'}{' '}
      {web ? choosing && 'Connecting stops playback and empties the queue.'
        : !canRemember && 'The password is kept for this session only.'}</p>}
    {reconnectError && saved && <p className="deck-error" role="alert">Couldn't reconnect to {hostOf(saved.url)}: {reconnectError}</p>}
    <KeptAccountNote />
    {/* The phone keeps the password encrypted, so a failed reconnect (offline, say) can try again without it. */}
    {reconnectError && saved && android && <button type="button" className="text-button" disabled={busy} onClick={() => void retry()}>Try {hostOf(saved.url)} again</button>}
    <form onSubmit={submit}>
      {/* Text rather than type="url", so an address without https:// is accepted; the app tries HTTPS, and asks before HTTP. */}
      <label>Server address<input name="url" type="text" inputMode="url" required placeholder="music.example.com" autoComplete="url"
        autoCapitalize="off" spellCheck={false} defaultValue={saved?.url} /></label>
      <label>Username<input name="username" required autoComplete="username" defaultValue={saved?.username} /></label>
      <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
      <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Connecting' : 'Connect'}</button>
      {error && <p className="deck-error" role="alert">{error}</p>}
      {/* Someone on the network could have blocked HTTPS to get the password sent in the clear, so plain HTTP is never used without asking. */}
      {plainHttp && <div className="connect-http" role="alert">
        <p>This server isn't using HTTPS. Your password would be sent unprotected.</p>
        <button type="button" className="text-button" disabled={busy} onClick={() => void connect({ ...plainHttp.connection, url: plainHttp.url })}>Continue</button>
        <button type="button" className="text-button quiet" disabled={busy} onClick={() => setPlainHttp(null)}>Cancel</button>
      </div>}
    </form>
    {choosing && <button type="button" className="text-button" disabled={busy} onClick={() => player.chooseServer(false)}>Back to {serverName ?? 'the host\'s server'}</button>}
    {!embedded && window.squiggly && <button type="button" className="text-button" onClick={() => void openFiles()}>Play files from this computer instead</button>}
    {/* Navidrome's own public demo, with Creative Commons music, for trying Squiggly without a server. */}
    <p className="connect-demo">No server yet? <button type="button" className="link" disabled={busy}
      onClick={() => void connect({ url: 'https://demo.navidrome.org', username: 'demo', password: 'demo' })}>Try Navidrome's demo</button>.</p>
    {!embedded && window.squiggly && <p className="connect-update"><UpdateLink /></p>}
    {!embedded && <BetaMarker inPlace />}
  </Frame>;
}

// Kept songs belong to one account; signing in to another forgets them.
function KeptAccountNote() {
  useKeptVersion();
  const count = keptCount();
  if (!keptSupported || !count) return null;
  return <p className="note">Signing in to another account forgets the {count.toLocaleString()} {count === 1 ? 'song' : 'songs'} kept here.</p>;
}

// The browser build's door: the host keeps a Navidrome account, and its password keeps
// everyone else on the network out of that account.
function SignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true); setError(null);
    const result = await player.signIn(String(new FormData(form).get('password')));
    setBusy(false);
    if (!result.ok) { setError(result.error); form.reset(); }
  };
  return <main className="connect">
    <h1>Squiggly</h1>
    <p>Enter this host's password.</p>
    <form onSubmit={submit}>
      <label>Password<input name="password" type="password" required autoComplete="current-password" autoFocus /></label>
      <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
      {error && <p className="deck-error" role="alert">{error}</p>}
    </form>
  </main>;
}
