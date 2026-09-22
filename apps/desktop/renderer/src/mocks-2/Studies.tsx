import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, AudioLines, FileDown, Heart, ListMusic, Maximize2, Pause, Play, Search, SkipBack, SkipForward, SlidersHorizontal, Volume2, X } from 'lucide-react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

const studies = [
  { id: 'verse', name: 'Verse', description: 'Read along. Every word, on time.' },
  { id: 'bench', name: 'Bench', description: 'What the audio is doing, and what we cannot see.' },
  { id: 'sleeve-notes', name: 'Sleeve notes', description: 'The record colors the room.' },
  { id: 'transistor', name: 'Transistor', description: 'Small windows for when you are working.' },
  { id: 'ledger', name: 'Ledger', description: 'A hundred thousand songs, by keyboard.' },
] as const;
type Study = typeof studies[number]['id'];
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

const tints = [
  { bg: '#1e3f3a', panel: '#24504a', fg: '#e7ece3', muted: '#a6bcb1', accent: '#dcdac3' },
  { bg: '#4a2b44', panel: '#5a3853', fg: '#f6e9f0', muted: '#c9adc0', accent: '#f2b48f' },
  { bg: '#13224a', panel: '#1b2c5c', fg: '#e6ebf6', muted: '#a9b6d4', accent: '#9fc6e6' },
  { bg: '#36452a', panel: '#445637', fg: '#eef0e2', muted: '#b6c0a5', accent: '#eaba66' },
  { bg: '#5a2a1c', panel: '#6d3626', fg: '#fbeee6', muted: '#d5b0a2', accent: '#f2d6b5' },
  { bg: '#2f3e3a', panel: '#3b4c47', fg: '#ecefea', muted: '#b1bfb8', accent: '#d39269' },
  { bg: '#5b2a1e', panel: '#6f3626', fg: '#fdf1e6', muted: '#d9b6a5', accent: '#ecb250' },
  { bg: '#2d3358', panel: '#3a416b', fg: '#e9ebf5', muted: '#b4b9d6', accent: '#c0c9e3' },
];

const extraTitles = [
  ['Weather in the glass', 'A quieter shore', 'Rooms of salt'],
  ['Small hours', 'Almost weightless', 'The shape of Sunday'],
  ['Streetlight refrain', 'Northbound at two', 'Last table open'],
  ['Needle and leaf', 'The long garden', 'Warm soil'],
  ['Second geometry', 'Lines in motion', 'Same train home'],
  ['Dust on the keys', 'Vase by the door', 'Late afternoon'],
  ['Orange roofs', 'Coast road', 'Heat leaving stone'],
  ['Loose horizon', 'Map without names', 'Carried out'],
];

const linerNotes = [
  'The room opens slowly, then the horizon moves in. Low voices and long tones leave enough space for the tide to turn.',
  'A soft pulse holds these songs together while the edges blur. It is music for a Sunday that refuses to hurry.',
  'Four players trade small phrases beneath a darkening sky. The record keeps the air after the rain and the street beyond it.',
  'Guitars rise through close harmonies like plants toward a window. The songs stay earthy even when they lift.',
  'Patterns cross, separate, and meet again without landing in the same place twice. A bright record built for moving through a city.',
  'Piano, room tone, and the scrape of a chair share the same quiet frame. Each piece lets ordinary light do most of the work.',
  'The coast holds its heat after sunset, and these songs carry that glow. Brass and close drums keep the road in sight.',
  'Melodies circle a fixed point while the arrangement drifts around them. It feels distant at first, then unexpectedly close.',
];

const genres = [
  ['All genres', '1,514'], ['Ambient', '238'], ['Classical', '184'], ['Electronic', '279'], ['Folk', '103'], ['Indie', '217'], ['Jazz', '146'], ['Piano', '121'], ['Soul', '94'],
] as const;

const artists = [
  ['Alma Coast', 28], ['Anika Vale', 41], ['Common Ground', 35], ['Elio March', 19], ['Forma', 52], ['June & the Pines', 31], ['Kei Watanabe', 44], ['Lena Fallow', 22], ['Mira Sol', 38], ['Noah Venn', 47], ['Orchard Glass', 17], ['Rafi Grey', 26], ['The North Quartet', 33], ['Vela House', 29],
] as const;

const lyricWords = [
  ['Morning', 'finds', 'the', 'window', 'open'],
  ['Rain', 'has', 'left', 'a', 'silver', 'line'],
  ['We', 'name', 'the', 'boats', 'that', 'pass', 'us'],
  ['Then', 'let', 'their', 'small', 'lights', 'go'],
  ['Every', 'room', 'keeps', 'one', 'quiet', 'weather'],
  ['Every', 'road', 'remembers', 'where', 'it', 'bent'],
  ['Hold', 'the', 'cup', 'until', 'the', 'day', 'warms'],
  ['Leave', 'the', 'blue', 'coat', 'by', 'the', 'door'],
  ['Nothing', 'asks', 'the', 'tide', 'to', 'answer'],
  ['Evening', 'closes', 'what', 'morning', 'began'],
];
const lyricFractions = [.04, .13, .23, .34, .45, .56, .67, .76, .85, .93];

type TrackRow = { id: string; recordIndex: number; album: string; artist: string; title: string; year: string; genre: string; duration: number; albumRow: number };
const allTrackRows: TrackRow[] = records.flatMap((record, recordIndex) => [record.track, ...extraTitles[recordIndex]].map((title, albumRow) => ({
  id: `track-${recordIndex}-${albumRow}`,
  recordIndex,
  album: record.album,
  artist: record.artist,
  title,
  year: record.year,
  genre: record.genre,
  duration: albumRow === 0 ? record.duration : Math.max(138, record.duration - albumRow * 19 + (recordIndex % 3) * 7),
  albumRow,
})));

export default function Studies() {
  const requested = new URLSearchParams(window.location.search).get('view');
  const [study, setStudy] = useState<Study>(studies.find(item => item.id === requested)?.id ?? 'verse');
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(36);
  const [volume, setVolume] = useState(80);
  const [favorites, setFavorites] = useState<number[]>([1, 3]);
  const [query, setQuery] = useState('');
  const [panel, setPanel] = useState<'queue' | 'signal' | null>(null);
  const [trackRow, setTrackRow] = useState(0);
  const [keepOnTop, setKeepOnTop] = useState(false);
  const [selectedGenre, setSelectedGenre] = useState('All genres');
  const [selectedArtist, setSelectedArtist] = useState<string | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null);
  const [focusRow, setFocusRow] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const record = records[selected];
  const currentTrack = allTrackRows.find(row => row.recordIndex === selected && row.albumRow === trackRow)!;
  const liked = favorites.includes(selected);
  const direction = studies.find(item => item.id === study)!;

  function choose(index: number) { setSelected(index); setTrackRow(0); setPosition(0); }
  function changeStudy(value: Study) {
    setStudy(value); setQuery(''); setPanel(null);
    const url = new URL(window.location.href); url.searchParams.set('view', value); window.history.replaceState(null, '', url);
  }
  function favorite() { setFavorites(items => liked ? items.filter(index => index !== selected) : [...items, selected]); }
  function playRow(row: TrackRow) { setSelected(row.recordIndex); setTrackRow(row.albumRow); setPosition(0); setPlaying(true); }
  function stepTrack(delta: number) {
    if (study !== 'ledger' && study !== 'sleeve-notes') {
      choose((selected + delta + records.length) % records.length);
      return;
    }
    const index = allTrackRows.indexOf(currentTrack);
    const next = allTrackRows[(index + delta + allTrackRows.length) % allTrackRows.length];
    setSelected(next.recordIndex); setTrackRow(next.albumRow); setPosition(0);
  }

  const search = <label className="search"><Search size={17} /><input aria-label="Search sample collection" placeholder="Search your collection" value={query} onChange={event => setQuery(event.target.value)} /><span>/</span></label>;
  const heart = <IconButton label={liked ? 'Remove from favorites' : 'Add to favorites'} onClick={favorite} active={liked}><Heart size={18} fill={liked ? 'currentColor' : 'none'} /></IconButton>;
  const transport = <div className="transport-controls">
    <IconButton label="Previous sample track" onClick={() => stepTrack(-1)}><SkipBack size={20} fill="currentColor" /></IconButton>
    <button className="play-control" aria-label={playing ? 'Preview pause' : 'Preview play'} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={23} fill="currentColor" /> : <Play size={23} fill="currentColor" />}</button>
    <IconButton label="Next sample track" onClick={() => stepTrack(1)}><SkipForward size={20} fill="currentColor" /></IconButton>
  </div>;
  const wave = <div className="progress-block"><div className="squiggle">
    <svg viewBox="0 0 600 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 12H600" className="wave-rail" /><path d={Array.from({ length: 301 }, (_, n) => `${n === 0 ? 'M' : 'L'}${n * 2} ${12 + Math.sin(n * Math.PI / 7) * 4}`).join(' ')} className="wave-played" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }} /><circle cx={position * 6} cy="12" r="4" className="wave-dot" /></svg>
    <input type="range" min="0" max="100" value={position} onChange={event => setPosition(Number(event.target.value))} aria-label="Sample playback position" />
  </div><div className="progress-times"><span>{clock(currentTrack.duration * position / 100)}</span><span>{clock(currentTrack.duration)}</span></div></div>;
  const volumeControl = <label className="volume"><Volume2 size={17} /><input type="range" min="0" max="100" value={volume} onChange={event => setVolume(Number(event.target.value))} aria-label="Sample volume" /><span>{volume}%</span></label>;

  function queue(indices: number[] = records.map((_, index) => index), compact = false) {
    return <div className={`sample-queue ${compact ? 'compact' : ''}`}>{indices.length ? indices.map((index, n) => <button key={index} className={`queue-row ${selected === index && trackRow === 0 ? 'selected' : ''}`} onClick={() => choose(index)} aria-label={`Select ${records[index].track}`} aria-pressed={selected === index && trackRow === 0}>
      <span className="queue-number">{selected === index && trackRow === 0 ? <AudioLines size={15} /> : String(n + 1).padStart(2, '0')}</span><Cover index={index} /><span className="queue-title"><strong>{records[index].track}</strong><small>{records[index].artist}</small></span><span className="queue-album">{records[index].album}</span><span className="queue-time">{clock(records[index].duration)}</span>
    </button>) : <p className="empty">No records found. Try another search or filter.</p>}</div>;
  }
  const bottomPlayer = <footer className="bottom-player"><div className="mini-track"><Cover index={selected} /><div><strong>{currentTrack.title}</strong><span>{record.artist}</span></div>{heart}</div><div className="bottom-center">{transport}{wave}</div><div className="bottom-tools">{volumeControl}<IconButton label="Open sample queue" onClick={() => setPanel('queue')}><ListMusic size={19} /></IconButton><IconButton label="Inspect audio path" onClick={() => setPanel('signal')}><SlidersHorizontal size={18} /></IconButton></div></footer>;
  const signal = <><div className="signal-title"><AudioLines size={18} /><h3>Audio path</h3><span>Not connected</span></div><div className="signal-steps">{['Source', 'Decoder', 'Output'].map(item => <div key={item}><i /><strong>{item}</strong><span>Unknown</span></div>)}</div><p className="signal-note">Live details appear in the desktop player. The OS mixer and DAC output have not been verified.</p></>;

  const lyrics = lyricWords.map((words, index) => ({ at: Math.floor(currentTrack.duration * lyricFractions[index]), words }));
  const currentSeconds = currentTrack.duration * position / 100;
  const currentLyric = lyrics.reduce((last, line, index) => line.at <= currentSeconds ? index : last, 0);
  const currentLine = lyrics[currentLyric];
  const nextLineAt = lyrics[currentLyric + 1]?.at ?? currentTrack.duration;
  const wordProgress = Math.max(0, Math.min(.999, (currentSeconds - currentLine.at) / Math.max(1, nextLineAt - currentLine.at)));
  const currentWord = Math.floor(wordProgress * currentLine.words.length);

  const ledgerRows = allTrackRows.filter(row => {
    const genreMatch = selectedGenre === 'All genres' || row.genre === selectedGenre;
    const artistMatch = selectedArtist === null || row.artist === selectedArtist;
    const albumMatch = selectedAlbum === null || row.album === selectedAlbum;
    const text = `${row.title} ${row.artist} ${row.album} ${row.year}`.toLowerCase();
    return genreMatch && artistMatch && albumMatch && text.includes(query.toLowerCase());
  });
  const ledgerAlbums = records.map((item, index) => ({ ...item, index })).filter(item =>
    (selectedGenre === 'All genres' || item.genre === selectedGenre) && (selectedArtist === null || item.artist === selectedArtist));

  function handleLedgerKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === '/') { event.preventDefault(); searchRef.current?.focus(); return; }
    if (!ledgerRows.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = Math.max(0, Math.min(ledgerRows.length - 1, focusRow + step));
      setFocusRow(next);
      document.getElementById(`ledger-${ledgerRows[next].id}`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
    if (event.key === 'Enter') { event.preventDefault(); playRow(ledgerRows[Math.min(focusRow, ledgerRows.length - 1)]); }
  }

  const sleeveRows = allTrackRows.filter(row => row.recordIndex === selected);
  const sleeveMinutes = Math.round(sleeveRows.reduce((total, row) => total + row.duration, 0) / 60);
  const tint = tints[selected];
  const sleeveStyle = { '--bg': tint.bg, '--panel': tint.panel, '--fg': tint.fg, '--muted': tint.muted, '--accent': tint.accent, '--line': `${tint.fg}24` } as CSSProperties;

  return <div className="mock-gallery">
    <header className="gallery-bar"><div className="gallery-label"><strong>Squiggly Music</strong><span>UI studies 6–10, no audio</span></div><nav aria-label="UI directions">{studies.map((item, index) => <button key={item.id} className={study === item.id ? 'selected' : ''} onClick={() => changeStudy(item.id)} aria-pressed={study === item.id}><span>{index + 6}</span>{item.name}</button>)}</nav><div className="gallery-notice"><i /><a href="/mocks.html">Studies 1–5</a><span>Sample UI only</span></div></header>
    <main className={`study study-${study}`} style={study === 'sleeve-notes' ? sleeveStyle : undefined} aria-label={`${direction.name} mockup`}>
      {study === 'verse' && <>
        <header className="verse-header"><Brand /><nav aria-label="Verse sections"><button className="selected" aria-pressed="true">Lyrics</button><button onClick={() => setPanel('queue')}>Queue</button><button>Collection</button></nav>{search}</header>
        <div className="verse-body"><aside className="verse-aside"><Cover index={selected} /><h1>{currentTrack.title}</h1><p>{record.artist}</p><p>{record.album}</p><div className="verse-divider" /><p>Lyrics from your server</p><p>Word timing: sample</p><div className="verse-aside-actions">{heart}<button className="text-button" onClick={() => setPanel('signal')}><SlidersHorizontal size={17} />Inspect audio path</button></div></aside>
          <section className="lyric-sheet" aria-label="Sample lyrics">{lyrics.map((line, lineIndex) => <button key={line.at} className={lineIndex < currentLyric ? 'past' : lineIndex === currentLyric ? 'current' : 'upcoming'} onClick={event => { setPosition(line.at / currentTrack.duration * 100); event.currentTarget.scrollIntoView({ block: 'center', behavior: 'auto' }); }} aria-pressed={lineIndex === currentLyric}><time>{clock(line.at)}</time><span>{line.words.map((word, wordIndex) => lineIndex === currentLyric && wordIndex === currentWord ? <mark key={`${word}-${wordIndex}`}>{word}</mark> : <span key={`${word}-${wordIndex}`}>{word}</span>)}</span></button>)}{selected !== 0 && <p className="lyric-note">Sample lyrics for layout only.</p>}</section>
        </div><footer className="verse-player"><div className="verse-wave">{wave}</div><div className="verse-player-controls">{transport}{volumeControl}</div></footer>
      </>}

      {study === 'bench' && <>
        <header className="bench-header"><Brand /><nav aria-label="Bench sections"><button className="selected" aria-pressed="true">Bench</button><button>Collection</button><button onClick={() => setPanel('queue')}>Queue</button></nav><button className="bench-export" title="Saves a credential-free report in the desktop app"><FileDown size={16} />Export report</button></header>
        <div className="bench-layout"><aside className="bench-player"><Cover index={selected} /><h2>{currentTrack.title}</h2><p>{record.artist}</p>{wave}{transport}{volumeControl}</aside><section className="bench-main"><h1>Signal path</h1><p>Each stage shows only what the player can read.</p><div className="bench-chain">{[
          ['Source', 'Not connected', 'Container, codec and tags from the file'], ['Decoder', 'Not connected', 'The sample format MPV decodes to'], ['Output', 'Not connected', 'What MPV hands to the audio driver'], ['OS mixer', 'Not verified', 'Resampling or mixing by the system'], ['DAC', 'Not verified', "The physical converter's real resolution"],
        ].map(([name, value, note], index) => <div className="bench-node" key={name}><i /><strong>{name}</strong><span>{value}</span><small>{note}</small>{index === 2 && <div className="bench-boundary"><b>Beyond this line Squiggly cannot verify anything.</b></div>}</div>)}</div><div className="bench-panels"><section><h2>Player</h2>{['Engine', 'Position updates', 'Pending commands'].map(item => <div key={item}><span>{item}</span><strong>Appears when connected</strong></div>)}</section><section><h2>Processes</h2>{['Main', 'Player host', 'Renderer'].map(item => <div key={item}><span>{item}</span><strong>Appears when connected</strong></div>)}</section></div><p className="bench-footer-note">Unknown stays unknown. Volume below 100% is attenuation, not a bit-perfect signal.</p></section></div>
      </>}

      {study === 'sleeve-notes' && <>
        <header className="sleeve-header"><button className="text-button"><ArrowLeft size={17} />Collection</button><Brand /><button className="text-button" onClick={() => setPanel('queue')}>Queue 8</button></header>
        <section className="sleeve-hero"><Cover index={selected} /><div className="sleeve-copy"><h1>{record.album}</h1><p className="sleeve-artist">{record.artist}</p><div className="sleeve-meta"><span>{record.year}</span><span>{record.genre}</span><span>{sleeveRows.length} tracks, {sleeveMinutes} min</span></div><div className="sleeve-actions"><button className="sleeve-play" onClick={() => { setTrackRow(0); setPosition(0); setPlaying(true); }}><Play size={17} fill="currentColor" />Play album</button><button className="sleeve-add" onClick={() => setPanel('queue')}>Add to queue</button>{heart}</div><p className="liner-note">{linerNotes[selected]}</p></div></section>
        <section className="sleeve-lower"><div className="sleeve-tracklist"><div className="sleeve-track-heading"><span>#</span><span>Track</span><span>Length</span></div>{sleeveRows.map(row => <div key={row.id} className={`sleeve-track-row ${row.id === currentTrack.id ? 'current' : ''}`}>
          <button className="sleeve-track-select" onClick={() => playRow(row)} aria-pressed={row.id === currentTrack.id}>
            <span>{row.id === currentTrack.id ? <AudioLines size={16} /> : row.albumRow + 1}</span><strong>{row.title}</strong><time>{clock(row.duration)}</time>
          </button>
          {row.id === currentTrack.id && <div className="inline-wave">{wave}</div>}
        </div>)}</div><aside className="sleeve-shelf"><h2>More from the shelf</h2>{[1, 2, 3, 4, 5, 6, 7, 0].filter(index => index !== selected).slice(0, 4).map(index => <button key={index} onClick={() => { choose(index); setTrackRow(0); }} aria-label={`Open ${records[index].album}`}><Cover index={index} /><span>{records[index].album}</span></button>)}</aside></section>{bottomPlayer}
      </>}

      {study === 'transistor' && <div className="transistor-desk"><div className="transistor-layout"><figure className="transistor-figure"><div className="mini-window"><div className="mini-top"><Brand /><button className={`top-switch ${keepOnTop ? 'on' : ''}`} role="switch" aria-checked={keepOnTop} onClick={() => setKeepOnTop(value => !value)}><span />Keep on top</button></div><Cover index={selected} /><h1>{currentTrack.title}</h1><p>{record.artist}</p>{wave}<div className="mini-transport">{transport}</div><div className="next-up"><h2>Next up</h2>{[1, 2, 3].map(offset => { const index = (selected + offset) % records.length; return <button key={index} onClick={() => choose(index)}><span>{records[index].track}</span><small>{records[index].artist}</small></button>; })}</div><div className="mini-bottom"><IconButton label="Open queue" onClick={() => setPanel('queue')}><ListMusic size={18} /></IconButton><span className="mini-volume">{volumeControl}</span><button className="text-button"><Maximize2 size={15} />Full window</button></div></div><figcaption>Mini player, 380 wide</figcaption></figure><figure className="transistor-figure strip-figure"><div className="strip-window"><Cover index={selected} /><div><strong>{currentTrack.title}</strong><span>{record.artist}</span></div><IconButton label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</IconButton><IconButton label="Next sample track" onClick={() => stepTrack(1)}><SkipForward size={15} fill="currentColor" /></IconButton><span className="strip-wave">{wave}</span></div><figcaption>Strip, 440 by 64</figcaption><div className="strip-window light"><Cover index={selected} /><div><strong>{currentTrack.title}</strong><span>{record.artist}</span></div><IconButton label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(value => !value)}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</IconButton><IconButton label="Next sample track" onClick={() => stepTrack(1)}><SkipForward size={15} fill="currentColor" /></IconButton><span className="strip-wave">{wave}</span></div><figcaption>Strip, light</figcaption></figure></div><p className="transistor-note">Both windows are real sizes, not a scaled desktop.</p></div>}

      {study === 'ledger' && <>
        <header className="ledger-header"><Brand /><label className="ledger-search"><Search size={15} /><input ref={searchRef} aria-label="Filter sample songs" placeholder="Filter 1,514 songs" value={query} onChange={event => { setQuery(event.target.value); setFocusRow(0); }} /><kbd>/</kbd></label><nav aria-label="Ledger sections"><button className="selected" aria-pressed="true">Library</button><button onClick={() => setPanel('queue')}>Queue</button><button onClick={() => setPanel('signal')}>Bench</button></nav></header>
        <div className="ledger-browser"><section><h2>Genres</h2><div>{genres.map(([name, count]) => <button key={name} className={selectedGenre === name ? 'selected' : ''} onClick={() => { setSelectedGenre(name); setSelectedArtist(null); setSelectedAlbum(null); setFocusRow(0); }} aria-pressed={selectedGenre === name}><span>{name}</span><small>{count}</small></button>)}</div></section><section><h2>Artists</h2><div>{artists.map(([name, count]) => <button key={name} className={selectedArtist === name ? 'selected' : ''} onClick={() => { setSelectedArtist(selectedArtist === name ? null : name); setSelectedAlbum(null); setFocusRow(0); }} aria-pressed={selectedArtist === name}><span>{name}</span><small>{count}</small></button>)}</div></section><section><h2>Albums</h2><div>{ledgerAlbums.map(item => <button key={item.album} className={selectedAlbum === item.album ? 'selected' : ''} onClick={() => { setSelectedAlbum(selectedAlbum === item.album ? null : item.album); setFocusRow(0); }} aria-pressed={selectedAlbum === item.album}><span>{item.album}</span><small>{item.year}</small></button>)}</div></section></div>
        <div className="ledger-table" role="grid" tabIndex={0} aria-activedescendant={ledgerRows[focusRow] ? `ledger-${ledgerRows[focusRow].id}` : undefined} onKeyDown={handleLedgerKey}><div className="ledger-track-head" role="row"><span>#</span><span>Title</span><span>Artist</span><span>Album</span><span>Year</span><span>Time</span></div><div className="ledger-track-scroll">{ledgerRows.length ? ledgerRows.map((row, index) => <button id={`ledger-${row.id}`} role="row" key={row.id} className={`ledger-track-row ${index === focusRow ? 'focused' : ''} ${row.id === currentTrack.id ? 'current' : ''}`} onClick={() => { setFocusRow(index); playRow(row); }} aria-selected={row.id === currentTrack.id}><span>{row.id === currentTrack.id ? <AudioLines size={14} /> : index + 1}</span><strong>{row.title}</strong><span>{row.artist}</span><span>{row.album}</span><span>{row.year}</span><time>{clock(row.duration)}</time></button>) : <p className="empty">No songs match these filters.</p>}</div></div>
        <div className="ledger-status"><span>{ledgerRows.length} songs shown</span><span><kbd>↑ ↓</kbd> move <kbd>Enter</kbd> play <kbd>/</kbd> filter</span></div><footer className="ledger-player"><div className="mini-track"><Cover index={selected} /><div><strong>{currentTrack.title}</strong><span>{record.artist}</span></div></div>{transport}<div className="ledger-wave">{wave}</div>{volumeControl}</footer>
      </>}

      {panel && <DetailDialog label={panel === 'queue' ? 'Sample queue' : 'Audio path information'} onClose={() => setPanel(null)}><div className="section-heading"><h2>{panel === 'queue' ? 'Your sample queue' : 'Inspect the signal'}</h2><button autoFocus className="icon-btn" aria-label="Close panel" onClick={() => setPanel(null)}><X size={20} /></button></div>{panel === 'queue' ? queue() : signal}<p className="panel-note">This is a design study with sample content. No audio plays.</p></DetailDialog>}
    </main>
    <footer className="gallery-footer"><span><strong>{direction.name}</strong>{direction.description}</span><span className="gallery-links"><a href="/mocks.html">Studies 1–5</a><a href="/">Open existing player</a></span></footer>
  </div>;
}
