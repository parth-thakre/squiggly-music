import { ListMusic, MessageSquareQuote, PictureInPicture2 } from 'lucide-react';
import { createContext, memo, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react';
import type { Track } from '../../../../../packages/core/contracts';
import { current, currentEntry, optimisticVolume, player, usePlayer } from './player';
import { nav, useCanGoBack, useRoute, type Route } from './route';
import { Lyrics } from './lyrics';
import { ContextMenu, onMenuError, openMenu } from './menu';
import { Cover, Glyph, kHz, neutral, splitTitle } from './ui';
import { paletteStyle, Position, TransportButtons, useRoomPalette } from './transport';
import { FavoriteToggle, PlayModes, SleepNote } from './transport';
import { following } from '../../../../../packages/core/playOrder';
import { Credits } from './credits';
import { CommandPalette, keysFor, openPalette, PALETTE, shell, useCommandKeys, useKeymap } from './commands';
import { ExtensionNotices, ExtensionPage } from './extensions';
import { useSwipeSongs } from './swipe';
import { CoverScreen } from './CoverScreen';
import { useCoverScreen } from './nowPlaying';
import { AlbumPage, ArtistPage, Artists, DiagnosticsView, Favorites, LyricsPage, MixPage, PlaylistPage, Playlists, Queue, Records, Search, SettingsView, Tracks } from './views';
import { GenrePage, Genres } from './views';
import { Home } from './views';

onMenuError(message => player.showError(message));

const sections: { view: 'records' | 'artists' | 'tracks' | 'playlists' | 'favorites' | 'genres'; label: string }[] = [
  { view: 'records', label: 'Records' }, { view: 'artists', label: 'Artists' }, { view: 'tracks', label: 'Tracks' },
  { view: 'playlists', label: 'Playlists' }, { view: 'favorites', label: 'Favorites' },
  { view: 'genres', label: 'Genres' },
];
// Places that need the server. Without one, they offer to connect instead.
const library = new Set<Route['view']>(['records', 'artists', 'tracks', 'playlists', 'favorites', 'album', 'artist', 'playlist', 'mix', 'search', 'genres', 'genre', 'home']);
const PaletteContext = createContext(neutral);
const sectionOf = (route: Route) => route.view === 'album' ? 'records' : route.view === 'artist' ? 'artists'
  : route.view === 'playlist' || route.view === 'mix' ? 'playlists' : route.view === 'genre' ? 'genres' : route.view;

// App re-renders only when the connection or the playing record's sleeve changes. Position
// snapshots reach the deck's own subscribers, never the page.
export function App() {
  const mode = usePlayer(s => s.mode);
  const connected = usePlayer(s => s.connected);
  const access = usePlayer(s => s.access);
  const hasQueue = usePlayer(s => s.queue.length > 0);
  // The room takes the colour of the record that is playing, unless the theme fixes its colours.
  const palette = useRoomPalette(usePlayer(s => current(s)?.coverArt ?? null));
  useCommandKeys();
  // On phones the status bar takes the room colour too.
  useEffect(() => { document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.ground); }, [palette.ground]);
  // Without a title bar, the window's own buttons take the room's ink.
  useEffect(() => { if (window.squiggly?.window.frameless) void window.squiggly.window.tintControls(asHex(palette.ink)); }, [palette.ink]);
  // Songs from this computer play without a server: the deck, queue, and settings stay usable.
  const shell = connected || (mode === 'desktop' && hasQueue);
  const cover = useCoverScreen();
  return <PaletteContext.Provider value={palette}><div className="room" style={paletteStyle(palette)}>
    {/* First, so everything clickable after it wins: Electron applies drag regions in page order,
        and a later drag region would swallow the header's buttons where they overlap it. */}
    {window.squiggly?.window.frameless && <div className="drag-strip" aria-hidden="true" />}
    {shell && cover ? <CoverScreen palette={palette} /> : shell ? <>
      <Bar />
      <Deck />
      <main className="page" ref={nav.attach} tabIndex={-1}><View /></main>
    </> : access === 'checking' ? null : mode === 'web' ? <SignIn /> : <Connect />}
    <ContextMenu />
    <ExtensionNotices />
    <CommandPalette />
  </div></PaletteContext.Provider>;
}

// The mark: the app's own seek bar. Played squiggle, the thumb, the unplayed rest.
function Mark() {
  return <svg className="mark" viewBox="79 170 355 172" aria-hidden="true">
    <path d="M96.0 256.0 L98.8 250.3 L101.7 244.6 L104.5 239.2 L107.3 234.0 L110.2 229.2 L113.0 224.9 L115.8 221.1 L118.7 217.9 L121.5 215.3 L124.3 213.5 L127.2 212.4 L130.0 212.0 L132.8 212.4 L135.7 213.5 L138.5 215.3 L141.3 217.9 L144.2 221.1 L147.0 224.9 L149.8 229.2 L152.7 234.0 L155.5 239.2 L158.3 244.6 L161.2 250.3 L164.0 256.0 L166.8 261.7 L169.7 267.4 L172.5 272.8 L175.3 278.0 L178.2 282.8 L181.0 287.1 L183.8 290.9 L186.7 294.1 L189.5 296.7 L192.3 298.5 L195.2 299.6 L198.0 300.0 L200.8 299.6 L203.7 298.5 L206.5 296.7 L209.3 294.1 L212.2 290.9 L215.0 287.1 L217.8 282.8 L220.7 278.0 L223.5 272.8 L226.3 267.4 L229.2 261.7 L232.0 256.0 L234.8 250.3 L237.7 244.6 L240.5 239.2 L243.3 234.0 L246.2 229.2 L249.0 224.9 L251.8 221.1 L254.7 217.9 L257.5 215.3 L260.3 213.5 L263.2 212.4 L266.0 212.0 L268.8 212.4 L271.7 213.5 L274.5 215.3 L277.3 217.9 L280.2 221.1 L283.0 224.9 L285.8 229.2 L288.7 234.0 L291.5 239.2 L294.3 244.6 L297.2 250.3 L300.0 256.0" fill="none" stroke="currentColor" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round"/>
    <rect x="336" y="170" width="34" height="172" rx="17" fill="currentColor"/>
    <path d="M404 256 H428" stroke="currentColor" strokeOpacity=".35" strokeWidth="12" strokeLinecap="round"/>
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
    clearTimeout(timer.current);
    setQuery(route.view === 'search' ? route.query : '');
  }, [route]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const active = sectionOf(route);
  return <header className="bar">
    <div className="bar-top">
    {/* The wordmark goes home, as a site's logo does. */}
    <button type="button" className="wordmark" aria-label="Squiggly home" aria-current={route.view === 'home' ? 'page' : undefined}
      onClick={() => nav.go({ view: 'home' })}><Mark />Squiggly</button>
    {canGoBack && <button type="button" className="text-button back" onClick={() => nav.back()}>Back</button>}
    <input className="search" type="search" placeholder="Find anything" aria-label="Search your library" value={query}
      onChange={event => {
        const value = event.target.value; setQuery(value);
        clearTimeout(timer.current);
        const replace = route.view === 'search';
        timer.current = setTimeout(() => {
          if (value.trim()) { const target: Route = { view: 'search', query: value }; own.current = target; nav.go(target, replace); }
          else if (replace) nav.back();
        }, 250);
      }} />
    {/* Phones have no Ctrl+K; the palette opens from here. */}
    <button type="button" className="text-button bar-commands" onClick={openPalette}>Commands</button>
    </div>
    {/* On phones this row moves to the bottom of the screen, under the thumb. */}
    <nav className="sections" aria-label="Library">
      {sections.map(s => <button key={s.view} type="button" aria-current={active === s.view ? 'page' : undefined}
        onClick={() => nav.go({ view: s.view })}>{s.label}</button>)}
    </nav>
  </header>;
});

// Memoized with no props: only a route change (or the connection) re-renders the page.
const View = memo(function View() {
  const route = useRoute();
  const connected = usePlayer(s => s.connected);
  if (!connected && library.has(route.view)) return <Connect embedded />;
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
    case 'search': return <Search query={route.query} />;
    case 'queue': return <Queue />;
    case 'lyrics': return <LyricsPage />;
    case 'settings': return <SettingsView />;
    case 'diagnostics': return <DiagnosticsView />;
    case 'extension': return <ExtensionPage key={route.id} id={route.id} />;
    case 'genres': return <Genres />;
    case 'genre': return <GenrePage key={route.name} name={route.name} />;
    case 'home': return <Home />;
  }
});

// The deck: whatever is on the platter, always in view. It re-renders for a new song, play
// and pause, errors, and radio; the position lives in DeckPosition alone.
const Deck = memo(function Deck() {
  const track = usePlayer(current);
  const playing = usePlayer(s => s.playing);
  // What Next plays: the first song after the last one under repeat all.
  const upNext = usePlayer(s => s.queue[following(s.index, s.queue.length, s.repeat, 'skip')] as Track | undefined);
  const error = usePlayer(s => s.error);
  const engine = usePlayer(s => s.engine);
  const radio = usePlayer(s => s.radio);
  const starting = usePlayer(s => s.radioStarting);
  const [expanded, setExpanded] = useState(false);
  const [sheetLyrics, setSheetLyrics] = useState(false);
  const route = useRoute();
  const palette = useContext(PaletteContext);
  const entry = usePlayer(currentEntry);
  const deck = useRef<HTMLElement>(null);
  useSwipeSongs(deck, entry ?? track?.id);
  // Folding to the cover screen unmounts the deck; its open sheet's history entry goes with it.
  useEffect(() => { if (expanded) return () => nav.closeOverlay(); }, [expanded]);
  if (!track) return <aside className="deck" aria-label="Now playing">
    <div className="cover cover-empty" aria-hidden="true" />
    {starting ? <p className="deck-empty" role="status">Finding songs like {starting}…</p>
      : <p className="deck-empty">Pick a record, playlist, or song to start.</p>}
    <Resume />
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
      {expanded && sheetLyrics ? <Lyrics compact /> : <Cover key={track.id} id={track.coverArt} name={track.album} size={600} className="deck-cover" />}
    </div>
    <div className="deck-bottom">
      <div className="deck-text">
        <h2 className="deck-title">{name.main}</h2>
        <p className="deck-sub">
          <Credits text={track.artist} artistId={track.artistId} artists={track.artists} />
          {track.album && <>
            {' on '}
            {track.albumId ? <button type="button" className="link" onClick={() => nav.go({ view: 'album', id: track.albumId! })}>{splitTitle(track.album).main}</button> : splitTitle(track.album).main}
          </>}
        </p>
      </div>
      <button type="button" className="deck-open" aria-label={`Open now playing: ${name.main}`} onClick={open} />
      <Position track={track} palette={palette} />
      <div className="transport">
        <TransportButtons playing={playing} />
        <Volume />
      </div>
      {/* What the page shows next to the deck: toggles, so icons, each named for screen readers
          and in a tooltip. */}
      <div className="deck-actions">
        <button type="button" className="icon-button" aria-label="Lyrics" title="Lyrics" aria-pressed={route.view === 'lyrics'} onClick={toggleLyrics}><MessageSquareQuote aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label="Queue" title="Queue" aria-pressed={route.view === 'queue'} onClick={() => route.view === 'queue' ? nav.back() : nav.go({ view: 'queue' })}><ListMusic aria-hidden="true" /></button>
        {window.squiggly && <button type="button" className="icon-button" aria-label="Mini player" title="Mini player" onClick={() => void window.squiggly!.window.toggleMini()}><PictureInPicture2 aria-hidden="true" /></button>}
        <FavoriteToggle track={track} />
        <PlayModes />
      </div>
      <SignalPath track={track} />
      <SleepNote />
      {upNext && <p className="up-next">Next: <button type="button" className="link" onClick={() => nav.go({ view: 'queue' })}>{splitTitle(upNext.title).main}</button></p>}
      {starting ? <p className="up-next" role="status">Finding songs like {starting}…</p>
        : radio && <p className="up-next">Radio from {radio.label}. <button type="button" className="link" onClick={player.stopRadio}>Stop</button></p>}
      {engine === 'unavailable' || engine === 'crashed' ? <EngineError /> : error && <DeckError message={error} />}
      <DeckLinks />
    </div>
  </aside>;
});

// A downloaded update, or a newer release for a copy that can't update itself. Shown under the
// deck, and on the connect screen, which has no deck.
function UpdateLink() {
  const update = usePlayer(s => s.update);
  if (update?.status === 'ready') return <button type="button" className="quiet-link update-link" onClick={() => void window.squiggly!.updates.install()}>Restart to update to {update.version}</button>;
  if (update?.status === 'available') return <button type="button" className="quiet-link update-link" onClick={() => void window.squiggly!.updates.open()}>Squiggly {update.version} is out</button>;
  return null;
}
// Opening files from this computer lives here rather than in the header, which has to leave
// room for the window's buttons.
const openFiles = async () => { const result = await window.squiggly!.openFiles(); if (!result.ok) player.showError(result.error); };
function DeckLinks() {
  const signedIn = usePlayer(s => s.access === 'signed-in');
  const mode = usePlayer(s => s.mode);
  const key = keysFor(useKeymap().keymap, PALETTE)[0];
  return <p className="deck-links">
    <UpdateLink />
    <button type="button" className="quiet-link commands-link" title={key ? `Commands (${key.join(' then ')})` : undefined} onClick={openPalette}>Commands</button>
    <button type="button" className="quiet-link" onClick={() => nav.go({ view: 'settings' })}>Settings</button>
    <button type="button" className="quiet-link" onClick={() => nav.go({ view: 'diagnostics' })}>Diagnostics</button>
    {mode === 'desktop' && <button type="button" className="quiet-link" onClick={() => void openFiles()}>Open files</button>}
    {signedIn && <button type="button" className="quiet-link" onClick={() => void player.signOut()}>Sign out</button>}
  </p>;
}
// A queue saved on the server (maybe from another device), offered once when nothing plays.
function Resume() {
  const saved = usePlayer(s => s.resumable);
  if (!saved) return null;
  const track = saved.tracks[saved.currentIndex];
  if (!track) return null;
  const minutes = Math.floor(saved.positionSeconds / 60), seconds = Math.floor(saved.positionSeconds % 60);
  return <div className="resume">
    <p>Pick up where you left off: <strong>{splitTitle(track.title).main}</strong> by {track.artist}, at {minutes}:{String(seconds).padStart(2, '0')}{saved.changedBy ? ` (from ${saved.changedBy})` : ''}.</p>
    <p className="resume-actions">
      <button type="button" className="play-action" onClick={() => void player.resume()}><span className="disc"><Glyph kind="play" /></span>Resume</button>
      <button type="button" className="text-button" onClick={player.dismissResume}>Not now</button>
    </p>
  </div>;
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

// The signal path as a sentence. Unknown stays unknown, and a request is called a request:
// asking Navidrome for the original file doesn't prove the original arrived.
// One quiet line: what the file is. Notes appear only when something changes what you hear.
// The output device is in Settings; decoder and output detail is on the Diagnostics page.
function SignalPath({ track }: { track: Track }) {
  const volume = usePlayer(s => Math.round(s.volume));
  const mode = usePlayer(s => s.mode);
  const buffering = usePlayer(s => s.buffering);
  const delivery = usePlayer(s => s.delivery);
  const format = [track.sourceFormat?.toUpperCase(), kHz(track.sourceSampleRate), track.sourceBitDepth && `${track.sourceBitDepth}-bit`].filter(Boolean).join(' · ');
  const notes = [delivery === 'mp3-fallback' && `This ${mode === 'android' ? 'phone' : 'browser'} can't play the original file, so it's playing a 320 kbps MP3 from the server.`,
    volume < 100 && `Volume at ${volume}%.`, buffering && 'Buffering.'].filter(Boolean).join(' ');
  // What the file is. The Android app asks for the original file too, and plays it itself.
  const line = [mode !== 'web' && format, notes].filter(Boolean).join('. ');
  return line ? <p className="signal">{line}</p> : null;
}

// Any CSS colour as #rrggbb, which is what the window's buttons take. A canvas normalises it.
function asHex(color: string) {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return color;
  context.fillStyle = '#000'; context.fillStyle = color;
  return context.fillStyle;
}
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
// The desktop's and the Android app's server login. Embedded, it stands in for a library page
// while songs from this computer play without a server.
function Connect({ embedded = false }: { embedded?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const android = window.squigglyAndroid?.session;
  const connect = async (connection: { url: string; username: string; password: string }) => {
    setBusy(true); setError(null);
    const result = await (window.squiggly ? window.squiggly.connect(connection) : android!.connect(connection));
    setBusy(false);
    if (!result.ok) setError(result.error);
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
    <p>{embedded ? 'Records, artists, playlists, and search come from your Navidrome server.' : 'Connect to your Navidrome server to open your library.'}{' '}
      {canRemember ? 'Squiggly remembers this sign-in, with the password encrypted by your system. Disconnect in Settings to forget it.' : 'This system can\'t store the password securely, so it stays in memory for this session only.'}</p>
    {reconnectError && saved && <p className="deck-error" role="alert">Couldn't reconnect to {hostOf(saved.url)}: {reconnectError}</p>}
    {/* The phone keeps the password encrypted, so a failed reconnect (offline, say) can try again without it. */}
    {reconnectError && saved && android && <button type="button" className="text-button" disabled={busy} onClick={() => void retry()}>Try {hostOf(saved.url)} again</button>}
    <form onSubmit={submit}>
      {/* Text rather than type="url", so an address without https:// is accepted; the app tries HTTPS, then HTTP. */}
      <label>Server address<input name="url" type="text" inputMode="url" required placeholder="music.example.com" autoComplete="url"
        autoCapitalize="off" spellCheck={false} defaultValue={saved?.url} /></label>
      <label>Username<input name="username" required autoComplete="username" defaultValue={saved?.username} /></label>
      <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
      <button type="submit" className="play-action" disabled={busy}><span className="disc"><Glyph kind="play" /></span>{busy ? 'Connecting' : 'Connect'}</button>
      {error && <p className="deck-error" role="alert">{error}</p>}
    </form>
    {!embedded && window.squiggly && <button type="button" className="text-button" onClick={() => void openFiles()}>Play files from this computer instead</button>}
    {/* Navidrome's own public demo, with Creative Commons music, for trying Squiggly without a server. */}
    <p className="connect-demo">No server yet? <button type="button" className="link" disabled={busy}
      onClick={() => void connect({ url: 'https://demo.navidrome.org', username: 'demo', password: 'demo' })}>Try Navidrome's demo</button>, a public server of Creative Commons music that everyone shares.</p>
    {!embedded && window.squiggly && <p className="connect-update"><UpdateLink /></p>}
  </Frame>;
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
    <p>This host plays music from its Navidrome account. Enter the password set for it on this host. It keeps other people on the network from playing, browsing, or changing that account.</p>
    <form onSubmit={submit}>
      <label>Password<input name="password" type="password" required autoComplete="current-password" autoFocus /></label>
      <button type="submit" className="play-action" disabled={busy}><span className="disc"><Glyph kind="play" /></span>{busy ? 'Signing in' : 'Sign in'}</button>
      {error && <p className="deck-error" role="alert">{error}</p>}
    </form>
  </main>;
}
