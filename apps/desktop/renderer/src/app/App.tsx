import { createContext, memo, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react';
import type { AudioDevice, Track } from '../../../../../packages/core/contracts';
import { current, optimisticVolume, player, usePlayer } from './player';
import { nav, useCanGoBack, useRoute, type Route } from './route';
import { Lyrics } from './lyrics';
import { ContextMenu, onMenuError, openMenu } from './menu';
import { Cover, Glyph, kHz, neutral, splitTitle } from './ui';
import { paletteStyle, Position, TransportButtons, useRoomPalette } from './transport';
import { CommandPalette, keysFor, openPalette, PALETTE, shell, useCommandKeys, useKeymap } from './commands';
import { ExtensionNotices, ExtensionPage } from './extensions';
import { AlbumPage, ArtistPage, Artists, DiagnosticsView, Favorites, LyricsPage, MixPage, PlaylistPage, Playlists, Queue, Records, Search, SettingsView } from './views';

onMenuError(message => player.showError(message));

const sections: { view: 'records' | 'artists' | 'playlists' | 'favorites'; label: string }[] = [
  { view: 'records', label: 'Records' }, { view: 'artists', label: 'Artists' }, { view: 'playlists', label: 'Playlists' }, { view: 'favorites', label: 'Favorites' },
];
// Places that need the server. Without one, they offer to connect instead.
const library = new Set<Route['view']>(['records', 'artists', 'playlists', 'favorites', 'album', 'artist', 'playlist', 'mix', 'search']);
const PaletteContext = createContext(neutral);
const sectionOf = (route: Route) => route.view === 'album' ? 'records' : route.view === 'artist' ? 'artists'
  : route.view === 'playlist' || route.view === 'mix' ? 'playlists' : route.view;

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
  // Songs from this computer play without a server: the deck, queue, and settings stay usable.
  const shell = connected || (mode === 'desktop' && hasQueue);
  return <PaletteContext.Provider value={palette}><div className="room" style={paletteStyle(palette)}>
    {shell ? <>
      <Bar />
      <Deck />
      <main className="page" ref={nav.attach} tabIndex={-1}><View /></main>
    </> : mode === 'desktop' ? <Connect /> : access === 'checking' ? null : <SignIn />}
    <ContextMenu />
    <ExtensionNotices />
    <CommandPalette />
  </div></PaletteContext.Provider>;
}

// The mark: the app's own seek bar. Played squiggle, the thumb, the unplayed rest.
function Mark() {
  return <svg className="mark" viewBox="80 164 356 184" aria-hidden="true">
    <path d="M100.0 256.0 L102.0 255.8 L104.0 255.4 L106.0 254.6 L108.0 253.6 L110.0 252.3 L112.0 250.8 L114.0 249.1 L116.0 247.3 L118.0 245.4 L120.0 243.5 L122.0 241.6 L124.0 239.8 L126.0 238.2 L128.0 236.7 L130.0 235.5 L132.0 234.6 L134.0 234.0 L136.0 233.8 L138.0 234.1 L140.0 234.8 L142.0 236.0 L144.0 237.6 L146.0 239.8 L148.0 242.4 L150.0 245.4 L152.0 248.9 L154.0 252.8 L156.0 257.1 L158.0 261.6 L160.0 266.1 L162.0 270.4 L164.0 274.5 L166.0 278.4 L168.0 282.0 L170.0 285.3 L172.0 288.2 L174.0 290.6 L176.0 292.7 L178.0 294.2 L180.0 295.3 L182.0 295.9 L184.0 296.0 L186.0 295.5 L188.0 294.6 L190.0 293.1 L192.0 291.2 L194.0 288.8 L196.0 286.0 L198.0 282.8 L200.0 279.3 L202.0 275.5 L204.0 271.4 L206.0 267.2 L208.0 262.8 L210.0 258.3 L212.0 253.7 L214.0 249.2 L216.0 244.8 L218.0 240.6 L220.0 236.5 L222.0 232.7 L224.0 229.2 L226.0 226.0 L228.0 223.2 L230.0 220.8 L232.0 218.9 L234.0 217.4 L236.0 216.5 L238.0 216.0 L240.0 216.1 L242.0 216.7 L244.0 217.8 L246.0 219.3 L248.0 221.4 L250.0 223.8 L252.0 226.7 L254.0 230.0 L256.0 233.6 L258.0 237.5 L260.0 241.6 L262.0 245.9 L264.0 250.4 L266.0 254.9 L268.0 259.2 L270.0 263.1 L272.0 266.6 L274.0 269.6 L276.0 272.2 L278.0 274.4 L280.0 276.0 L282.0 277.2 L284.0 277.9 L286.0 278.2 L288.0 278.0 L290.0 277.4 L292.0 276.5 L294.0 275.3 L296.0 273.8 L298.0 272.2 L300.0 270.4 L302.0 268.5 L304.0 266.6 L306.0 264.7 L308.0 262.9 L310.0 261.2 L312.0 259.7 L314.0 258.4 L316.0 257.4 L318.0 256.6 L320.0 256.2 L322.0 256.0" fill="none" stroke="currentColor" strokeWidth="30" strokeLinecap="round" strokeLinejoin="round"/>
  <rect x="346" y="178" width="32" height="156" rx="16" fill="currentColor"/>
  <path d="M402 256 H414" stroke="currentColor" strokeOpacity=".3" strokeWidth="30" strokeLinecap="round"/>
  </svg>;
}

const Bar = memo(function Bar() {
  const route = useRoute();
  const canGoBack = useCanGoBack();
  const mode = usePlayer(s => s.mode);
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
  const openFiles = async () => { const result = await window.squiggly!.openFiles(); if (!result.ok) player.showError(result.error); };
  return <header className="bar">
    <div className="bar-top">
    <span className="wordmark"><Mark />Squiggly</span>
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
    {mode === 'desktop' && <button type="button" className="text-button" onClick={() => void openFiles()}>Open files</button>}
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
  }
});

// The deck: whatever is on the platter, always in view. It re-renders for a new song, play
// and pause, errors, and radio; the position lives in DeckPosition alone.
const Deck = memo(function Deck() {
  const track = usePlayer(current);
  const playing = usePlayer(s => s.playing);
  const upNext = usePlayer(s => s.queue[s.index + 1] as Track | undefined);
  const error = usePlayer(s => s.error);
  const engine = usePlayer(s => s.engine);
  const radio = usePlayer(s => s.radio);
  const starting = usePlayer(s => s.radioStarting);
  const [expanded, setExpanded] = useState(false);
  const [sheetLyrics, setSheetLyrics] = useState(false);
  const route = useRoute();
  const palette = useContext(PaletteContext);
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
  return <aside className={`deck${expanded ? ' open' : ''}${expanded && sheetLyrics ? ' lyrics-open' : ''}`} aria-label="Now playing"
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
          {track.artistId ? <button type="button" className="link" onClick={() => nav.go({ view: 'artist', id: track.artistId! })}>{track.artist}</button> : track.artist}
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
      <div className="deck-actions">
        <button type="button" className="text-button" aria-pressed={route.view === 'lyrics'} onClick={toggleLyrics}>Lyrics</button>
        <button type="button" className="text-button" aria-pressed={route.view === 'queue'} onClick={() => route.view === 'queue' ? nav.back() : nav.go({ view: 'queue' })}>Queue</button>
        {window.squiggly && <button type="button" className="text-button" onClick={() => void window.squiggly!.window.toggleMini()}>Mini player</button>}
      </div>
      <SignalPath track={track} />
      {upNext && <p className="up-next">Next: <button type="button" className="link" onClick={() => nav.go({ view: 'queue' })}>{splitTitle(upNext.title).main}</button></p>}
      {starting ? <p className="up-next" role="status">Finding songs like {starting}…</p>
        : radio && <p className="up-next">Radio from {radio.label}. <button type="button" className="link" onClick={player.stopRadio}>Stop</button></p>}
      {engine === 'unavailable' || engine === 'crashed' ? <EngineError /> : error && <DeckError message={error} />}
      <DeckLinks />
    </div>
  </aside>;
});

function DeckLinks() {
  const signedIn = usePlayer(s => s.access === 'signed-in');
  const key = keysFor(useKeymap().keymap, PALETTE)[0];
  return <p className="deck-links">
    <button type="button" className="quiet-link commands-link" title={key ? `Commands (${key.join(' then ')})` : undefined} onClick={openPalette}>Commands</button>
    <button type="button" className="quiet-link" onClick={() => nav.go({ view: 'settings' })}>Settings</button>
    <button type="button" className="quiet-link" onClick={() => nav.go({ view: 'diagnostics' })}>Diagnostics</button>
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
function SignalPath({ track }: { track: Track }) {
  const audio = usePlayer(s => s.audio);
  const devices = usePlayer(s => s.devices);
  const device = usePlayer(s => s.device);
  const volume = usePlayer(s => Math.round(s.volume));
  const mode = usePlayer(s => s.mode);
  const buffering = usePlayer(s => s.buffering);
  const delivery = usePlayer(s => s.delivery);
  const format = [track.sourceFormat?.toUpperCase(), kHz(track.sourceSampleRate), track.sourceBitDepth && `${track.sourceBitDepth}-bit`].filter(Boolean).join(', ');
  const source = track.source === 'navidrome'
    ? `${format || 'Unknown format'}, the original file requested from Navidrome`
    : `${format || 'Unknown format'} from this computer`;
  const level = volume >= 100 ? 'Full volume' : `Volume at ${volume}% attenuates the signal`;
  // In a browser the decoder, resampler, and mixer all belong to the browser and the phone.
  if (mode === 'web') return <p className="signal">
    {delivery === 'mp3-fallback'
      ? <>This browser couldn't decode the original{format ? ` ${format}` : ''} file, so it asked the server for a 320 kbps MP3 and is playing that, decoded by this browser and mixed by this device.</>
      : <>{source}, decoded by this browser and mixed by this device.</>}
    {' '}{level}.{buffering && ' Buffering.'}{' '}
    <span>The browser doesn't report what it does to the signal. Use the desktop app for a checked audio path.</span>
  </p>;
  const output = <DeviceChoice devices={devices} device={device} />;
  if (!audio || !audio.decoderFormat) return <p className="signal">{source}, playing on {output}. {level}. <span>Decoder and output formats appear once it plays.</span></p>;
  const extra = [audio.replayGain && audio.replayGain !== 'no' ? `ReplayGain ${audio.replayGain}` : 'no ReplayGain', audio.filters ? `filters: ${audio.filters}` : 'no filters'];
  return <p className="signal">
    {source}. Decoded to {audio.decoderFormat}{audio.decoderRate ? ` at ${kHz(audio.decoderRate)}` : ''} and handed to {audio.outputBackend ?? 'the system'}
    {audio.outputRate ? ` at ${kHz(audio.outputRate)}` : ''}{audio.outputFormat ? ` as ${audio.outputFormat}` : ''}, playing on {output}. {[level, ...extra].join(', ')}.
    {audio.buffering && ' Buffering.'} <span>The system mixer's final format isn't reported.</span>
  </p>;
}
function DeviceChoice({ devices, device }: { devices: AudioDevice[]; device: string }) {
  return <select aria-label="Output device" value={device} onChange={event => player.device(event.target.value)}>
    {!devices.some(d => d.name === device) && <option value={device}>{device === 'auto' ? 'System default' : device}</option>}
    {devices.map(d => <option key={d.name} value={d.name}>{d.name === 'auto' ? 'System default' : d.description}</option>)}
  </select>;
}

// The desktop's server login. Embedded, it stands in for a library page while songs from
// this computer play without a server.
function Connect({ embedded = false }: { embedded?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(null);
    const result = await window.squiggly!.connect({ url: String(data.get('url')), username: String(data.get('username')), password: String(data.get('password')) });
    setBusy(false);
    if (!result.ok) setError(result.error);
  };
  const openFiles = async () => {
    setError(null);
    const result = await window.squiggly!.openFiles();
    if (!result.ok) setError(result.error);
  };
  const Frame = embedded ? 'section' : 'main';
  return <Frame className="connect">
    <h1>{embedded ? 'Connect to your library' : 'Squiggly'}</h1>
    <p>{embedded ? 'Records, artists, playlists, and search come from your Navidrome server.' : 'Connect to your Navidrome server to open your library.'} Your password stays in memory for this session only.</p>
    <form onSubmit={submit}>
      <label>Server address<input name="url" type="url" required placeholder="https://music.example.com" autoComplete="url" /></label>
      <label>Username<input name="username" required autoComplete="username" /></label>
      <label>Password<input name="password" type="password" required autoComplete="current-password" /></label>
      <button type="submit" className="play-action" disabled={busy}><span className="disc"><Glyph kind="play" /></span>{busy ? 'Connecting' : 'Connect'}</button>
      {error && <p className="deck-error" role="alert">{error}</p>}
    </form>
    {!embedded && <button type="button" className="text-button" onClick={() => void openFiles()}>Play files from this computer instead</button>}
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
