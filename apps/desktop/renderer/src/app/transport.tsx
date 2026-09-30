import { Repeat, Repeat1, Shuffle, Star } from 'lucide-react';
import { useLayoutEffect, type CSSProperties } from 'react';
import { nextRepeat } from '../../../../../packages/core/playOrder';
import type { Track } from '../../../../../packages/core/contracts';
import { isStation } from '../../../../../packages/core/stations';
import type { Palette } from './palette';
import { currentEntry, player, usePlayer } from './player';
import { Squiggle } from './Squiggle';
import { isStarred, setStarred, useFavoritesVersion } from './favorites';
import { useSleepNote } from './commands/sleep';
import { applyTheme, themePalette, useActiveTheme } from './theme';
import { Glyph, usePalette } from './ui';

// Shared by the deck (App.tsx) and the mini player window (Mini.tsx).

export const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
// The room's colours as CSS variables. accentText is for normal-weight text; palettes that
// don't carry one fall back to the accent.
export const paletteStyle = (palette: Palette) => ({
  '--ground': palette.ground, '--ink': palette.ink, '--soft': palette.soft, '--accent': palette.accent,
  '--accent-text': palette.accentText ?? palette.accent, '--line': palette.line ?? alpha(palette.ink, .16),
}) as CSSProperties;

// The room's palette: the theme's fixed colours, or the playing record's sleeve. Each window
// (main and mini) applies the chosen theme's type, spacing, and motion to its own document.
export function useRoomPalette(coverArt: string | null | undefined): Palette {
  const theme = useActiveTheme();
  const fixed = themePalette(theme);
  const cover = usePalette(fixed ? null : coverArt);
  useLayoutEffect(() => applyTheme(theme), [theme]);
  return fixed ?? cover;
}

export function TransportButtons({ playing }: { playing: boolean }) {
  return <>
    <button type="button" className="glyph" aria-label="Previous" onClick={player.previous}><Glyph kind="prev" /></button>
    <button type="button" className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={player.toggle}><Glyph kind={playing ? 'pause' : 'play'} /></button>
    <button type="button" className="glyph" aria-label="Next" onClick={player.next}><Glyph kind="next" /></button>
  </>;
}

// Shuffle and repeat, as icon toggles like the deck's others. Repeat goes off, all, one: pressed
// for both of the last two, with its own icon for one.
const repeatName = { off: 'Repeat', all: 'Repeat all', one: 'Repeat one' } as const;
export function PlayModes() {
  const repeat = usePlayer(s => s.repeat);
  const shuffle = usePlayer(s => s.shuffle);
  return <span className="play-modes">
    <button type="button" className="icon-button" aria-label="Shuffle" title="Shuffle" aria-pressed={shuffle} onClick={() => player.shuffle(!shuffle)}><Shuffle aria-hidden="true" /></button>
    <button type="button" className="icon-button" aria-label={repeatName[repeat]} title={repeatName[repeat]} aria-pressed={repeat !== 'off'} onClick={() => player.repeat(nextRepeat(repeat))}>
      {repeat === 'one' ? <Repeat1 aria-hidden="true" /> : <Repeat aria-hidden="true" />}
    </button>
  </span>;
}

// The seek squiggle. The only part of the deck or mini player that follows position snapshots.
export function Position({ track, palette }: { track: Track; palette: Palette }) {
  const position = usePlayer(s => s.position);
  const duration = usePlayer(s => s.duration);
  const playing = usePlayer(s => s.playing);
  const entry = usePlayer(currentEntry);
  // A station is live: the squiggle says so, and there is nothing to seek.
  const live = isStation(track);
  return <Squiggle label={live ? `${track.title}, live. There is no position to seek to.` : `Position in ${track.title}`} identity={entry ?? track.id}
    position={position} duration={duration || (track.duration ?? 0)} playing={playing}
    color={palette.accent} rest={alpha(palette.ink, .22)} onSeek={player.seek} live={live} />;
}

// The line under the title: the artist, or for a station, what it says is on. When it says nothing
// (and the browser can't hear it say anything), it's just internet radio.
export function useByline(track: Track | undefined) {
  const announced = usePlayer(s => s.stationTitle);
  return !track ? '' : isStation(track) ? announced ?? 'Internet radio' : track.artist;
}

// The playing song's star, beside the deck's Lyrics, Queue, and Mini player toggles. It shares
// the optimistic favorites store with every list, so they agree. Songs from this computer have none.
export function FavoriteToggle({ track }: { track: Track }) {
  useFavoritesVersion();
  const connected = usePlayer(s => s.connected);
  if (track.source !== 'navidrome' || !connected) return null;
  const on = isStarred(track.id, track.starred);
  const toggle = async () => {
    const result = await setStarred('track', [track.id], !on);
    if (!result.ok) player.showError(result.error);
  };
  return <button type="button" className="icon-button favorite" aria-label="Favorite" title={on ? 'Remove from favorites' : 'Add to favorites'}
    aria-pressed={on} onClick={() => void toggle()}><Star aria-hidden="true" fill={on ? 'currentColor' : 'none'} /></button>;
}

// The sleep timer, in a few quiet words under the song, while one is set.
export function SleepNote() {
  const note = useSleepNote();
  return note ? <p className="sleep-note">{note}</p> : null;
}
