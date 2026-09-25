import { useEffect, useRef } from 'react';
import type { Track } from '../../../../../packages/core/contracts';
import { api, useResource } from './library';
import { current, getPlayer, player, usePlayer } from './player';
import { nav } from './route';
import { updateSettings, useSettings } from './settings';
import { reducedMotion } from './theme';
import { splitTitle } from './ui';

// The lyric sheet. The current line is the only thing in the accent colour; it follows the
// song unless the listener has just scrolled, and clicking a synced line seeks to it.
export function Lyrics({ compact = false }: { compact?: boolean }) {
  const track = usePlayer(current);
  if (!track) return <p className="status">Play a song to see its lyrics.</p>;
  return <LyricSheet key={track.id} track={track} compact={compact} />;
}

function LyricSheet({ track, compact }: { track: Track; compact: boolean }) {
  const { lyricsLookup } = useSettings();
  const result = useResource(`lyrics:${track.id}:${lyricsLookup}`, () => api.lyrics(
    { id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration }, lyricsLookup));
  const position = usePlayer(s => s.position);
  const sheet = useRef<HTMLDivElement>(null);
  const touched = useRef(0);
  const lyrics = result?.ok ? result.value : null;
  const active = lyrics?.synced ? lyrics.lines.reduce((at, line, i) => line.start !== null && line.start <= position + .25 ? i : at, -1) : -1;

  useEffect(() => {
    if (active < 0 || Date.now() - touched.current < 4000) return;
    const line = sheet.current?.querySelector<HTMLElement>(`[data-line="${active}"]`);
    const reduced = reducedMotion.matches;
    line?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }, [active]);

  const name = splitTitle(track.title, track.album).main;
  return <div className={`lyrics${compact ? ' compact' : ''}`} ref={sheet}
    onWheel={() => { touched.current = Date.now(); }} onTouchMove={() => { touched.current = Date.now(); }}>
    {!compact && <header className="lyrics-head"><h1>{name}</h1><p>{track.artist}</p></header>}
    {!result ? <p className="status loading">Finding the words</p>
      : !result.ok ? <p className="status">{result.error}</p>
      : !lyrics ? <div className="lyrics-none">
          <p className="status">No lyrics for this song{lyricsLookup ? ', on your server or on LRCLIB.' : ' on your server.'}</p>
          {!lyricsLookup && <p className="note">Online lookup is off. <button type="button" className="link" onClick={() => void updateSettings({ lyricsLookup: true })}>
            Look up lyrics on LRCLIB</button> sends the song's title and artist to lrclib.net. You can turn it off again in Settings.</p>}
        </div>
      : <>
        <ol className={`lyric-lines${lyrics.synced ? ' synced' : ''}`}>
          {lyrics.lines.map((line, i) => <li key={i} data-line={i} className={i === active ? 'current' : i < active ? 'past' : undefined}>
            {lyrics.synced && line.start !== null && line.text
              ? <button type="button" onClick={() => { touched.current = 0; player.seek(line.start!); if (!getPlayer().playing) player.toggle(); }}>{line.text}</button>
              : line.text || <span aria-hidden="true">&nbsp;</span>}
          </li>)}
        </ol>
        <p className="lyrics-source">{lyrics.source === 'lrclib' ? <>Lyrics from LRCLIB. <button type="button" className="link" onClick={() => nav.go({ view: 'settings' })}>Settings</button></> : !lyrics.synced && 'These lyrics are not timed to the song.'}</p>
      </>}
  </div>;
}
