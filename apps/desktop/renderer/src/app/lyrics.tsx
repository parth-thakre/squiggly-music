import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isStation } from '../../../../../packages/core/stations';
import type { LyricLine, LyricWord, Lyrics as LyricsData, Track } from '../../../../../packages/core/contracts';
import { timeWords } from '../../../../../packages/lyrics/words';
import { api, useResource } from './library';
import { current, getPlayer, livePosition, player, usePlayer } from './player';
import { nav } from './route';
import { updateSettings, useSettings } from './settings';
import { reducedMotion } from './theme';
import { splitTitle } from './ui';

// Lines and words light a moment early, so the change lands as the singing starts rather than just after.
const LEAD = .1;
// After the listener scrolls, the sheet leaves the scroll alone this long.
const BROWSE_MS = 4000;
// Where the current line sits, as a share of the view's height from its top.
const FOLLOW_AT = .32;

// The lyric sheet. Synced lyrics are big lines in ink: the current line's words fill in as
// they're sung, lines around it are dimmer, and the sheet keeps the current line a third of the
// way down unless the listener has just scrolled. Clicking a synced line seeks to it. The
// accent colour is never used for the words.
export function Lyrics({ compact = false }: { compact?: boolean }) {
  const track = usePlayer(current);
  if (!track) return <p className="status">Play a song to see its lyrics.</p>;
  if (isStation(track)) return <p className="status">Radio stations have no lyrics here.</p>;
  return <LyricSheet key={track.id} track={track} compact={compact} />;
}

// The last line that has started by `now`. Synced lines are in time order.
function lineAt(lines: readonly LyricLine[], now: number) {
  let low = 0, high = lines.length - 1, at = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((lines[mid].start ?? Infinity) <= now) { at = mid; low = mid + 1; } else high = mid - 1;
  }
  return at;
}
// How far a word has been sung, 0 to 1. Whole words only under reduced motion.
function progressOf(word: LyricWord, now: number, whole: boolean) {
  if (whole || word.end <= word.start) return now >= word.start ? 1 : 0;
  return Math.round(Math.min(1, Math.max(0, (now - word.start) / (word.end - word.start))) * 1000) / 1000;
}
// The element that scrolls the sheet: the page on desktop, the sheet itself on a phone.
function scrollerOf(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

function LyricSheet({ track, compact }: { track: Track; compact: boolean }) {
  const { lyricsLookup } = useSettings();
  const result = useResource(`lyrics:${track.id}:${lyricsLookup}`, () => api.lyrics(
    { id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration }, lyricsLookup));
  const playing = usePlayer(s => s.playing);
  // Only a paused position matters here; while playing, the loop below reads the live clock.
  const pausedAt = usePlayer(s => s.playing ? -1 : s.position);
  const list = useRef<HTMLOListElement>(null);
  const raw = result?.ok ? result.value : null;
  // Lyrics from an older bridge may lack word times; complete them the same way the server does.
  const lyrics = useMemo((): LyricsData | null => raw && raw.wordTiming === undefined ? { ...raw, ...timeWords(raw) } : raw, [raw]);
  const [active, setActive] = useState(-1);
  const [browsing, setBrowsing] = useState(false);
  const browseTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const browse = () => {
    clearTimeout(browseTimer.current);
    browseTimer.current = setTimeout(() => setBrowsing(false), BROWSE_MS);
    setBrowsing(true);
  };
  useEffect(() => () => clearTimeout(browseTimer.current), []);

  // One animation frame loop while playing and visible. It picks the current line (a React
  // update only when the line changes) and writes each of its words' progress straight to the
  // word spans as --p and data-progress. Paused, it paints once.
  useEffect(() => {
    const ol = list.current;
    if (!lyrics?.synced || !ol) { setActive(-1); return; }
    const lines = lyrics.lines;
    let frame = 0, shown = -2, spans: HTMLElement[] = [], values: number[] = [];
    const clear = () => {
      for (const span of spans) { span.style.removeProperty('--p'); delete span.dataset.progress; }
    };
    const paint = () => {
      frame = 0;
      const now = livePosition() + LEAD;
      const at = lineAt(lines, now);
      if (at !== shown) {
        clear();
        shown = at; values = [];
        spans = at >= 0 ? Array.from(ol.children[at]?.querySelectorAll<HTMLElement>('.word') ?? []) : [];
        setActive(at);
      }
      const words = at >= 0 ? lines[at].words : undefined;
      if (words) {
        const whole = reducedMotion.matches;
        for (let k = 0; k < words.length && k < spans.length; k++) {
          const p = progressOf(words[k], now, whole);
          if (p === values[k]) continue;
          values[k] = p;
          spans[k].style.setProperty('--p', String(p));
          spans[k].dataset.progress = String(p);
        }
      }
      if (playing && !document.hidden) frame = requestAnimationFrame(paint);
    };
    paint();
    const wake = () => { if (!frame && !document.hidden) paint(); };
    document.addEventListener('visibilitychange', wake);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', wake); clear(); };
  }, [lyrics, playing, pausedAt]);

  // Keep the current line a third of the way down, unless the listener is looking around.
  useEffect(() => {
    if (active < 0 || browsing) return;
    const line = list.current?.children[active] as HTMLElement | undefined;
    const view = line && scrollerOf(line);
    if (!line || !view) return;
    const top = view.scrollTop + line.getBoundingClientRect().top - view.getBoundingClientRect().top - view.clientHeight * FOLLOW_AT;
    view.scrollTo({ top: Math.max(0, top), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }, [active, browsing]);

  const seek = useCallback((start: number) => {
    clearTimeout(browseTimer.current);
    setBrowsing(false);
    player.seek(start);
    if (!getPlayer().playing) player.toggle();
  }, []);

  const name = splitTitle(track.title, track.album).main;
  return <div className={`lyrics${compact ? ' compact' : ''}${browsing ? ' browsing' : ''}`} onWheel={browse} onTouchMove={browse}>
    {!compact && <header className="lyrics-head"><h1>{name}</h1><p>{track.artist}</p></header>}
    {!result ? <p className="status loading">Finding the words</p>
      : !result.ok ? <p className="status">{result.error}</p>
      : !lyrics ? <div className="lyrics-none">
          <p className="status">No lyrics for this song{lyricsLookup ? ', on your server or on LRCLIB.' : ' on your server.'}</p>
          {!lyricsLookup && <p className="note">Online lookup is off. <button type="button" className="link" onClick={() => void updateSettings({ lyricsLookup: true })}>
            Look up lyrics on LRCLIB</button> sends the song's title and artist to lrclib.net. You can turn it off again in Settings.</p>}
        </div>
      : <>
        <ol className={`lyric-lines${lyrics.synced ? ' synced' : ''}`} ref={list}>
          {lyrics.lines.map((line, i) => <Line key={i} index={i} line={line} synced={lyrics.synced} onSeek={seek}
            state={!lyrics.synced ? '' : `${i === active ? 'current' : i < active ? 'past' : ''}${Math.abs(i - active) > 2 ? ' far' : ''}`.trim()} />)}
        </ol>
        <p className="lyrics-source">
          {lyrics.source === 'lrclib' && <>Lyrics from LRCLIB. <button type="button" className="link" onClick={() => nav.go({ view: 'settings' })}>Settings</button></>}
          {lyrics.source !== 'lrclib' && !lyrics.synced && 'These lyrics are not timed to the song.'}
        </p>
      </>}
  </div>;
}

// One line. Its words are spans (class "word", data-word = their index) with the space after each
// word left outside, so the fill covers only the letters. Only the class changes as the song plays.
const Line = memo(function Line({ index, line, synced, state, onSeek }: {
  index: number; line: LyricLine; synced: boolean; state: string; onSeek: (start: number) => void;
}) {
  const words = synced && line.words?.length ? line.words.map((word, k) => {
    const [, text, space] = /^([\s\S]*?)(\s*)$/.exec(word.text)!;
    return <Fragment key={k}><span className="word" data-word={k}>{text}</span>{space}</Fragment>;
  }) : line.text;
  return <li data-line={index} className={state || undefined}>
    {synced && line.start !== null && line.text
      ? <button type="button" onClick={() => onSeek(line.start!)}>{words}</button>
      : line.text || <span aria-hidden="true">&nbsp;</span>}
  </li>;
});
