import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, AudioLines, Check, ChevronLeft, ChevronRight, CircleHelp, Disc3, FolderPlus, Headphones, Library, ListMusic, LoaderCircle, Pause, Play, Plug, RotateCcw, Settings2, SkipBack, SkipForward, Square, Volume2, X } from 'lucide-react';
import type { Album, AppSnapshot, AudioPath, PlayerCommand, Result, Track } from '../../../../packages/core/contracts';
import { desktop, useSnapshot } from './store';
import { SeekBar, time } from './SeekBar';
import { VolumeCommandCoalescer } from './volumeCommands';

const hz = (value: number | null) => value === null ? 'Unknown' : `${Number((value / 1000).toFixed(2))} kHz`;
const number = (value: number, digits = 1) => value.toLocaleString(undefined, { maximumFractionDigits: digits });
type Tab = 'listen' | 'library' | 'diagnostics';

function Mark() {
  return <svg width="33" height="30" viewBox="0 0 33 30" fill="none" aria-hidden="true"><path d="M3 17C6 17 4 7 8 7S9 24 13 24 14 5 18 5 19 22 23 22 24 12 30 12" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" /></svg>;
}

function RecordSleeve({ track }: { track?: Track }) {
  return <div className={`record-sleeve ${track ? 'has-track' : ''}`} aria-hidden="true">
    <div className="sleeve-top"><span>Squiggly sessions</span><AudioLines size={17} /></div>
    <svg className="record-art" viewBox="0 0 400 400">
      <defs><radialGradient id="record"><stop offset="0" stopColor="#353f4b" /><stop offset=".65" stopColor="#252e39" /><stop offset="1" stopColor="#151d28" /></radialGradient></defs>
      <circle cx="200" cy="200" r="170" fill="url(#record)" />
      {Array.from({ length: 20 }, (_, i) => <circle key={i} cx="200" cy="200" r={74 + i * 4.6} fill="none" stroke="#8999ab" strokeOpacity={i % 3 === 0 ? '.2' : '.07'} />)}
      <circle cx="200" cy="200" r="57" fill="#a8bacd" /><circle cx="200" cy="200" r="51" fill="none" stroke="#64778b" />
      <path d="M174 204C182 204 174 185 183 185S186 217 194 217 194 183 203 183 206 214 214 214 213 199 226 199" fill="none" stroke="#263849" strokeWidth="3" strokeLinecap="round" />
      <circle cx="200" cy="200" r="4" fill="#192330" />
    </svg>
    <div className="sleeve-bottom"><span>{track ? track.album || 'Local collection' : 'Room for your next record.'}</span><span>Native playback</span></div>
  </div>;
}

const Queue = memo(function Queue({ tracks, index, onSelect }: { tracks: Track[]; index: number; onSelect(id: string): void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0); const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = scroll.current!;
    const measure = () => setHeight(element.clientHeight);
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  const maxTop = Math.max(0, tracks.length * 68 - height);
  useEffect(() => {
    const element = scroll.current!;
    element.scrollTop = Math.min(element.scrollTop, maxTop); setTop(element.scrollTop);
  }, [maxTop]);
  // Include a partial row and three overscan rows on either side.
  const first = Math.floor(Math.min(top, maxTop) / 68);
  const start = Math.max(0, first - 3);
  const end = first + Math.ceil(height / 68) + 1 + 3;
  const visible = tracks.slice(start, end);
  return <div ref={scroll} className="queue-scroll" onScroll={event => setTop(event.currentTarget.scrollTop)}>
    {!tracks.length ? <div className="empty-queue"><ListMusic size={27} strokeWidth={1.3} /><p>Your queue is quiet.</p><span>Open audio files or play an album from your server.</span></div>
      : <div style={{ height: tracks.length * 68, position: 'relative' }} role="list" aria-label="Play queue">
        {visible.map((track, offset) => <button key={track.id} className={`queue-track ${start + offset === index ? 'current' : ''}`}
          style={{ top: (start + offset) * 68 }} onClick={() => onSelect(track.id)} aria-current={start + offset === index ? 'true' : undefined}>
          <span className="track-number">{start + offset === index ? <AudioLines size={16} /> : String(start + offset + 1).padStart(2, '0')}</span>
          <span className="track-text"><strong>{track.title}</strong><small>{track.artist}</small></span><span className="track-duration">{time(track.duration)}</span>
        </button>)}
      </div>}
  </div>;
});

function VolumeControl({ volume, disabled, commands }: { volume: number; disabled: boolean; commands: VolumeCommandCoalescer | null }) {
  const [, redraw] = useState(0);
  useEffect(() => commands?.subscribe(() => redraw(value => value + 1)), [commands]);
  useEffect(() => { commands?.confirm(volume); }, [commands, volume]);
  useEffect(() => { if (disabled) commands?.cancel(); }, [commands, disabled]);
  const value = Math.round(commands?.value ?? volume);
  return <div className="volume-control"><Volume2 size={17} /><input aria-label="Player volume" type="range" min="0" max="100" value={value} disabled={disabled}
    onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
    onChange={event => commands?.enqueue(Number(event.target.value))}
    onPointerUp={() => commands?.finish()} onPointerCancel={() => commands?.finish()} onLostPointerCapture={() => commands?.finish()}
    onKeyUp={() => commands?.finish()} onBlur={() => commands?.finish()} /><span>{value}%</span></div>;
}

function PathStage({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <section className="path-stage"><span className="path-node" /><div><h3>{title}</h3><p>{subtitle}</p><dl>{children}</dl></div></section>;
}
function Detail({ label, value }: { label: string; value: React.ReactNode }) { return <><dt>{label}</dt><dd>{value}</dd></>; }

function AudioInspector({ audio, track, volume }: { audio: AudioPath; track?: Track; volume: number }) {
  return <aside className="inspector">
    <div className="section-title"><h2>Audio path</h2><span className="status-label">Unverified</span></div>
    <p className="section-description">What goes in. What comes out.</p>
    <div className="path-stages">
      <PathStage title="Source" subtitle={track ? track.source === 'local' ? 'Local file' : 'OpenSubsonic stream' : 'No track loaded'}>
        <Detail label="Format" value={track?.sourceFormat?.toUpperCase() ?? 'Unknown'} />
        <Detail label="Sample rate" value={hz(track?.sourceSampleRate ?? null)} />
        <Detail label="Bit depth" value={track?.sourceBitDepth ? `${track.sourceBitDepth} bit` : 'Unknown'} />
        {track?.source === 'navidrome' && <Detail label="Transcoding" value="Original requested; unverified" />}
      </PathStage>
      <PathStage title="Decoder" subtitle="Reported by libmpv">
        <Detail label="Codec" value={audio.codec ?? 'Unknown'} /><Detail label="Sample rate" value={hz(audio.decoderRate)} />
        <Detail label="Sample format" value={audio.decoderFormat ?? 'Unknown'} /><Detail label="Channels" value={audio.decoderChannels ?? 'Unknown'} />
      </PathStage>
      <PathStage title="Processing" subtitle="No automatic normalization or EQ">
        <Detail label="ReplayGain" value={audio.replayGain === 'no' ? 'Off' : audio.replayGain ?? 'Unknown'} />
        <Detail label="Filters" value={audio.filters === '' ? 'None reported' : audio.filters ?? 'Unknown'} />
        <Detail label="Player volume" value={`${Math.round(volume)}%${volume < 100 ? ' • attenuation' : ''}`} />
        <Detail label="Resampling" value={audio.decoderRate && audio.outputRate ? audio.decoderRate !== audio.outputRate ? 'Rate conversion reported' : 'No rate change reported' : 'Unknown'} />
      </PathStage>
      <PathStage title="Output" subtitle="Player output, not a DAC measurement">
        <Detail label="Backend" value={audio.outputBackend ?? 'Unknown'} /><Detail label="Sample rate" value={hz(audio.outputRate)} />
        <Detail label="Sample format" value={audio.outputFormat ?? 'Unknown'} /><Detail label="Exclusive mode" value="Not verified" />
      </PathStage>
    </div>
    <div className="honesty-note"><CircleHelp size={17} /><p>The OS mixer and DAC may change this signal. Matching sample rates do not establish bit-perfect output.</p></div>
  </aside>;
}

function DiagnosticsView({ snapshot, onExport }: { snapshot: AppSnapshot; onExport(): void }) {
  const { diagnostics: d, player } = snapshot;
  const [history, setHistory] = useState<number[]>([]);
  useEffect(() => { if (d.uptimeSeconds > 0) setHistory(values => [...values.slice(-59), d.playerBytesPerSecond]); }, [d.uptimeSeconds, d.playerBytesPerSecond]);
  const max = Math.max(1024, ...history);
  return <section className="diagnostics-view">
    <div className="page-heading"><div><h1>Nothing behind the curtain.</h1><p>Live measurements. Bounded history. No remote telemetry.</p></div><button className="secondary" onClick={onExport} disabled={!desktop}><ArrowDownToLine size={16} /> Export report</button></div>
    {!desktop && <p className="notice">Browser preview has no desktop measurements. These values are not simulated.</p>}
    <div className="metric-strip">
      <div><span>Audio stream</span><strong>{player.audio.streamBytesPerSecond === null ? 'Unknown' : `${number(player.audio.streamBytesPerSecond / 1024)} KiB/s`}</strong><small>MPV cache input, not source bitrate</small></div>
      <div><span>Audio buffer</span><strong>{player.audio.bufferSeconds === null ? 'Unknown' : `${number(player.audio.bufferSeconds)} s`}</strong><small>{player.audio.buffering ? 'Waiting for audio data' : 'No buffering reported'}</small></div>
      <div><span>Desktop startup</span><strong>{d.startupMs === null ? 'Unknown' : `${number(d.startupMs)} ms`}</strong><small>Main module to renderer loaded</small></div>
      <div><span>Pending operations</span><strong>{desktop ? d.pendingCommands : 'Unknown'}</strong><small>Includes queued requests</small></div>
    </div>
    <section className="throughput-panel"><div><h2>Player → desktop traffic</h2><p>Serialized message payloads. Includes state and command replies.</p></div><strong>{desktop ? `${number(d.playerBytesPerSecond / 1024)} KiB/s` : 'Unknown'}</strong>
      <div className="traffic-chart" aria-label="Last 60 samples of player IPC payload throughput">
        {history.length ? history.map((value, i) => <div key={i} style={{ height: `${Math.max(2, value / max * 100)}%` }} title={`${number(value)} bytes/s`} />) : <span>Waiting for desktop measurements</span>}
      </div><div className="chart-caption"><span>60-sample rolling window</span><span>{number(d.playerMessagesPerSecond)} messages/s</span></div>
    </section>
    <div className="diagnostic-tables"><section><h2>Processes</h2><p>OS-reported working set; shared pages may be counted more than once.</p><table><thead><tr><th>Process</th><th>CPU</th><th>Memory</th></tr></thead><tbody>
      {d.processes.map((process, i) => <tr key={i}><td>{process.name}</td><td>{number(process.cpuPercent)}%</td><td>{number(process.memoryMB)} MiB</td></tr>)}
      {!d.processes.length && <tr><td colSpan={3}>No process samples yet</td></tr>}
    </tbody></table></section><section><h2>Operation latency</h2><p>Last 256 samples per operation. Times include waiting for a permit.</p><table><thead><tr><th>Operation</th><th>p95</th><th>Errors / calls</th></tr></thead><tbody>
      {d.operations.map(op => <tr key={op.name}><td>{op.name}</td><td>{number(op.p95Ms)} ms</td><td>{op.errors} / {op.count}</td></tr>)}
      {!d.operations.length && <tr><td colSpan={3}>No operations recorded yet</td></tr>}
    </tbody></table></section></div>
    <p className="footnote">Main event-loop sampling interval: 20 ms. Observed mean: {desktop ? `${number(d.eventLoopDelayMs)} ms` : 'unknown'}. Renderer frame timing and device underrun counters are not instrumented yet.</p>
  </section>;
}

function ConnectionDialog({ onClose, onConnected, run }: { onClose(): void; onConnected(): void; run<T>(job: () => Promise<Result<T>>): Promise<T | undefined> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState(''); const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="connect-dialog" onCancel={event => { if (saving) event.preventDefault(); else onClose(); }} aria-labelledby="connect-title">
    <button className="icon-button dialog-close" aria-label="Close connection settings" disabled={saving} onClick={onClose}><X size={20} /></button>
    <Plug size={26} className="dialog-symbol" /><h2 id="connect-title">Connect to Navidrome</h2><p>Use your server address and Navidrome login. Other OpenSubsonic servers work too.</p>
    <form onSubmit={async event => {
      event.preventDefault(); if (!desktop || saving) return; setSaving(true); setError(null);
      try {
        const result = await desktop.connect({ url: url.trim(), username: username.trim(), password });
        setPassword('');
        if (result.ok) { onConnected(); onClose(); }
        else setError(result.error);
      } catch { setPassword(''); setError('Desktop connection failed.'); }
      finally { setSaving(false); }
    }}>
      <label>Server address<input type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://music.example.com" required autoFocus /></label>
      <p className="privacy-note">Include the port or subpath if your server uses one, for example http://localhost:4533 or https://example.com/music.</p>
      <label>Username<input autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required /></label>
      <label>Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
      {url.startsWith('http:') && <p className="notice">HTTP is unencrypted. Use it only on a trusted network or an encrypted tunnel.</p>}
      <p className="privacy-note">Session only. Your login is not saved to disk. Streaming uses an authentication token that must still be treated as a secret.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="primary wide" disabled={!desktop || saving}>{saving ? <LoaderCircle size={16} /> : <Plug size={16} />}{saving ? 'Connecting…' : desktop ? 'Connect to server' : 'Desktop app required'}</button>
      <button type="button" className="text-button" disabled={!desktop || saving} onClick={() => void run(() => desktop!.disconnect()).then(onClose)}>Disconnect and clear session</button>
    </form>
  </dialog>;
}

export default function App() {
  const snapshot = useSnapshot(); const { player, server } = snapshot;
  const [tab, setTab] = useState<Tab>('listen'); const [connectOpen, setConnectOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [albums, setAlbums] = useState<Album[]>([]); const [offset, setOffset] = useState(0);
  const [loadedLibrary, setLoadedLibrary] = useState(false);
  const volumeCommands = useRef<VolumeCommandCoalescer | null>(null);
  if (desktop && volumeCommands.current === null) {
    const bridge = desktop;
    volumeCommands.current = new VolumeCommandCoalescer(
      percent => bridge.command({ type: 'volume', percent }),
      error => setMessage(error),
    );
  }
  const librarySession = useRef(server.sessionId);
  librarySession.current = server.sessionId;
  const track = player.queue[player.currentIndex];
  const ready = !!desktop && player.engine === 'ready';

  async function run<T,>(job: () => Promise<Result<T>>): Promise<T | undefined> {
    setMessage(null);
    try { const result = await job(); if (!result.ok) { setMessage(result.error); return; } return result.value; }
    catch { setMessage('Could not reach the desktop process. Restart the app and try again.'); }
  }
  function command(value: PlayerCommand) { if (desktop) void run(() => desktop!.command(value)); }
  const loadAlbums = useCallback(async (nextOffset: number) => {
    if (!desktop) return;
    const sessionId = server.sessionId;
    setBusy(true); setMessage(null);
    try {
      const result = await desktop.albums(nextOffset);
      if (librarySession.current !== sessionId) return;
      if (result.ok) { setAlbums(result.value); setOffset(nextOffset); setLoadedLibrary(true); }
      else setMessage(result.error);
    } catch {
      if (librarySession.current === sessionId) setMessage('Could not reach the desktop process. Restart the app and try again.');
    } finally {
      if (librarySession.current === sessionId) setBusy(false);
    }
  }, [server.sessionId]);
  useEffect(() => { setAlbums([]); setLoadedLibrary(false); setOffset(0); setBusy(false); setMessage(null); }, [server.sessionId]);
  useEffect(() => { if (tab === 'library' && server.connected && !loadedLibrary) void loadAlbums(0); }, [tab, server.connected, loadedLibrary, loadAlbums]);

  return <div className="app-shell">
    <header className="app-header"><div className="wordmark"><Mark /><span>squiggly<span className="wordmark-dot">.</span></span><span className="prototype-label">First pressing</span></div>
      <nav aria-label="Main navigation">{([{ id: 'listen', name: 'Listen', icon: Headphones }, { id: 'library', name: 'Library', icon: Library }, { id: 'diagnostics', name: 'Diagnostics', icon: Activity }] as const).map(item => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)} aria-current={tab === item.id ? 'page' : undefined}><item.icon size={17} />{item.name}</button>)}</nav>
      <button className="connection-button" onClick={() => setConnectOpen(true)}><span className={`connection-dot ${server.connected ? 'connected' : ''}`} />{server.connected ? server.name : 'Connect a server'}<Settings2 size={15} /></button>
    </header>
    <div className="environment-strip"><span><span className={`engine-dot ${ready ? 'connected' : ''}`} />{!desktop ? 'Browser preview' : player.engine === 'ready' ? 'Native audio engine ready' : player.engine === 'starting' ? 'Starting audio engine' : 'Audio engine unavailable'}</span><span>Original audio requested <span className="strip-divider">/</span> No bit-perfect claim</span></div>
    {message && <div className="error-banner" role="alert"><span>{message}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setMessage(null)}><X size={17} /></button></div>}
    {tab === 'listen' && <main className="listening-layout">
      <aside className="queue-panel"><div className="section-title"><h2>Up next</h2><span className="count">{player.queue.length}</span></div><p className="section-description">An album. A side. An afternoon.</p>
        <Queue tracks={player.queue} index={player.currentIndex} onSelect={id => command({ type: 'select', id })} />
        <button className="secondary wide" disabled={!ready} onClick={() => void run(() => desktop!.openFiles())}><FolderPlus size={17} /> Open audio files</button>
        <div className="queue-note"><Disc3 size={15} /><span>FLAC, ALAC, WAV, and more.<br />Decoded by libmpv.</span></div>
      </aside>
      <section className="now-playing"><div className="listening-heading"><span><AudioLines size={15} />{player.playing ? 'Now playing' : track ? 'Ready when you are' : 'Your listening room'}</span><span>{track?.sourceFormat?.toUpperCase() ?? 'Native libmpv'}</span></div>
        <RecordSleeve track={track} /><div className="track-heading"><h1>{track?.title ?? 'Good music. Nothing in the way.'}</h1><p>{track ? `${track.artist}${track.album ? ` / ${track.album}` : ''}` : 'Start with a local file or your own music server.'}</p></div>
        <SeekBar trackIdentity={JSON.stringify([player.currentIndex, track?.source, track?.id])} position={player.position} duration={player.duration} playing={player.playing} disabled={!ready || !track}
          onSeek={seconds => track && command({ type: 'seek', seconds, queueIndex: player.currentIndex, trackId: track.id })} />
        <div className="transport"><button className="icon-button" aria-label="Stop" disabled={!ready || !track} onClick={() => command({ type: 'stop' })}><Square size={16} /></button><div className="main-transport">
          <button className="icon-button" aria-label="Previous track" disabled={!ready || player.currentIndex <= 0} onClick={() => command({ type: 'previous' })}><SkipBack size={24} fill="currentColor" /></button>
          <button className="play-button" aria-label={player.playing ? 'Pause' : 'Play'} disabled={!ready || !player.queue.length} onClick={() => command({ type: player.playing ? 'pause' : 'play' })}>{player.playing ? <Pause size={25} fill="currentColor" /> : <Play size={25} fill="currentColor" />}</button>
          <button className="icon-button" aria-label="Next track" disabled={!ready || player.currentIndex >= player.queue.length - 1 || !track} onClick={() => command({ type: 'next' })}><SkipForward size={24} fill="currentColor" /></button>
        </div><span className="transport-spacer" /></div>
        <VolumeControl volume={player.volume} disabled={!ready} commands={volumeCommands.current} />
        <div className="device-control"><Headphones size={19} /><div><label htmlFor="output-device">Output device</label><select id="output-device" value={player.audio.requestedDevice} disabled={!ready} onChange={event => command({ type: 'device', id: event.target.value })}>
          <option value="auto">System default</option>{player.devices.filter(device => device.name !== 'auto').map(device => <option key={device.name} value={device.name}>{device.description}</option>)}
        </select></div><span>Shared / exclusive<br />not verified</span></div>
        {player.error && <div className="engine-message"><p>{player.error}</p>{desktop && <button className="text-button" onClick={() => command({ type: 'restart' })}><RotateCcw size={14} /> Restart audio engine</button>}</div>}
      </section>
      <AudioInspector audio={player.audio} track={track} volume={player.volume} />
    </main>}
    {tab === 'library' && <main className="library-view"><div className="page-heading"><div><h1>Your music, on your terms.</h1><p>{server.connected ? `Newest albums from ${server.name}. Showing up to 48 at a time.` : 'Connect your library. Keep your originals.'}</p></div><button className="secondary" onClick={() => setConnectOpen(true)}><Plug size={16} />{server.connected ? 'Connection settings' : 'Connect a server'}</button></div>
      {!server.connected ? <div className="library-empty"><Library size={52} strokeWidth={1} /><h2>A home for the records you keep.</h2><p>Navidrome and OpenSubsonic support, with original streaming requested by default. Local files work without a server.</p><button className="primary" onClick={() => setConnectOpen(true)}>Connect your library</button></div>
        : <><div className="album-grid">{albums.map(album => <button key={album.id} className="album-item" disabled={!ready || busy} onClick={async () => { setBusy(true); const result = await desktop!.playAlbum(album.id); setBusy(false); if (result.ok) setTab('listen'); else setMessage(result.error); }}><div className="album-art-placeholder"><Disc3 size={56} strokeWidth={.8} /><span>{album.name.slice(0, 1)}</span></div><strong>{album.name}</strong><span>{album.artist}</span><small>{album.songCount} tracks</small></button>)}</div>
          {!albums.length && <p className="notice">{busy ? 'Loading albums…' : 'No albums on this page.'}</p>}
          <div className="pagination"><button className="secondary" disabled={busy || offset === 0} onClick={() => void loadAlbums(Math.max(0, offset - 48))}><ChevronLeft size={17} /> Previous</button><button className="secondary" disabled={busy} onClick={() => void loadAlbums(offset)}><RotateCcw size={16} /> Refresh</button><span>Page {Math.floor(offset / 48) + 1}</span><button className="secondary" disabled={busy || albums.length < 48} onClick={() => void loadAlbums(offset + 48)}>Next <ChevronRight size={17} /></button></div>
        </>}
    </main>}
    {tab === 'diagnostics' && <main><DiagnosticsView snapshot={snapshot} onExport={() => void run(() => desktop!.exportDiagnostics())} /></main>}
    <footer className="app-footer"><span><Check size={13} /> No external telemetry</span><span>{desktop ? `Session ${time(snapshot.diagnostics.uptimeSeconds)}` : 'UI preview only'}<span className="strip-divider">/</span>Squiggly 0.1</span></footer>
    {connectOpen && <ConnectionDialog onClose={() => setConnectOpen(false)} onConnected={() => setTab('library')} run={run} />}
  </div>;
}
