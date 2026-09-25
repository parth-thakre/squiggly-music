import { useEffect, useState, type ReactNode } from 'react';
import { api, onLibraryReset } from './library';
import { neutral, paletteFromImage, type Palette } from './palette';

// The palette before any art loads; it lives with the contrast rules it is tested against.
export { neutral };

export function Glyph({ kind }: { kind: 'play' | 'pause' | 'prev' | 'next' | 'volume' | 'star' | 'starred' }) {
  const paths = {
    play: <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />,
    pause: <><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></>,
    prev: <><rect x="5" y="5" width="2.4" height="14" rx="1" /><path d="M19 6.2v11.6a.9.9 0 0 1-1.38.76L9.3 12.76a.9.9 0 0 1 0-1.52l8.32-5.8A.9.9 0 0 1 19 6.2z" /></>,
    next: <><rect x="16.6" y="5" width="2.4" height="14" rx="1" /><path d="M5 6.2v11.6a.9.9 0 0 0 1.38.76l8.32-5.8a.9.9 0 0 0 0-1.52L6.38 5.44A.9.9 0 0 0 5 6.2z" /></>,
    volume: <><path d="M4 9.5h3.2L12 5.2v13.6l-4.8-4.3H4z" /><path d="M15.5 8.8a4.6 4.6 0 0 1 0 6.4M18 6.4a8 8 0 0 1 0 11.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></>,
    star: <path d="M12 4.2l2.3 4.9 5.3.6-3.9 3.6 1.1 5.3L12 16l-4.8 2.6 1.1-5.3-3.9-3.6 5.3-.6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
    starred: <path d="M12 4.2l2.3 4.9 5.3.6-3.9 3.6 1.1 5.3L12 16l-4.8 2.6 1.1-5.3-3.9-3.6 5.3-.6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">{paths[kind]}</svg>;
}

// The squiggle is the app's one "playing" mark, at every size.
export function Wave({ playing }: { playing: boolean }) {
  return <svg className={`wave${playing ? ' moving' : ''}`} viewBox="0 0 24 8" role="img" aria-label={playing ? 'Playing' : 'Paused'}>
    <path d="M1 4 Q 4 0 7 4 T 13 4 T 19 4 T 25 4 T 31 4 T 37 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>;
}

// Covers are requested near their displayed size; the library never loads full-size art for thumbnails.
export function Cover({ id, name, size, className }: { id: string | null | undefined; name: string; size: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id]);
  const classes = `cover${className ? ` ${className}` : ''}`;
  if (!id || failed) return <div className={`${classes} cover-type`} role="img" aria-label={`${name}, no cover art`}><span>{name}</span></div>;
  return <img className={classes} src={api.coverUrl(id, size)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

// Palettes are keyed by cover art id, which only means something on one server.
const palettes = new Map<string, Promise<Palette>>();
onLibraryReset(() => palettes.clear());
export function usePalette(coverArt: string | null | undefined): Palette {
  const [palette, setPalette] = useState<Palette>(neutral);
  useEffect(() => {
    if (!coverArt) { setPalette(neutral); return; }
    let live = true;
    let entry = palettes.get(coverArt);
    if (!entry) {
      entry = paletteFromImage(api.coverUrl(coverArt, 64)).catch(() => neutral);
      palettes.set(coverArt, entry);
      if (palettes.size > 200) palettes.delete(palettes.keys().next().value!);
    }
    void entry.then(p => { if (live) setPalette(p); });
    return () => { live = false; };
  }, [coverArt]);
  return palette;
}

// Real titles carry qualifiers: "(Original Motion Picture Soundtrack)", "- Single", "[From "Film"]".
// Only recognised release qualifiers split off, so "I'm Gonna Be (500 Miles)" stays whole.
const qualifier = /\b(soundtrack|single|ep|version|remix|mix|edit|live|remaster(ed)?|deluxe|edition|acoustic|instrumental|demo|mono|stereo|title track|bonus|feat\.?|ft\.|from)\b/i;
export function splitTitle(title: string, album?: string): { main: string; extra: string } {
  let main = title.trim();
  const extras: string[] = [];
  for (let guard = 0; guard < 6; guard++) {
    const bracket = main.match(/\s*[([]([^()[\]]+)[)\]]\s*$/);
    if (bracket?.index && qualifier.test(bracket[1])) { extras.unshift(bracket[1].trim()); main = main.slice(0, bracket.index).trim(); continue; }
    const dash = main.match(/\s+-\s+([^-]+)$/);
    if (dash?.index && qualifier.test(dash[1])) { extras.unshift(dash[1].trim()); main = main.slice(0, dash.index).trim(); continue; }
    break;
  }
  const own: string | undefined = album ? splitTitle(album).main.toLowerCase() : undefined;
  const extra = extras.filter(e => !(own && /^from\s/i.test(e) && e.toLowerCase().includes(own))).join(', ');
  return { main: main || title, extra };
}

// Minutes and seconds, "--:--" when unknown.
export function time(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return '--:--';
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
// Fisher-Yates, on a copy.
export function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}
export const plural = (n: number, word: string) => `${n.toLocaleString()} ${n === 1 ? word : `${word}s`}`;
export function length(seconds: number) {
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}
export const kHz = (rate: number | null | undefined) => rate ? `${(rate / 1000).toLocaleString('en', { maximumFractionDigits: 1 })} kHz` : null;

export function Status({ children }: { children: ReactNode }) { return <p className="status">{children}</p>; }
