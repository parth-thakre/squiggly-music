import { ChevronLeft, ListMusic, MessageSquareQuote, Shuffle } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Album, Result, Track } from '../../../../../packages/core/contracts';
import { api, useResource } from './library';
import { Lyrics } from './lyrics';
import { playTarget } from './menu';
import { mixById, mixTracks } from './mixes';
import type { Palette } from './palette';
import { current, currentEntry, player, usePlayer } from './player';
import { nav } from './route';
import { useSwipeSongs } from './swipe';
import { Position, TransportButtons, useByline } from './transport';
import { Cover, Glyph, plural, splitTitle, time, Wave } from './ui';

// The Galaxy Z Flip's cover screen (Flex Window), in place of the phone layout: what's playing,
// big enough to read and press at a glance, with the queue and lyrics a tap away. The cameras sit
// along the bottom, to the right; app.css keeps what you press clear of them on each model.
type Panel = 'queue' | 'lyrics';

export function CoverScreen({ palette }: { palette: Palette }) {
  const track = usePlayer(current);
  const [panel, setPanel] = useState<Panel | null>(null);
  // Queue and lyrics open over the now-playing view as a history entry, so Back closes them.
  // Unfolding the phone unmounts this view; its entry goes with it.
  useEffect(() => { if (panel) return () => nav.closeOverlay(); }, [panel !== null]);
  useEffect(() => { if (!track && panel) nav.closeOverlay(); }, [track, panel]);
  const show = (next: Panel) => panel ? setPanel(next) : nav.openOverlay(() => setPanel(next), () => setPanel(null));
  const view = !track ? 'idle' : panel ?? 'playing';
  // Each change of view lands focus on the new view, as a page change does.
  const root = useRef<HTMLElement>(null);
  const shown = useRef(view);
  useEffect(() => { if (shown.current !== view) { shown.current = view; root.current?.focus(); } }, [view]);
  return <main ref={root} className="flip-screen" data-view={view} tabIndex={-1} aria-label={view === 'idle' ? 'Nothing playing' : view === 'queue' ? 'Queue' : view === 'lyrics' ? 'Lyrics' : 'Now playing'}>
    {view === 'idle' ? <Idle />
      : view === 'queue' ? <><QueuePanel /><Shelf back /></>
      : view === 'lyrics' ? <><div className="flip-lyrics"><Lyrics compact /></div><Shelf back /></>
      : <Playing track={track!} palette={palette} show={show} />}
  </main>;
}

function Playing({ track, palette, show }: { track: Track; palette: Palette; show(panel: Panel): void }) {
  const entry = usePlayer(currentEntry);
  const error = usePlayer(s => s.error);
  const stage = useRef<HTMLDivElement>(null);
  useSwipeSongs(stage, entry ?? track.id);
  const name = splitTitle(track.title, track.album).main;
  const byline = useByline(track);
  return <>
    <div className="flip-stage" ref={stage}>
      <Cover key={track.id} id={track.coverArt} name={track.album} size={400} className="flip-sleeve" />
      <div className="flip-text">
        <h1 className="flip-title" title={name}>{name}</h1>
        <p className="flip-artist" title={byline}>{byline}</p>
        {error && <p className="flip-error" role="alert">{error} <button type="button" className="link" onClick={player.dismissError}>Dismiss</button></p>}
      </div>
      <div className="flip-panels">
        <button type="button" title="Queue" onClick={() => show('queue')}><ListMusic aria-hidden="true" /><span>Queue</span></button>
        <button type="button" title="Lyrics" onClick={() => show('lyrics')}><MessageSquareQuote aria-hidden="true" /><span>Lyrics</span></button>
      </div>
    </div>
    <Position track={track} palette={palette} />
    <Shelf />
  </>;
}

// The controls under the squiggle, or Back and play under the queue and lyrics.
function Shelf({ back = false }: { back?: boolean }) {
  const playing = usePlayer(s => s.playing);
  return <div className={`flip-shelf${back ? ' flip-back-shelf' : ''}`}>
    {back ? <>
      <button type="button" className="flip-back" onClick={() => nav.closeOverlay()}><ChevronLeft aria-hidden="true" />Back</button>
      <button type="button" className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={player.toggle}><Glyph kind={playing ? 'pause' : 'play'} /></button>
    </> : <TransportButtons playing={playing} />}
  </div>;
}

function QueuePanel() {
  const queue = usePlayer(s => s.queue);
  const entries = usePlayer(s => s.entryIds);
  const index = usePlayer(s => s.index);
  const playing = usePlayer(s => s.playing);
  const list = useRef<HTMLOListElement>(null);
  // Opens with the playing song at the top.
  useLayoutEffect(() => {
    const element = list.current, row = element?.children[index];
    if (element && row) element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top;
  }, []);
  const upcoming = queue.length - index - 1;
  return <section className="flip-panel">
    <header className="flip-panel-head">
      <h1>Queue</h1>
      <p>{upcoming > 0 ? `${plural(upcoming, 'song')} up next` : 'This is the last song.'}</p>
    </header>
    <ol className="flip-queue" ref={list}>
      {queue.map((track, i) => <li key={entries[i] ?? i} className={i === index ? 'now' : i < index ? 'played' : undefined}>
        <button type="button" aria-current={i === index ? 'true' : undefined} onClick={() => player.jump(i, entries[i])}>
          <span className="flip-queue-text">
            <span className="flip-queue-title">{splitTitle(track.title, track.album).main}</span>
            <span className="flip-queue-artist">{track.artist}</span>
          </span>
          {i === index ? <Wave playing={playing} /> : <span className="figure">{time(track.duration ?? null)}</span>}
        </button>
      </li>)}
    </ol>
  </section>;
}

// Nothing playing: pick up the saved queue, play a record played lately, or shuffle everything.
function Idle() {
  const saved = usePlayer(s => s.resumable);
  const starting = usePlayer(s => s.radioStarting);
  const error = usePlayer(s => s.error);
  const [busy, setBusy] = useState(false);
  const resume = saved?.tracks[saved.currentIndex];
  const shuffle = async () => {
    setBusy(true);
    const result = await mixTracks(mixById('everything')!, true);
    setBusy(false);
    if (!result.ok) player.showError(result.error);
    else if (!result.value.length) player.showError('There are no songs on this server yet.');
    else await player.play(result.value, 0);
  };
  return <>
    <div className="flip-idle">
      <h1 className="flip-title">Nothing playing</h1>
      {starting ? <p className="flip-line" role="status">Finding songs like {starting}…</p>
        : resume ? <p className="flip-line">Pick up <strong>{splitTitle(resume.title).main}</strong> by {resume.artist}, at {time(saved!.positionSeconds)}.</p>
        : <p className="flip-line">Shuffle everything, or tap a record to play it.</p>}
      {error && <p className="flip-error" role="alert">{error} <button type="button" className="link" onClick={player.dismissError}>Dismiss</button></p>}
      <Lately />
    </div>
    <div className="flip-shelf">
      {resume ? <>
        <button type="button" className="icon-button" aria-label="Shuffle everything" title="Shuffle everything" disabled={busy} onClick={() => void shuffle()}><Shuffle aria-hidden="true" /></button>
        <button type="button" className="play-action" onClick={() => void player.resume()}><span className="disc"><Glyph kind="play" /></span>Resume</button>
      </> : <button type="button" className="play-action" disabled={busy} onClick={() => void shuffle()}><span className="disc"><Shuffle aria-hidden="true" /></span>Shuffle</button>}
    </div>
  </>;
}

// Records played lately, or the newest on a server with no history yet. A tap plays one.
function Lately() {
  const recent = useResource<Album[]>('albums:recent:0:8', () => api.albums('recent', 0, 8));
  const empty = recent?.ok && !recent.value.length;
  const newest = useResource<Album[]>(empty ? 'albums:newest:0:8' : null, () => api.albums('newest', 0, 8));
  const albums: Result<Album[]> | undefined = empty ? newest : recent;
  if (!albums?.ok || !albums.value.length) return null;
  return <ul className="flip-lately" aria-label={empty ? 'Newest records' : 'Played lately'}>
    {albums.value.map(album => <li key={album.id}>
      <button type="button" aria-label={`Play ${album.name} by ${album.artist}`} onClick={() => void playTarget({ kind: 'album', album })}>
        <Cover id={album.coverArt} name={album.name} size={160} />
      </button>
    </li>)}
  </ul>;
}
