import { useState, type CSSProperties } from 'react';
import { Squiggle } from './Squiggle';
import { current, currentEntry, player, usePlayer } from './player';
import { useSettings } from './settings';
import type { Palette } from './palette';
import { Cover, Glyph, splitTitle, usePalette } from './ui';

const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
// Same variables as the main window (App.tsx), accentText falling back to the accent.
const paletteStyle = (palette: Palette) => ({
  '--ground': palette.ground, '--ink': palette.ink, '--soft': palette.soft, '--accent': palette.accent,
  '--accent-text': palette.accentText ?? palette.accent, '--line': alpha(palette.ink, .16),
}) as CSSProperties;

// The mini player: its own small window, for when another app owns the screen.
// The window is dragged by its background; the controls opt out of dragging.
export function Mini() {
  const track = usePlayer(current);
  const entry = usePlayer(currentEntry);
  const playing = usePlayer(s => s.playing);
  const position = usePlayer(s => s.position);
  const duration = usePlayer(s => s.duration);
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
      {track && <Squiggle label={`Position in ${track.title}`} identity={entry ?? track.id} position={position} duration={duration || (track.duration ?? 0)} playing={playing}
        color={palette.accent} rest={alpha(palette.ink, .22)} onSeek={player.seek} />}
    </div>
    <div className="mini-controls">
      <button type="button" className="glyph" aria-label="Previous" onClick={player.previous}><Glyph kind="prev" /></button>
      <button type="button" className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={player.toggle}><Glyph kind={playing ? 'pause' : 'play'} /></button>
      <button type="button" className="glyph" aria-label="Next" onClick={player.next}><Glyph kind="next" /></button>
    </div>
    <div className="mini-window">
      {failed ? <button type="button" className="text-button" onClick={() => void window.squiggly?.command({ type: 'restart' })}>Restart audio</button>
        : problem && <button type="button" className="text-button" onClick={() => { player.dismissError(); setPinError(null); }}>Dismiss</button>}
      <button type="button" className="text-button" aria-pressed={onTop} title="Keep the mini player above other windows" onClick={() => void pin()}>{onTop ? 'Unpin' : 'Pin'}</button>
      <button type="button" className="text-button" onClick={() => void window.squiggly?.window.toggleMini()}>Full window</button>
    </div>
  </div>;
}
