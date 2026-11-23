import { memo, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api, onLibraryReset } from './library';
import { neutral, paletteFromImage, standInOf, type Palette } from './palette';

// The palette before any art loads; it lives with the contrast rules it is tested against.
export { neutral };

export function Glyph({ kind }: { kind: 'play' | 'pause' | 'prev' | 'next' | 'volume' | 'star' | 'starred' | 'heart' | 'hearted' }) {
  const paths = {
    // Its box sits right of centre by 0.09 of its width, as Spotify's does: the triangle then reads as centred in a disc.
    play: <path d="M6.9 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L8.4 4.64A1 1 0 0 0 6.9 5.5z" />,
    pause: <><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></>,
    prev: <><rect x="5" y="5" width="2.4" height="14" rx="1" /><path d="M19 6.2v11.6a.9.9 0 0 1-1.38.76L9.3 12.76a.9.9 0 0 1 0-1.52l8.32-5.8A.9.9 0 0 1 19 6.2z" /></>,
    next: <><rect x="16.6" y="5" width="2.4" height="14" rx="1" /><path d="M5 6.2v11.6a.9.9 0 0 0 1.38.76l8.32-5.8a.9.9 0 0 0 0-1.52L6.38 5.44A.9.9 0 0 0 5 6.2z" /></>,
    volume: <><path d="M4 9.5h3.2L12 5.2v13.6l-4.8-4.3H4z" /><path d="M15.5 8.8a4.6 4.6 0 0 1 0 6.4M18 6.4a8 8 0 0 1 0 11.2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></>,
    star: <path d="M12 4.2l2.3 4.9 5.3.6-3.9 3.6 1.1 5.3L12 16l-4.8 2.6 1.1-5.3-3.9-3.6 5.3-.6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
    starred: <path d="M12 4.2l2.3 4.9 5.3.6-3.9 3.6 1.1 5.3L12 16l-4.8 2.6 1.1-5.3-3.9-3.6 5.3-.6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
    // Favorites are a heart, so they never read as a rating's stars.
    heart: <path d="M12 19.3s-7.2-4.4-7.2-9.6A4.1 4.1 0 0 1 12 7.2a4.1 4.1 0 0 1 7.2 2.5c0 5.2-7.2 9.6-7.2 9.6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
    hearted: <path d="M12 19.3s-7.2-4.4-7.2-9.6A4.1 4.1 0 0 1 12 7.2a4.1 4.1 0 0 1 7.2 2.5c0 5.2-7.2 9.6-7.2 9.6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">{paths[kind]}</svg>;
}

// Wider than a phone (app.css's 760px layout). What a phone's layout hides isn't built there:
// its rows' rating stars, the deck's lyrics.
const wide = typeof matchMedia === 'function' ? matchMedia('(min-width: 761px)') : null;
const onWidth = (listener: () => void) => { wide?.addEventListener('change', listener); return () => wide?.removeEventListener('change', listener); };
export const useWide = () => useSyncExternalStore(onWidth, () => wide?.matches ?? true);

// The squiggle is the app's one "playing" mark, at every size. The drawing is twice the mark's
// width and slides inside it a wave at a time; moving the HTML box holding the picture, rather than
// its path or the picture itself, lets the compositor animate it, so a playing row costs the page
// nothing each frame.
export function Wave({ playing }: { playing: boolean }) {
  return <span className={`wave${playing ? ' moving' : ''}`} role="img" aria-label={playing ? 'Playing' : 'Paused'}>
    <span className="wave-strip"><svg viewBox="0 0 48 8" aria-hidden="true">
      <path d="M1 4 Q 4 0 7 4 T 13 4 T 19 4 T 25 4 T 31 4 T 37 4 T 43 4 T 49 4 T 55 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg></span>
  </span>;
}

// Covers are requested near their displayed size; the library never loads full-size art for thumbnails.
// Whether the server's picture of an artist is its stock one (palette.ts), read from the picture
// once the page has loaded it, so a long list fetches nothing it isn't showing. Until it's known,
// and if it can't be read, the picture counts as real.
const standIns = new Map<string, boolean>();
onLibraryReset(() => standIns.clear());

// `portrait`: an artist's picture. The server's stock picture gives way to the artist's initial,
// so every artist without a picture looks the same.
// `eager`: above-the-fold hero or deck art, loaded immediately at high priority.
export const Cover = memo(function Cover({ id, name, size, className, portrait = false, eager = false }: { id: string | null | undefined; name: string; size: number; className?: string; portrait?: boolean; eager?: boolean }) {
  const [failedId, setFailedId] = useState<string | null>(null);
  const [plainId, setPlainId] = useState<string | null>(null);
  // A cover that failed is retried once the component shows another one and comes back.
  if (failedId !== null && failedId !== id) setFailedId(null);
  const failed = !!id && failedId === id;
  const known = portrait && !!id && standIns.get(id) === true;
  const plain = known || (portrait && !!id && plainId === id);
  const classes = `cover${className ? ` ${className}` : ''}`;
  if (!id || failed || plain) return <div className={`${classes} cover-type${size <= 160 ? ' initial' : ''}`} role="img" aria-label={`${name}, no cover art`}><span>{size <= 160 ? Array.from(name.trim())[0]?.toUpperCase() : splitTitle(name).main}</span></div>;
  const loading = eager ? 'eager' : 'lazy';
  const fetchPriority = eager ? 'high' : undefined;
  if (!portrait) return <img className={classes} src={api.coverUrl(id, size)} alt="" loading={loading} fetchPriority={fetchPriority} decoding="async"
    onLoad={size >= 600 ? () => markCoverWarm(id) : undefined} onError={() => setFailedId(id)} />;
  return <img className={classes} crossOrigin="anonymous" src={api.coverUrl(id, size)} alt="" loading={loading} fetchPriority={fetchPriority} decoding="async" onError={() => setFailedId(id)}
    onLoad={event => {
      let stock = standIns.get(id);
      if (stock === undefined) {
        stock = standInOf(event.currentTarget);
        standIns.set(id, stock);
        if (standIns.size > 400) standIns.delete(standIns.keys().next().value!);
      }
      if (stock) setPlainId(id);
    }} />;
});

// Palettes are keyed by cover art id, which only means something on one server.
const palettes = new Map<string, Promise<Palette>>();
onLibraryReset(() => palettes.clear());
export function usePalette(coverArt: string | null | undefined): Palette {
  const [palette, setPalette] = useState<Palette>(neutral);
  useEffect(() => {
    if (!coverArt) { setPalette(neutral); return; }
    let live = true;
    void paletteOf(coverArt).then(p => { if (live) setPalette(p); });
    return () => { live = false; };
  }, [coverArt]);
  return palette;
}
function paletteOf(coverArt: string) {
  let entry = palettes.get(coverArt);
  if (!entry) {
    entry = paletteFromImage(api.coverUrl(coverArt, 64)).catch(() => neutral);
    palettes.set(coverArt, entry);
    if (palettes.size > 200) palettes.delete(palettes.keys().next().value!);
  }
  return entry;
}

// The next song's sleeve and colours, fetched while this one plays, so they change with the music
// rather than seconds after it on a slow connection. A brief delay lets the current song's own
// cover and stream start first; already-warmed covers show immediately. The 600px sleeve is asked
// for before the 64px palette so the desktop main process serves both from one upstream request.
const earlyImages: HTMLImageElement[] = [];
const warmedCovers = new Set<string>();
const earlyListeners = new Set<() => void>();
const onEarly = (listener: () => void) => { earlyListeners.add(listener); return () => { earlyListeners.delete(listener); }; };
onLibraryReset(() => { warmedCovers.clear(); earlyImages.length = 0; });
function markCoverWarm(coverArt: string) {
  if (warmedCovers.has(coverArt)) return;
  warmedCovers.add(coverArt);
  if (warmedCovers.size > 160) warmedCovers.delete(warmedCovers.values().next().value!);
  for (const listener of earlyListeners) listener();
}
export function useNextCover(coverArt: string | null | undefined, size: number) {
  useEffect(() => {
    if (!coverArt) return;
    const warm = () => {
      const img = new Image();
      img.decoding = 'async';
      img.src = api.coverUrl(coverArt, size);
      earlyImages.push(img);
      if (earlyImages.length > 4) earlyImages.shift();
      void paletteOf(coverArt);
      markCoverWarm(coverArt);
    };
    if (warmedCovers.has(coverArt)) { void paletteOf(coverArt); return; }
    const timer = setTimeout(warm, 350);
    return () => clearTimeout(timer);
  }, [coverArt, size]);
}
// Whether the next song's sleeve has been asked for (or already loaded at full deck size), so it
// shows at once when warm and waits only briefly behind the current song when cold.
export const useNextCoverAsked = (coverArt: string | null | undefined) => useSyncExternalStore(onEarly, () => !!coverArt && warmedCovers.has(coverArt));

// Real titles carry qualifiers: "(Original Motion Picture Soundtrack)", "- Single", "[From "Film"]".
// Only recognised release qualifiers split off, so "I'm Gonna Be (500 Miles)" stays whole.
// On a record title (no `album` argument), a tail that only says it is a soundtrack is dropped.
const qualifier = /\b(soundtrack|single|ep|version|remix|mix|edit|live|remaster(ed)?|deluxe|edition|acoustic|instrumental|demo|mono|stereo|title track|bonus|feat\.?|ft\.|from|reprise|unplugged|explicit|clean|film|radio)\b/i;
const cleanHyphens = (text: string) => text.replace(/[‐‑]/g, '-');
export function splitTitle(title: string, album?: string): { main: string; extra: string } {
  let main = cleanHyphens(title).trim();
  const extras: string[] = [];
  for (let guard = 0; guard < 6; guard++) {
    const bracket = main.match(/\s*[([]([^()[\]]+)[)\]]\s*$/);
    if (bracket?.index && qualifier.test(bracket[1])) { extras.unshift(bracket[1].trim()); main = main.slice(0, bracket.index).trim(); continue; }
    const dash = main.match(/\s+[-–—]\s+([^-–—]+)$/);
    if (dash?.index && qualifier.test(dash[1])) { extras.unshift(dash[1].trim()); main = main.slice(0, dash.index).trim(); continue; }
    break;
  }
  const own: string | undefined = album ? splitTitle(album).main.toLowerCase() : undefined;
  const filtered = extras.filter(e => {
    if (own && /^from\s/i.test(e) && e.toLowerCase().includes(own)) return false;
    if (!album && /\bsoundtrack\b/i.test(e)) return false;
    return true;
  });
  const joined = filtered.join(', ');
  const extra = joined ? joined[0].toUpperCase() + joined.slice(1) : '';
  return { main: main || cleanHyphens(title), extra };
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
// One formatter each, made once: toLocaleString builds a new one on every call, which made
// plural() a tenth of the work of scrolling a long artist list.
const count = new Intl.NumberFormat();
const kilohertz = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
export const plural = (n: number, word: string) => `${count.format(n)} ${n === 1 ? word : `${word}s`}`;
export function length(seconds: number) {
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}
export const kHz = (rate: number | null | undefined) => rate ? `${kilohertz.format(rate / 1000)} kHz` : null;

export function Status({ children }: { children: ReactNode }) { return <p className="status">{children}</p>; }
