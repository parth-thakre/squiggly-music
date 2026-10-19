import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isStation } from '../../../../../packages/core/stations';
import type { LyricLine, LyricWord, Lyrics as LyricsData, Track } from '../../../../../packages/core/contracts';
import { timeWords } from '../../../../../packages/lyrics/words';
import { api, useResource } from './library';
import { current, getPlayer, livePosition, player, usePlayer } from './player';
import { nav, useRoute } from './route';
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

// A song's lyrics, shared by the sheet and the deck (one lookup for both).
function useLyrics(track: Track) {
  const { lyricsLookup } = useSettings();
  const result = useResource(`lyrics:${track.id}:${lyricsLookup}`, () => api.lyrics(
    { id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration }, lyricsLookup));
  const raw = result?.ok ? result.value : null;
  // Lyrics from an older bridge may lack word times; complete them the same way the server does.
  const lyrics = useMemo((): LyricsData | null => raw && raw.wordTiming === undefined ? { ...raw, ...timeWords(raw) } : raw, [raw]);
  return { result, lyrics, lyricsLookup };
}

function LyricSheet({ track, compact }: { track: Track; compact: boolean }) {
  const { result, lyrics, lyricsLookup } = useLyrics(track);
  const playing = usePlayer(s => s.playing);
  // Only a paused position matters here; while playing, the loop below reads the live clock.
  const pausedAt = usePlayer(s => s.playing ? -1 : s.position);
  const list = useRef<HTMLOListElement>(null);
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

// The deck's lyrics: in the room the deck has spare under its controls, the synced lines around the
// one being sung, that line in ink and centred. Clicking opens the lyric sheet. Nothing shows while
// the sheet is open, for a station, for lyrics that aren't timed, or without room for three lines.
export function DeckLyrics() {
  const track = usePlayer(current);
  const route = useRoute();
  if (!track || isStation(track) || route.view === 'lyrics') return null;
  return <DeckLines key={track.id} track={track} />;
}
// The synced line being sung, looked at again when the next one is due to start rather than every
// frame: a song plays for minutes and its lines change every few seconds. While playing it also
// looks every CHECK_MS, so a seek shows its line that soon. A React update only when it changes.
// `ends`: past a line's end (where the lyrics give one) none is being sung until the next starts,
// so the mini player's one line goes quiet through an instrumental break. The deck keeps the last
// line lit, with the lines around it to place it.
const CHECK_MS = 250;
function useLineNow(synced: readonly LyricLine[] | null, playing: boolean, pausedAt: number, ends = false) {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    if (!synced) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      timer = undefined;
      const now = livePosition() + LEAD;
      const at = lineAt(synced, now);
      const end = ends ? synced[at]?.end ?? null : null;
      const over = end !== null && now >= end;
      setActive(over ? -1 : at);
      if (!playing || document.hidden) return;
      const due = [synced[at + 1]?.start ?? null, over ? null : end].filter((time): time is number => time !== null);
      timer = setTimeout(check, due.length ? Math.min(CHECK_MS, Math.max(0, (Math.min(...due) - now) * 1000) + 5) : CHECK_MS);
    };
    check();
    const wake = () => { if (!timer && !document.hidden) check(); };
    document.addEventListener('visibilitychange', wake);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', wake); };
  }, [synced, playing, pausedAt, ends]);
  return active;
}

// The mini player's one line: the synced line being sung, nothing between lines or before the
// first, and nothing at all for a station or lyrics that aren't timed. It's there to glance at,
// so assistive tech isn't told each line; the lyric sheet in the full window has them all. With
// word times it fills word by word as the sheet does: while the line is sung (and only then), each
// word's progress goes straight to its span as --p once a frame, and nothing re-renders.
export function SungLine({ track, below = false }: { track: Track; below?: boolean }) {
  const { lyrics } = useLyrics(track);
  const playing = usePlayer(s => s.playing);
  const pausedAt = usePlayer(s => s.playing ? -1 : s.position);
  const synced = !isStation(track) && lyrics?.synced ? lyrics.lines : null;
  const active = useLineNow(synced, playing, pausedAt, true);
  const line = synced?.[active];
  const words = line?.words?.length ? line.words : null;
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!words || !element) return;
    const spans = Array.from(element.querySelectorAll<HTMLElement>('.word'));
    const values: number[] = [];
    let frame = 0;
    const paint = () => {
      frame = 0;
      const now = livePosition() + LEAD, whole = reducedMotion.matches;
      let sung = true;
      for (let k = 0; k < words.length && k < spans.length; k++) {
        const p = progressOf(words[k], now, whole);
        if (p < 1) sung = false;
        if (p === values[k]) continue;
        values[k] = p;
        spans[k].style.setProperty('--p', String(p));
      }
      // The last word filled: nothing more to draw until the next line.
      if (playing && !document.hidden && !sung) frame = requestAnimationFrame(paint);
    };
    paint();
    const wake = () => { if (!frame && !document.hidden) paint(); };
    document.addEventListener('visibilitychange', wake);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', wake); };
  }, [words, playing, pausedAt]);
  if (!synced) return null;
  const text = line?.text ?? '';
  return <p className={`mini-lyric${below ? ' below' : ''}`} aria-hidden="true" title={text || undefined}><span key={active} ref={box}>{words ? words.map((word, k) => {
    const [, said, space] = /^([\s\S]*?)(\s*)$/.exec(word.text)!;
    return <Fragment key={k}><span className="word">{said}</span>{space}</Fragment>;
  }) : text}</span></p>;
}

const ROOM_LINES = 3, GAP = 18;
function DeckLines({ track }: { track: Track }) {
  const { lyrics } = useLyrics(track);
  const playing = usePlayer(s => s.playing);
  const pausedAt = usePlayer(s => s.playing ? -1 : s.position);
  const box = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [room, setRoom] = useState(false);
  const synced = lyrics?.synced ? lyrics.lines : null;

  const active = useLineNow(synced, playing, pausedAt);

  // Whether three lines fit, and the list moved so the current line sits a little above the
  // middle. Early on the first line stays at the top (GAP below the stars) rather than leaving
  // the room above empty; the top fades only once lines have gone past it.
  useLayoutEffect(() => {
    const view = box.current, ol = list.current;
    if (!view || !ol) return;
    const place = () => {
      const line = ol.children[Math.max(0, active)] as HTMLElement | undefined;
      const height = (ol.children[0] as HTMLElement | undefined)?.offsetHeight ?? Infinity;
      setRoom(view.clientHeight >= GAP + height * ROOM_LINES);
      if (!line) return;
      const shift = Math.min(GAP, Math.round(view.clientHeight * .42 - line.offsetTop - line.offsetHeight / 2));
      ol.style.transform = `translateY(${shift}px)`;
      view.classList.toggle('scrolled', shift < GAP);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(view);
    return () => observer.disconnect();
  }, [active, synced]);

  if (!synced) return null;
  return <button ref={box} type="button" className={`deck-lyrics${room ? "" : " no-room"}`} aria-label="Open the lyrics" onClick={() => nav.go({ view: 'lyrics' })}>
    <ol ref={list} aria-hidden="true">
      {synced.map((line, i) => <li key={i} className={i === active ? 'current' : undefined}>{line.text || '\u00a0'}</li>)}
    </ol>
  </button>;
}

