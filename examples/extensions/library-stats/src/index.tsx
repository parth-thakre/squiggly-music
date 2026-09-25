import { useEffect, useState } from 'react';
import { defineExtension, type ExtensionContext, type LibraryApi } from '@squiggly/extension-api';

interface Stats {
  artists: number; albums: number; songs: number; hours: number; genres: number; playlists: number;
  topGenres: { name: string; songs: number }[];
  decades: { decade: number; albums: number }[];
  countedAt: string;
}

export default defineExtension({
  activate(ctx) {
    const page = ctx.navigation.registerPage({ id: 'stats', title: 'Library stats', component: () => <StatsPage ctx={ctx} /> });
    ctx.commands.register({ id: 'open', title: 'Open library stats', category: 'Go to', run: () => ctx.navigation.openPage(page.id) });
  },
});

// Pages through every record, 500 at a time. The result is kept until "Count again".
let cached: Stats | null = null;
async function count(library: LibraryApi): Promise<Stats> {
  const [artists, genres, playlists] = await Promise.all([library.artists(), library.genres(), library.playlists()]);
  if (!artists.ok) throw new Error(artists.error);
  let albums = 0, songs = 0, seconds = 0;
  const decades = new Map<number, number>();
  for (let offset = 0; ; offset += 500) {
    const page = await library.albums('alphabeticalByName', offset, 500);
    if (!page.ok) throw new Error(page.error);
    for (const album of page.value) {
      albums++; songs += album.songCount; seconds += album.duration ?? 0;
      if (album.year) { const decade = Math.floor(album.year / 10) * 10; decades.set(decade, (decades.get(decade) ?? 0) + 1); }
    }
    if (page.value.length < 500) break;
  }
  return {
    artists: artists.value.length, albums, songs, hours: Math.round(seconds / 360) / 10,
    genres: genres.ok ? genres.value.length : 0, playlists: playlists.ok ? playlists.value.length : 0,
    topGenres: genres.ok ? [...genres.value].sort((a, b) => b.songCount - a.songCount).slice(0, 8).map(g => ({ name: g.name, songs: g.songCount })) : [],
    decades: [...decades].sort((a, b) => a[0] - b[0]).map(([decade, albums]) => ({ decade, albums })),
    countedAt: new Date().toISOString(),
  };
}

function StatsPage({ ctx }: { ctx: ExtensionContext }) {
  const [stats, setStats] = useState<Stats | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [counting, setCounting] = useState(false);
  const connected = ctx.player.use(state => state.connected);
  const load = (fresh: boolean) => {
    if (cached && !fresh) { setStats(cached); return; }
    setCounting(true); setError(null);
    count(ctx.library).then(result => { cached = result; setStats(result); }, (reason: Error) => setError(reason.message)).finally(() => setCounting(false));
  };
  useEffect(() => { if (connected) load(false); }, [connected]);

  return <>
    <header className="head"><div className="head-text">
      <h1>Library stats</h1>
      <div className="actions"><button type="button" className="text-button" disabled={counting || !connected} onClick={() => load(true)}>{counting ? 'Counting…' : 'Count again'}</button></div>
    </div></header>
    {!connected && <p className="status">Connect to your server to count your library.</p>}
    {error && <p className="note" role="alert">{error}</p>}
    {stats && <>
      <table className="facts"><tbody>
        <Row label="Artists" value={stats.artists} />
        <Row label="Records" value={stats.albums} />
        <Row label="Songs" value={stats.songs} />
        <Row label="Hours of music" value={stats.hours} />
        <Row label="Genres" value={stats.genres} />
        <Row label="Playlists" value={stats.playlists} />
      </tbody></table>
      {stats.topGenres.length > 0 && <><h2>Biggest genres</h2><table className="facts"><tbody>
        {stats.topGenres.map(genre => <Row key={genre.name} label={genre.name} value={genre.songs} unit="songs" />)}
      </tbody></table></>}
      {stats.decades.length > 0 && <><h2>Records by decade</h2><table className="facts"><tbody>
        {stats.decades.map(decade => <Row key={decade.decade} label={`${decade.decade}s`} value={decade.albums} unit="records" />)}
      </tbody></table></>}
      <p className="note">Counted {new Date(stats.countedAt).toLocaleString()}.</p>
    </>}
  </>;
}

function Row({ label, value, unit }: { label: string; value: number; unit?: string }) {
  return <tr><th>{label}</th><td>{value.toLocaleString()}{unit ? ` ${unit}` : ''}</td></tr>;
}
