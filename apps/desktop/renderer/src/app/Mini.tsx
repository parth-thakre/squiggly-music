import { useState } from 'react';
import { Maximize2, Pin } from 'lucide-react';
import { current, player, usePlayer } from './player';
import { useSettings } from './settings';
import { paletteStyle, Position, TransportButtons, useByline, useRoomPalette } from './transport';
import { Cover, splitTitle } from './ui';
import { useMiniCommandKeys } from './commands';
import { DeckSlots, ExtensionNotices } from './extensions';

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
    <div className="mini-controls">
      <TransportButtons playing={playing} />
    </div>
    {/* The squiggle and the window's own buttons share the last line, across the whole width. */}
    <div className="mini-foot">
      {track ? <div className="mini-position"><Position track={track} palette={palette} /></div> : <span className="mini-position" />}
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
  </div>;
}
