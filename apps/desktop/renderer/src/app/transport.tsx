import type { CSSProperties } from 'react';
import type { Track } from '../../../../../packages/core/contracts';
import type { Palette } from './palette';
import { currentEntry, player, usePlayer } from './player';
import { Squiggle } from './Squiggle';
import { Glyph } from './ui';

// Shared by the deck (App.tsx) and the mini player window (Mini.tsx).

export const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
// The room's colours as CSS variables. accentText is for normal-weight text; palettes that
// don't carry one fall back to the accent.
export const paletteStyle = (palette: Palette) => ({
  '--ground': palette.ground, '--ink': palette.ink, '--soft': palette.soft, '--accent': palette.accent,
  '--accent-text': palette.accentText ?? palette.accent, '--line': alpha(palette.ink, .16),
}) as CSSProperties;

export function TransportButtons({ playing }: { playing: boolean }) {
  return <>
    <button type="button" className="glyph" aria-label="Previous" onClick={player.previous}><Glyph kind="prev" /></button>
    <button type="button" className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={player.toggle}><Glyph kind={playing ? 'pause' : 'play'} /></button>
    <button type="button" className="glyph" aria-label="Next" onClick={player.next}><Glyph kind="next" /></button>
  </>;
}

// The seek squiggle. The only part of the deck or mini player that follows position snapshots.
export function Position({ track, palette }: { track: Track; palette: Palette }) {
  const position = usePlayer(s => s.position);
  const duration = usePlayer(s => s.duration);
  const playing = usePlayer(s => s.playing);
  const entry = usePlayer(currentEntry);
  return <Squiggle label={`Position in ${track.title}`} identity={entry ?? track.id} position={position} duration={duration || (track.duration ?? 0)} playing={playing}
    color={palette.accent} rest={alpha(palette.ink, .22)} onSeek={player.seek} />;
}
