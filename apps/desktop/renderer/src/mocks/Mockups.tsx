import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, AudioLines, Check, ChevronDown, Disc3, Grid2X2, Headphones, Heart, Library, ListMusic, Music2, Pause, Play, Search, Settings2, SkipBack, SkipForward, SlidersHorizontal, Volume2, X } from 'lucide-react';
import type { ReactNode } from 'react';

const studies = [
  { id: 'cove', name: 'Cove', description: 'A quieter place for your collection.' },
  { id: 'daylight', name: 'Daylight', description: 'A record shelf, with room to breathe.' },
  { id: 'after-hours', name: 'After hours', description: 'One record. Your full attention.' },
  { id: 'studio', name: 'Studio', description: 'The queue and the details, in view.' },
  { id: 'blue-note', name: 'Blue note', description: 'For the joy of finding the next record.' },
] as const;
type Study = typeof studies[number]['id'];
type Presentation = 'albums' | 'tracks';
const records = [
  { album: 'Tides', artist: 'Kei Watanabe', track: 'A place between', year: '2024', genre: 'Ambient', duration: 284, color: 'tides' },
  { album: 'Soft focus', artist: 'Mira Sol', track: 'Sunday, slowly', year: '2023', genre: 'Electronic', duration: 238, color: 'soft' },
  { album: 'Blue hour', artist: 'The North Quartet', track: 'After the rain', year: '2024', genre: 'Jazz', duration: 367, color: 'blue' },
  { album: 'Bloom', artist: 'June & the Pines', track: 'Somewhere green', year: '2022', genre: 'Indie', duration: 216, color: 'bloom' },
  { album: 'Parallel', artist: 'Forma', track: 'Passing through', year: '2024', genre: 'Electronic', duration: 312, color: 'parallel' },
  { album: 'Still life', artist: 'Elio March', track: 'An open window', year: '2023', genre: 'Piano', duration: 192, color: 'still' },
  { album: 'Low sun', artist: 'Alma Coast', track: 'Out of the city', year: '2024', genre: 'Soul', duration: 247, color: 'sun' },
  { album: 'Drift', artist: 'Common Ground', track: 'At a distance', year: '2022', genre: 'Ambient', duration: 329, color: 'drift' },
];
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function Mark() {
  return <svg viewBox="0 0 36 30" fill="none" aria-hidden="true"><path d="M2 17C6 17 4 6 9 6S10 25 15 25 15 4 20 4 21 23 26 23 26 12 34 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>;
}
function Brand() { return <div className="brand"><Mark /><span>squiggly</span></div>; }

function Cover({ index, className = '' }: { index: number; className?: string }) {
  const record = records[index];
  const id = useId().replace(/:/g, '');
  return <div className={`cover cover-${record.color} ${className}`} role="img" aria-label={`${record.album}, original sample sleeve art`}>
    <svg viewBox="0 0 400 400" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-water`} x1="0" x2="1" y1="0" y2="1"><stop stopColor="#698e82" /><stop offset="1" stopColor="#173f3a" /></linearGradient>
        <radialGradient id={`${id}-sun`}><stop stopColor="#f8ceb0" /><stop offset="1" stopColor="#e97e43" /></radialGradient>
        <linearGradient id={`${id}-blue`} x1="0" x2="0" y1="0" y2="1"><stop stopColor="#6eb8dd" /><stop offset="1" stopColor="#1b34aa" /></linearGradient>
      </defs>
      {index === 0 && <>
        <rect width="400" height="400" fill="#dcdac3" /><circle cx="276" cy="147" r="99" fill="#c58e58" />
        <path d="M-50 120Q80 245 207 169T450 179V420H-50Z" fill="#8e9c80" />
        <path d="M-50 205Q80 90 210 246T450 221V420H-50Z" fill={`url(#${id}-water)`} />
        <path d="M-50 240Q120 352 245 267T450 278V420H-50Z" fill="#1c4b46" />
        {Array.from({ length: 18 }, (_, n) => <path key={n} d={`M-60 ${246 + n * 9}Q95 ${365 + n * 7} 245 ${271 + n * 10}T460 ${289 + n * 8}`} stroke="#a3b6a1" strokeWidth=".8" fill="none" opacity=".36" />)}
        <text x="25" y="57" fill="#283f36" fontSize="46" fontFamily="Georgia">Tides</text><text x="27" y="80" fill="#34473d" fontSize="10" letterSpacing="2">KEI WATANABE</text>
        <text x="27" y="372" fill="#d8e2d2" fontSize="9" letterSpacing="1.5">MUSIC FOR THE IN-BETWEEN</text>
      </>}
      {index === 1 && <><rect width="400" height="400" fill="#dfcadc" /><circle cx="210" cy="189" r="134" fill={`url(#${id}-sun)`} />{Array.from({ length: 14 }, (_, n) => <rect key={n} x="0" y={126 + n * 17} width="400" height={n / 2 + 2} fill="#dfcadc" />)}<text x="25" y="49" fill="#543149" fontFamily="Georgia" fontSize="32">Soft focus</text><text x="26" y="370" fill="#543149" fontSize="13">Mira Sol</text></>}
      {index === 2 && <><rect width="400" height="400" fill="#142855" /><rect x="41" y="33" width="318" height="281" fill={`url(#${id}-blue)`} />{Array.from({ length: 9 }, (_, n) => <rect key={n} x={65 + n * 31} y={90 + Math.sin(n * .7) * 53} width="10" height="195" fill="#d2dff0" opacity={.13 + n * .07} />)}<text x="39" y="357" fill="#e0e8f1" fontSize="36" fontFamily="Georgia">Blue hour</text><text x="41" y="379" fill="#b7cbdf" fontSize="10" letterSpacing="1">THE NORTH QUARTET</text></>}
      {index === 3 && <><rect width="400" height="400" fill="#eae3a7" /><g transform="translate(200 200)">{Array.from({ length: 7 }, (_, n) => <ellipse key={n} cx="0" cy="-70" rx="45" ry="91" fill={n % 2 ? '#a0ad82' : '#728d62'} transform={`rotate(${n * 360 / 7})`} />)}<circle r="45" fill="#eaba66" /></g><text x="21" y="67" fill="#344b37" fontSize="60" fontFamily="Georgia">bloom</text><text x="23" y="375" fill="#344b37" fontSize="12">June &amp; the Pines</text></>}
      {index === 4 && <><rect width="400" height="400" fill="#e56338" />{Array.from({ length: 9 }, (_, n) => <path key={n} d={`M${-160 + n * 67} -10L${70 + n * 67} 410`} stroke={n % 2 ? '#4c3361' : '#f1b475'} strokeWidth="27" />)}<rect x="19" y="22" width="177" height="71" fill="#f2d6b5" /><text x="30" y="54" fill="#49314e" fontSize="29" fontWeight="700">Parallel</text><text x="32" y="77" fill="#49314e" fontSize="12">FORMA</text></>}
      {index === 5 && <><rect width="400" height="400" fill="#d0dad6" /><rect x="45" y="57" width="237" height="277" fill="#a7b9ad" /><rect x="71" y="79" width="188" height="232" fill="#e8e3cb" /><path d="M140 309V180Q165 146 190 180V309Z" fill="#d39269" /><ellipse cx="165" cy="183" rx="25" ry="9" fill="#ac7052" /><path d="M164 181Q131 107 173 92M164 149Q211 112 221 74" stroke="#5b755e" strokeWidth="5" fill="none" /><ellipse cx="148" cy="118" rx="13" ry="29" transform="rotate(-34 148 118)" fill="#5b755e" /><text x="23" y="376" fill="#39514b" fontSize="33" fontFamily="Georgia">Still life</text><text x="278" y="377" fill="#39514b" fontSize="11">ELIO MARCH</text></>}
      {index === 6 && <><rect width="400" height="400" fill="#ecb250" /><circle cx="200" cy="187" r="118" fill="#b74534" /><path d="M0 222Q120 162 240 251T400 236V400H0Z" fill="#704533" /><path d="M0 295Q170 208 400 309V400H0Z" fill="#d88242" /><text x="22" y="61" fill="#692f2a" fontSize="54" fontFamily="Georgia">Low sun</text><text x="25" y="372" fill="#592d22" fontSize="13">Alma Coast</text></>}
      {index === 7 && <><rect width="400" height="400" fill="#c0c9e3" />{Array.from({ length: 9 }, (_, n) => <ellipse key={n} cx={195 + Math.sin(n) * 24} cy={198 + n * 7} rx={173 - n * 16} ry={143 - n * 13} fill={n % 2 ? '#c0c9e3' : '#646da0'} transform={`rotate(-30 200 200)`} />)}<text x="24" y="65" fill="#303d67" fontSize="54" fontFamily="Georgia">Drift</text><text x="25" y="376" fill="#303d67" fontSize="12">Common Ground</text></>}
    </svg>
  </div>;
}

function IconButton({ label, children, onClick, active, className = '' }: { label: string; children: ReactNode; onClick(): void; active?: boolean; className?: string }) {
  return <button className={`icon-btn ${className} ${active ? 'is-active' : ''}`} aria-label={label} title={label} onClick={onClick} aria-pressed={active}>{children}</button>;
}

function DetailDialog({ label, onClose, children }: { label: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = opener.current;
    dialog.showModal();
    return () => { dialog.close(); previousFocus?.focus(); };
  }, []);
  return <dialog ref={ref} className="panel-backdrop" aria-label={label} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button');
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}><section className="detail-panel">{children}</section></dialog>;
}

export default function Mockups() {
  const requested = new URLSearchParams(window.location.search).get('view');
  const [study, setStudy] = useState<Study>(studies.find(item => item.id === requested)?.id ?? 'cove');
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(36);
  const [volume, setVolume] = useState(80);
  const [favorites, setFavorites] = useState<number[]>([1, 3]);
  const [presentation, setPresentation] = useState<Presentation>('albums');
  const [filter, setFilter] = useState('All albums');
  const [query, setQuery] = useState('');
  const [panel, setPanel] = useState<'queue' | 'signal' | null>(null);
  const record = records[selected];
  const liked = favorites.includes(selected);
  const direction = studies.find(item => item.id === study)!;
  const visibleRecords = records.map((item, index) => ({ ...item, index })).filter(item =>
    `${item.album} ${item.artist} ${item.track}`.toLowerCase().includes(query.toLowerCase()) &&
    (filter === 'Favorites' ? favorites.includes(item.index) : filter === 'All albums' || item.genre === filter));
  function choose(index: number) { setSelected(index); setPosition(0); }
  function changeStudy(value: Study) {
    setStudy(value); setPresentation('albums'); setFilter('All albums'); setQuery(''); setPanel(null);
    const url = new URL(window.location.href); url.searchParams.set('view', value); window.history.replaceState(null, '', url);
  }
  function favorite() { setFavorites(items => liked ? items.filter(index => index !== selected) : [...items, selected]); }

  const search = <label className="search"><Search size={17} /><input aria-label="Search sample collection" placeholder="Search your collection" value={query} onChange={event => setQuery(event.target.value)} /><span>/</span></label>;
  const heart = <IconButton label={liked ? 'Remove from favorites' : 'Add to favorites'} onClick={favorite} active={liked}><Heart size={18} fill={liked ? 'currentColor' : 'none'} /></IconButton>;
  const transport = <div className="transport-controls">
    <IconButton label="Previous sample track" onClick={() => choose((selected + records.length - 1) % records.length)}><SkipBack size={20} fill="currentColor" /></IconButton>
    <button className="play-control" aria-label={playing ? 'Preview pause' : 'Preview play'} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={23} fill="currentColor" /> : <Play size={23} fill="currentColor" />}</button>
    <IconButton label="Next sample track" onClick={() => choose((selected + 1) % records.length)}><SkipForward size={20} fill="currentColor" /></IconButton>
  </div>;
  const wave = <div className="progress-block"><div className="squiggle">
    <svg viewBox="0 0 600 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 12H600" className="wave-rail" /><path d={Array.from({ length: 301 }, (_, n) => `${n === 0 ? 'M' : 'L'}${n * 2} ${12 + Math.sin(n * Math.PI / 7) * 4}`).join(' ')} className="wave-played" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }} /><circle cx={position * 6} cy="12" r="4" className="wave-dot" /></svg>
    <input type="range" min="0" max="100" value={position} onChange={event => setPosition(Number(event.target.value))} aria-label="Sample playback position" />
  </div><div className="progress-times"><span>{clock(record.duration * position / 100)}</span><span>{clock(record.duration)}</span></div></div>;
  const volumeControl = <label className="volume"><Volume2 size={17} /><input type="range" min="0" max="100" value={volume} onChange={event => setVolume(Number(event.target.value))} aria-label="Sample volume" /><span>{volume}%</span></label>;

  function queue(indices: number[] = records.map((_, index) => index), compact = false) {
    return <div className={`sample-queue ${compact ? 'compact' : ''}`}>{indices.length ? indices.map((index, n) => <button key={index} className={`queue-row ${selected === index ? 'selected' : ''}`} onClick={() => choose(index)} aria-label={`Select ${records[index].track}`} aria-pressed={selected === index}>
      <span className="queue-number">{selected === index ? <AudioLines size={15} /> : String(n + 1).padStart(2, '0')}</span><Cover index={index} /><span className="queue-title"><strong>{records[index].track}</strong><small>{records[index].artist}</small></span><span className="queue-album">{records[index].album}</span><span className="queue-time">{clock(records[index].duration)}</span>
    </button>) : <p className="empty">No records found. Try another search or filter.</p>}</div>;
  }
  function shelf(indices: number[], className = '') {
    return <div className={`record-grid ${className}`}>{indices.length ? indices.map(index => <button key={index} className={`record-card ${selected === index ? 'selected' : ''}`} onClick={() => choose(index)} aria-label={`Select album ${records[index].album}`} aria-pressed={selected === index}><div className="cover-wrap"><Cover index={index} /><span className="cover-play">{selected === index ? <AudioLines size={19} /> : <Play size={19} fill="currentColor" />}</span></div><strong>{records[index].album}</strong><span>{records[index].artist}</span></button>) : <p className="empty">No records found. Try another search or filter.</p>}</div>;
  }
  const filters = <div className="filter-tabs" aria-label="Filter collection">{['All albums', 'Ambient', 'Electronic', 'Jazz', 'Favorites'].map(item => <button key={item} className={filter === item ? 'selected' : ''} aria-pressed={filter === item} onClick={() => setFilter(item)}>{item}</button>)}</div>;
  const bottomPlayer = <footer className="bottom-player"><div className="mini-track"><Cover index={selected} /><div><strong>{record.track}</strong><span>{record.artist}</span></div>{heart}</div><div className="bottom-center">{transport}{wave}</div><div className="bottom-tools">{volumeControl}<IconButton label="Open sample queue" onClick={() => setPanel('queue')}><ListMusic size={19} /></IconButton><IconButton label="Inspect audio path" onClick={() => setPanel('signal')}><SlidersHorizontal size={18} /></IconButton></div></footer>;
  const playerCard = <><div className="section-heading"><span>On the turntable</span><Disc3 size={18} /></div><Cover index={selected} /><div className="playing-title"><div><h2>{record.track}</h2><p>{record.artist}</p></div>{heart}</div>{wave}{transport}</>;
  const appNav = <nav className="app-nav" aria-label="Collection views">
    <button className={presentation === 'albums' && filter !== 'Favorites' ? 'selected' : ''} onClick={() => { setPresentation('albums'); if (filter === 'Favorites') setFilter('All albums'); }} aria-pressed={presentation === 'albums' && filter !== 'Favorites'}><Library size={18} />Albums</button>
    <button className={presentation === 'tracks' && filter !== 'Favorites' ? 'selected' : ''} onClick={() => { setPresentation('tracks'); if (filter === 'Favorites') setFilter('All albums'); }} aria-pressed={presentation === 'tracks' && filter !== 'Favorites'}><Music2 size={18} />Tracks</button>
    <button className={filter === 'Favorites' ? 'selected' : ''} onClick={() => setFilter(filter === 'Favorites' ? 'All albums' : 'Favorites')} aria-pressed={filter === 'Favorites'}><Heart size={18} />Favorites</button>
  </nav>;
  const signal = <><div className="signal-title"><AudioLines size={18} /><h3>Audio path</h3><span>Not connected</span></div><div className="signal-steps">{['Source', 'Decoder', 'Output'].map(item => <div key={item}><i /><strong>{item}</strong><span>Unknown</span></div>)}</div><p className="signal-note">Live details appear in the desktop player. The OS mixer and DAC output have not been verified.</p></>;

  return <div className="mock-gallery">
    <header className="gallery-bar"><div className="gallery-label"><strong>Squiggly Music</strong><span>Five UI studies, no audio</span></div><nav aria-label="UI directions">{studies.map((item, index) => <button key={item.id} className={study === item.id ? 'selected' : ''} onClick={() => changeStudy(item.id)} aria-pressed={study === item.id}><span>{index + 1}</span>{item.name}</button>)}</nav><div className="gallery-notice"><i />Sample UI<span>No audio playback</span></div></header>
    <main className={`study study-${study}`} aria-label={`${direction.name} mockup`}>
      {study === 'cove' && <>
        <aside className="cove-sidebar"><Brand /><div className="sidebar-group"><span>Your music</span>{appNav}<button className="sidebar-button" onClick={() => setPanel('queue')}><ListMusic size={18} />Play queue<span>8</span></button></div><div className="sidebar-group playlists"><span>Made by you</span><button onClick={() => setFilter('Ambient')}><i className="playlist-color green" />Slow mornings</button><button onClick={() => setFilter('Jazz')}><i className="playlist-color blue" />After dark</button><button onClick={() => setFilter('Electronic')}><i className="playlist-color peach" />A little further</button></div><div className="sidebar-bottom"><div className="collection-source"><Library size={17} /><div>Sample collection<span>8 records, all yours to explore</span></div></div><button className="sidebar-button" onClick={() => setPanel('signal')}><Settings2 size={17} />Audio settings</button></div></aside>
        <div className="cove-main"><header className="content-top"><div className="bread-crumb">Your music <span>/</span> {presentation === 'tracks' ? 'Tracks' : 'Albums'}{filter !== 'All albums' && <> <span>/</span> {filter}</>}</div>{search}</header><section className="cove-feature"><div className="feature-copy"><span className="small-label">Pick up where you left off</span><h1>A little less noise.<br />A little more music.</h1><p>{records[0].artist}'s <em>Tides</em>, ready for another listen.</p><button className="solid-button" onClick={() => { choose(0); setPlaying(true); }}><Play size={16} fill="currentColor" />Listen again</button></div><div className="feature-record"><div className="vinyl"><div><Mark /></div></div><Cover index={0} /></div></section><div className="section-heading"><h2>{filter === 'Favorites' ? 'Your favorites' : 'In your rotation'}</h2><span>{visibleRecords.length} records</span></div>{filters}{presentation === 'tracks' ? queue(visibleRecords.map(item => item.index)) : shelf(visibleRecords.map(item => item.index), 'cove-shelf')}</div>{bottomPlayer}
      </>}

      {study === 'daylight' && <>
        <header className="daylight-header"><Brand />{appNav}<button className="text-button" onClick={() => setPanel('signal')}><Headphones size={17} />Listening settings</button></header><div className="daylight-content"><section className="daylight-library"><div className="daylight-title"><div><span className="small-label">A collection, not a feed.</span><h1>Your record shelf<span>.</span></h1><p>Old favorites. New obsessions. Always yours.</p></div><div className="shelf-symbol"><Disc3 size={49} strokeWidth={1} /></div></div><div className="library-tools">{search}<span>{visibleRecords.length} {presentation} <ChevronDown size={14} /></span></div>{filters}{presentation === 'tracks' ? queue(visibleRecords.map(item => item.index)) : shelf(visibleRecords.map(item => item.index))}<div className="shelf-foot"><span>Sample collection</span><span>Nothing to recommend. Everything to rediscover.</span></div></section><aside className="daylight-player">{playerCard}<div className="player-divider" /><div className="section-heading"><h3>Next on the shelf</h3><ListMusic size={17} /></div>{queue([(selected + 1) % 8, (selected + 2) % 8], true)}{volumeControl}</aside></div>
      </>}

      {study === 'after-hours' && <>
        <header className="after-header"><Brand /><div><span className="live-dot" />The listening room</div><button className="text-button" onClick={() => setPanel('queue')}><ListMusic size={18} />Your queue <span className="count">8</span></button></header><section className="after-stage"><div className="after-art"><Cover index={selected} /><div className="sleeve-caption"><span>{record.album}</span><span>{record.year}</span></div></div><div className="after-listening"><div className="after-meta"><span>{record.genre}</span><span>From your collection</span></div><h1>{record.track}</h1><p className="after-artist">{record.artist}</p><p className="after-album">From <em>{record.album}</em></p><div className="after-progress">{wave}</div><div className="after-controls">{heart}{transport}<IconButton label="Inspect audio path" onClick={() => setPanel('signal')}><SlidersHorizontal size={19} /></IconButton></div><div className="after-output"><Headphones size={17} /><span>Choose an output in the desktop app</span>{volumeControl}</div></div></section><section className="after-next"><div className="section-heading"><h2>Let the evening unfold.</h2><span>Up next in your queue</span></div><div className="after-next-grid">{[(selected + 1) % 8, (selected + 2) % 8, (selected + 3) % 8].map(index => <button key={index} onClick={() => choose(index)}><Cover index={index} /><div><strong>{records[index].track}</strong><span>{records[index].artist}</span></div><span>{clock(records[index].duration)}</span><ArrowRight size={17} /></button>)}</div></section><footer className="after-footer"><span>Just you and the record.</span><button className="text-button" onClick={() => setPanel('signal')}><AudioLines size={14} />View audio path</button></footer>
      </>}

      {study === 'studio' && <>
        <header className="studio-header"><Brand /><span className="studio-tag">Listening desk</span>{search}<button className="text-button" onClick={() => setPanel('signal')}><Settings2 size={17} />Output settings</button></header><div className="studio-layout"><section className="studio-queue"><div className="studio-queue-heading"><div><span className="small-label">The session</span><h1>A good place to stay.</h1></div><span className="queue-total">8 tracks<br /><strong>36 min</strong></span></div><div className="studio-toolbar">{appNav}<span><ListMusic size={16} />Play queue</span></div><div className="queue-columns"><span>#</span><span>Track / artist</span><span>Album</span><span>Time</span></div>{queue(visibleRecords.map(item => item.index))}<div className="queue-summary"><span><Check size={14} />Sample queue</span><span>Native playback in the desktop app</span></div></section><aside className="studio-deck"><div className="deck-heading"><span>Squiggly player</span><AudioLines size={21} /></div><div className="deck-screen"><Cover index={selected} /><div><span>{record.album}</span><h2>{record.track}</h2><p>{record.artist}</p><span className="deck-time">{clock(record.duration * position / 100)}<small> / {clock(record.duration)}</small></span></div></div>{wave}<div className="deck-controls">{heart}{transport}<IconButton label="Open sample queue" onClick={() => setPanel('queue')}><ListMusic size={18} /></IconButton></div><div className="deck-volume"><span>Output volume</span>{volumeControl}</div><section className="studio-signal">{signal}</section><div className="studio-note"><Disc3 size={20} /><p>Your files. Your server.<br /><span>One place to listen.</span></p></div></aside></div><footer className="studio-footer"><span><i />Design preview</span><span>No device connected</span><span>Squiggly Music</span></footer>
      </>}

      {study === 'blue-note' && <>
        <header className="blue-header"><Brand /><nav aria-label="Blue note collection"><button className={filter !== 'Favorites' ? 'selected' : ''} onClick={() => setFilter('All albums')}>Collection</button><button className={filter === 'Favorites' ? 'selected' : ''} onClick={() => setFilter('Favorites')}>Favorites</button><button onClick={() => setPanel('queue')}>Queue <span>8</span></button></nav><IconButton label="Inspect audio path" onClick={() => setPanel('signal')}><SlidersHorizontal size={19} /></IconButton></header><section className="blue-feature"><div className="blue-intro"><span className="small-label">Good records deserve another spin.</span><h1>Find your<br />next repeat.</h1><button className="blue-listen" onClick={() => { choose(2); setPlaying(true); }}><span><Play size={19} fill="currentColor" /></span>Start with Blue hour</button></div><div className="blue-art-stack"><Cover index={1} className="stack-back" /><Cover index={2} className="stack-front" /><span className="handwritten">a late-night favorite</span><svg className="hand-arrow" viewBox="0 0 100 65" fill="none" aria-hidden="true"><path d="M3 5Q93 5 69 53M54 40L69 54 88 42" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></div></section><section className="blue-collection"><div className="section-heading"><h2>{filter === 'Favorites' ? 'Your favorites' : 'The collection'}<span>{String(visibleRecords.length).padStart(2, '0')}</span></h2><div><button className="text-button" onClick={() => setFilter(filter === 'Favorites' ? 'All albums' : 'Favorites')}><Heart size={15} />{filter === 'Favorites' ? 'Show all' : 'Favorites'}</button><Grid2X2 size={17} /></div></div><div className="blue-record-list">{visibleRecords.map(item => <button key={item.index} className={selected === item.index ? 'selected' : ''} onClick={() => choose(item.index)} aria-label={`Select album ${item.album}`} aria-pressed={selected === item.index}><Cover index={item.index} /><span><strong>{item.album}</strong><small>{item.artist}</small></span><ArrowDown size={18} className={selected === item.index ? 'chosen-arrow' : ''} /></button>)}{!visibleRecords.length && <p className="empty">No favorites yet. Use the heart in the player to save a record.</p>}</div></section>{bottomPlayer}
      </>}

      {panel && <DetailDialog label={panel === 'queue' ? 'Sample queue' : 'Audio path information'} onClose={() => setPanel(null)}><div className="section-heading"><h2>{panel === 'queue' ? 'Your sample queue' : 'Inspect the signal'}</h2><button autoFocus className="icon-btn" aria-label="Close panel" onClick={() => setPanel(null)}><X size={20} /></button></div>{panel === 'queue' ? queue() : signal}<p className="panel-note">This is a design study with sample content. No audio plays.</p></DetailDialog>}
    </main>
    <footer className="gallery-footer"><span><strong>{direction.name}</strong>{direction.description}</span><a href="/">Open existing player <ArrowLeft size={13} /></a></footer>
  </div>;
}
