import { useState } from 'react';
import { current, player, usePlayer } from './player';
import { useSettings } from './settings';
import { paletteStyle, Position, TransportButtons } from './transport';
import { Cover, splitTitle, usePalette } from './ui';

// The mini player: its own small window, for when another app owns the screen.
// The window is dragged by its background; the controls opt out of dragging.
export function Mini() {
  const track = usePlayer(current);
  const playing = usePlayer(s => s.playing);
  const engine = usePlayer(s => s.engine);
  const error = usePlayer(s => s.error);
  const palette = usePalette(track?.coverArt);
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
    {track ? <Cover key={track.id} id={track.coverArt} name={track.album} size={200} className="mini-cover" /> : <div className="cover cover-empty mini-cover" />}
    <div className="mini-text">
      <p className="mini-title">{name ?? 'Nothing playing'}</p>
      {/* One line either way: the artist, or what went wrong (in full on hover). */}
      {problem ? <p className="mini-sub" role="alert" title={problem}>{problem}</p>
        : <p className="mini-sub">{track ? track.artist : 'Pick something in the full window.'}</p>}
      {track && <Position track={track} palette={palette} />}
    </div>
    <div className="mini-controls">
      <TransportButtons playing={playing} />
    </div>
    <div className="mini-window">
      {failed ? <button type="button" className="text-button" onClick={() => void window.squiggly?.command({ type: 'restart' })}>Restart audio</button>
        : problem && <button type="button" className="text-button" onClick={() => { player.dismissError(); setPinError(null); }}>Dismiss</button>}
      <button type="button" className="text-button" aria-pressed={onTop} title="Keep the mini player above other windows" onClick={() => void pin()}>{onTop ? 'Unpin' : 'Pin'}</button>
      <button type="button" className="text-button" onClick={() => void window.squiggly?.window.toggleMini()}>Full window</button>
    </div>
  </div>;
}
