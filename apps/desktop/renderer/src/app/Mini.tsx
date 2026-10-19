import { useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { Maximize2, Pin } from 'lucide-react';
import { current, player, usePlayer } from './player';
import { useSettings } from './settings';
import { paletteStyle, PlayModes, Position, TransportButtons, useByline, useRoomPalette } from './transport';
import { Cover, splitTitle } from './ui';
import { useMiniCommandKeys } from './commands';
import { DeckSlots, ExtensionNotices } from './extensions';
import { SungLine } from './lyrics';

// Room between the song and the buttons for the line being sung: what the window has beside the
// sleeve, which is as wide as the window is tall up to a third or so of its width (app.css).
const LYRIC_ROOM = 460;
const roomForLyric = () => typeof innerWidth === 'number' && innerWidth - Math.min(innerHeight, innerWidth * .36) >= LYRIC_ROOM;
const onResize = (listener: () => void) => { addEventListener('resize', listener); return () => removeEventListener('resize', listener); };
const useRoomForLyric = () => useSyncExternalStore(onResize, roomForLyric);

// The mini player: its own small window, for when another app owns the screen.
// The window is dragged by its background; the controls opt out of dragging.
export function Mini() {
  const track = usePlayer(current);
  const playing = usePlayer(s => s.playing);
  const engine = usePlayer(s => s.engine);
  const error = usePlayer(s => s.error);
  const palette = useRoomPalette(track?.coverArt);
  useMiniCommandKeys();
  const byline = useByline(track);
  // The stored preference until this window changes it; the main process applies it when the
  // window opens, so nothing is written here until the listener asks.
  const stored = useSettings().miniOnTop;
  const [pinned, setPinned] = useState<boolean | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const onTop = pinned ?? stored;
  const pin = async () => {
    const next = !onTop;
    setPinned(next); setPinError(null);
    const result = await window.squiggly!.window.setAlwaysOnTop(next);
    if (!result.ok) { setPinned(!next); setPinError(result.error); }
  };
  const failed = engine === 'unavailable' || engine === 'crashed';
  const problem = failed ? error ?? 'The audio engine stopped.' : error ?? pinError;
  const name = track ? splitTitle(track.title, track.album).main : null;
  const lyricRoom = useRoomForLyric();
  return <div className="mini" style={paletteStyle(palette)}>
    {/* The sleeve is the window's left edge, its full height, and a handle to drag it by. */}
    {track ? <Cover key={track.id} id={track.coverArt} name={track.album} size={300} className="mini-cover" /> : <div className="cover cover-empty mini-cover" />}
    <div className="mini-text">
      <p className="mini-title">{name ?? 'Nothing playing'}</p>
      {/* One line either way: the artist (and extensions' quiet lines), or what went wrong (in
          full on hover) with what to do about it. */}
      {problem ? <p className="mini-sub" role="alert">
        <span title={problem}>{problem}</span>
        {failed ? <button type="button" className="link" onClick={() => void window.squiggly?.command({ type: 'restart' })}>Restart audio</button>
          : <button type="button" className="link" onClick={() => { player.dismissError(); setPinError(null); }}>Dismiss</button>}
      </p> : <p className={`mini-sub${track ? '' : ' waiting'}`}>
        <span>{track ? byline : 'Pick something in the full window.'}</span>
        <span className="mini-slots"><DeckSlots placement="quiet-line" track={track} /></span>
      </p>}
    </div>
    {track && lyricRoom && <SungLine key={track.id} track={track} />}
    <div className="mini-controls">
      <TransportButtons playing={playing} />
    </div>
    {/* The squiggle, shuffle and repeat, and the window's own buttons share the last line, across
        the whole width. */}
    <div className="mini-foot">
      {track ? <div className="mini-position"><Position track={track} palette={palette} /></div> : <span className="mini-position" />}
      <span className="mini-modes"><PlayModes /></span>
      <div className="mini-window">
        <button type="button" className="icon-button" aria-pressed={onTop} aria-label="Keep on top" title={onTop ? 'Kept above other windows' : 'Keep above other windows'} onClick={() => void pin()}>
          <Pin aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label="Full window" title="Full window" onClick={() => void window.squiggly?.window.toggleMini()}>
          <Maximize2 aria-hidden="true" />
        </button>
      </div>
    </div>
    <ExtensionNotices />
    {window.squiggly?.window.ownResize && <ResizeEdges />}
  </div>;
}

// On Windows the mini player has no system frame (main/index.ts), so it resizes from these: thin
// handles along its edges and at its corners. A drag sends the new bounds once a frame; the main
// process holds the window to the sizes it allows, which these follow so a left or top edge
// stops where the size does rather than pushing the window along.
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
const WIDTHS = [320, 900] as const, HEIGHTS = [96, 240] as const;
const within = (value: number, [low, high]: readonly [number, number]) => Math.min(high, Math.max(low, value));
type Bounds = { x: number; y: number; width: number; height: number };
function ResizeEdges() {
  const drag = useRef<{ edge: (typeof EDGES)[number]; x: number; y: number; from: Bounds } | null>(null);
  const frame = useRef(0);
  const next = useRef<Bounds | null>(null);
  const send = () => {
    frame.current = 0;
    const bounds = next.current;
    next.current = null;
    if (bounds) void window.squiggly?.window.resizeMini?.(bounds);
  };
  const down = (edge: (typeof EDGES)[number]) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { edge, x: event.screenX, y: event.screenY, from: { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight } };
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (!held) return;
    const { edge, from } = held, dx = event.screenX - held.x, dy = event.screenY - held.y;
    const width = within(from.width + (edge.includes('e') ? dx : edge.includes('w') ? -dx : 0), WIDTHS);
    const height = within(from.height + (edge.includes('s') ? dy : edge.includes('n') ? -dy : 0), HEIGHTS);
    next.current = {
      x: Math.round(edge.includes('w') ? from.x + from.width - width : from.x), y: Math.round(edge.includes('n') ? from.y + from.height - height : from.y),
      width: Math.round(width), height: Math.round(height),
    };
    if (!frame.current) frame.current = requestAnimationFrame(send);
  };
  const up = () => { drag.current = null; };
  return <>{EDGES.map(edge => <div key={edge} className={`mini-edge ${edge}`} aria-hidden="true"
    onPointerDown={down(edge)} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />)}</>;
}
