import type { ReactNode } from 'react';
import type { ArtistRef } from '../../../../../packages/core/contracts';
import { nav } from './route';

// Where a credit's own link goes: the first of the artists the server splits it into, or its one artist.
export const firstArtistId = (item: { artistId?: string | null; artists?: ArtistRef[] }) =>
  (item.artists && item.artists.length > 1 ? item.artists[0].id : item.artistId) || undefined;

// An artist credit where each credited artist is its own link. The server's display text (and
// its separators, "&" or ",") stays as written; the names it lists separately, with their own
// pages, become links inside it. A credit the server keeps whole links to its one artist.
export function Credits({ text, artistId, artists, strong = false }: { text: string; artistId?: string | null; artists?: ArtistRef[]; strong?: boolean }) {
  const link = (id: string, name: string) => <button key={id} type="button" className="link" data-warm={`artist:${id}`} onClick={() => nav.go({ view: 'artist', id })}>{name}</button>;
  if (!artists || artists.length < 2) {
    return <span className="artist-credit">{artistId ? link(artistId, text) : strong ? <strong>{text}</strong> : text}</span>;
  }
  const found: number[] = [];
  let at = 0;
  for (const artist of artists) {
    const index = text.indexOf(artist.name, at);
    // A name the display text doesn't spell out: list the artists plainly instead.
    if (index < 0) return <span className="artist-credit">{artists.map((a, i) => <span key={a.id}>{i > 0 && ', '}{link(a.id, a.name)}</span>)}</span>;
    found.push(index);
    at = index + artist.name.length;
  }
  // Each name keeps the separator after it ("Chauhan &", "Singh •", "Ingle,"), so a credit that
  // wraps ends a line with the separator instead of starting the next one with it.
  const parts: ReactNode[] = [];
  if (found[0] > 0) parts.push(text.slice(0, found[0]));
  artists.forEach((artist, i) => {
    const end = found[i] + artist.name.length;
    const between = text.slice(end, i + 1 < artists.length ? found[i + 1] : text.length);
    const mark = between.match(/^\s*[^\s\p{L}\p{N}]+/u);
    const lead = mark ? mark[0] : '';
    parts.push(<span key={`${artist.id}-${i}`} className="credit-name">{link(artist.id, artist.name)}{lead.replace(/\s/g, '\u00a0')}</span>);
    if (between.length > lead.length) parts.push(between.slice(lead.length));
  });
  return <span className="artist-credit">{parts}</span>;
}
