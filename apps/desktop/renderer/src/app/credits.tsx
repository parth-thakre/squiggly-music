import type { ReactNode } from 'react';
import type { ArtistRef } from '../../../../../packages/core/contracts';
import { nav } from './route';

// An artist credit where each credited artist is its own link. The server's display text (and
// its separators, "&" or ",") stays as written; the names it lists separately, with their own
// pages, become links inside it. A credit the server keeps whole links to its one artist.
export function Credits({ text, artistId, artists, strong = false }: { text: string; artistId?: string | null; artists?: ArtistRef[]; strong?: boolean }) {
  const link = (id: string, name: string) => <button key={id} type="button" className="link" onClick={() => nav.go({ view: 'artist', id })}>{name}</button>;
  if (!artists || artists.length < 2) return artistId ? link(artistId, text) : strong ? <strong>{text}</strong> : <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const artist of artists) {
    const found = text.indexOf(artist.name, at);
    // A name the display text doesn't spell out: list the artists plainly instead.
    if (found < 0) return <>{artists.map((a, i) => <span key={a.id}>{i > 0 && ', '}{link(a.id, a.name)}</span>)}</>;
    if (found > at) parts.push(text.slice(at, found));
    parts.push(link(artist.id, artist.name));
    at = found + artist.name.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
