import { useEffect, useState } from 'react';
import type { KeepKind, KeptContainer, Track } from '../../../../../packages/core/contracts';
import { formatBytes, formatLimit, KEPT_LIMIT_MB, MB } from '../../../../../packages/core/kept';
import { cancelKeep, forget, forgetAll, keep, keptContainer, keptSupported, openKeptFolder, useKept, useKeepStatus, useKeptVersion, isContainerKept } from './keptState';
import { player, usePlayer } from './player';
import { nav } from './route';
import { updateSettings, useSettings } from './settings';
import { TrackTable } from './TrackTable';
import { Cover, Glyph, plural, shuffled, splitTitle, Status } from './ui';
import { showNowPlaying } from './nowPlaying';
import { KeptMark } from './keptMark';
import './kept.css';

export { KeptMark };

// Keep on this device: the Kept page, the notice while the server is out of reach, the Keep
// control on records, playlists, and mixes, the kept mark, and Settings › Kept.

// For a sleeve in a grid or a row: shown only when every song is kept.
export function ContainerMark({ kind, id }: { kind: KeepKind; id: string }) {
  useKeptVersion();
  return keptSupported && isContainerKept(kind, id) ? <KeptMark className="on-sleeve" /> : null;
}

// Keep on this device, on a record's, playlist's, or mix's page. `tracks` is what the page
// shows now: a playlist that changed, or a mix drawn again, offers to update the kept copy.
export function KeepButton({ kind, id, name, artist = null, coverArt = null, tracks }: {
  kind: KeepKind; id: string; name: string; artist?: string | null; coverArt?: string | null; tracks: Track[] | null;
}) {
  const current = tracks?.map(track => track.id);
  const view = useKeepStatus(kind, id, current);
  const away = usePlayer(s => s.reach.away);
  const [admitting, setAdmitting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  if (!keptSupported) return null;
  const songs = (tracks ?? []).filter(track => track.source === 'navidrome');
  const start = async () => {
    setRefused(null); setConfirming(false);
    if (!songs.length) return;
    setAdmitting(true);
    const result = await keep({ kind, id, name, artist, coverArt, tracks: songs });
    setAdmitting(false);
    if (!result.ok) setRefused(result.error);
  };
  const cancel = async () => { setRefused(null); const result = await cancelKeep(kind, id); if (!result.ok) setRefused(result.error); };
  const remove = async () => { setConfirming(false); setRefused(null); const result = await forget(kind, id); if (!result.ok) setRefused(result.error); };
  const { status, done, total, error } = view;
  const note = refused ?? (status === 'stopped' ? error : null);
  let control;
  if (admitting) control = <button type="button" className="text-button keep-button" disabled>Checking space</button>;
  else if (status === 'waiting' || status === 'keeping' || status === 'paused') control = <>
    <span className="keep-progress" role="status">{status === 'waiting' ? `Waiting to keep ${plural(total - done, 'song')}`
      : status === 'keeping' ? `Keeping ${done} of ${plural(total, 'song')}` : `Waiting for your server. ${done} of ${total} kept.`}</span>
    <button type="button" className="text-button" onClick={() => void cancel()}>Cancel</button>
  </>;
  else if (status === 'kept') control = confirming ? <span className="keep-confirm">
    <span>Remove the {plural(total, 'kept song')} from this device?</span>
    <button type="button" className="text-button" onClick={() => void remove()}>Remove</button>
    <button type="button" className="text-button quiet" onClick={() => setConfirming(false)}>Keep them</button>
  </span> : <button type="button" className="text-button keep-button on" aria-pressed="true" onClick={() => { setRefused(null); setConfirming(true); }}><KeptMark decorative />Kept on this device</button>;
  else if (away) control = status === 'none' ? null : <span className="keep-progress">Kept {done} of {plural(total, 'song')}.</span>;
  else if (status === 'stopped' || status === 'incomplete') control = <>
    <button type="button" className="text-button keep-button" disabled={!songs.length} onClick={() => void start()}>Kept {done} of {total}. Keep the rest</button>
    {status === 'stopped' && <button type="button" className="text-button" onClick={() => void cancel()}>Cancel</button>}
  </>;
  else if (status === 'stale') control = <button type="button" className="text-button keep-button" disabled={!songs.length} onClick={() => void start()}>{kind === 'mix' ? 'Keep this draw' : 'Update kept copy'}</button>;
  else control = <button type="button" className="text-button keep-button" aria-pressed="false" disabled={!songs.length} onClick={() => void start()}>Keep on this device</button>;
  if (!control && !note) return null;
  return <span className="keep">
    {control}
    {note && <span className="keep-note" role="alert">{note}</span>}
  </span>;
}

// Out of reach. The full notice stands in for a page that needs the server; the compact one sits
// on top of the Kept page.
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export function OfflineNotice({ compact = false }: { compact?: boolean }) {
  const reach = usePlayer(s => s.reach);
  const serverName = usePlayer(s => s.serverName);
  const web = usePlayer(s => s.mode === 'web');
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    const result = await player.retryServer();
    setBusy(false);
    setFailedAt(result.ok ? null : Date.now());
  };
  const line = reach.checking || busy ? 'Checking the server.' : failedAt ? `Still out of reach at ${clock(failedAt)}.`
    : `Out of reach${reach.since ? ` since ${clock(reach.since)}` : ''}. Squiggly checks again every 30 seconds.`;
  const retryButton = <button type="button" className="text-button" disabled={reach.checking || busy} onClick={() => void retry()}>Retry</button>;
  // One line: when it went, and Retry. The every-30-seconds detail stays with the full notice.
  if (compact) return <p className="offline-line"><span role="status" aria-live="polite">{reach.checking || busy || failedAt ? line
    : `Server out of reach${reach.since ? ` since ${clock(reach.since)}` : ''}.`}</span> {retryButton}</p>;
  const server = serverName ?? 'your server';
  return <section className="offline" aria-labelledby="offline-heading">
    <h1 id="offline-heading">Your server is out of reach</h1>
    <p>{web ? `Squiggly can't reach ${server}. The browser version keeps nothing on this device, so music returns when the server does.`
      : `Squiggly can't reach ${server}. Songs kept on this device still play.`}</p>
    <p className="offline-status" role="status" aria-live="polite">{line}</p>
    <p className="actions">
      {retryButton}
      {keptSupported && <button type="button" className="text-button" onClick={() => nav.go({ view: 'kept' })}>Open kept songs</button>}
    </p>
  </section>;
}

// The Kept page: every record, playlist, and mix kept on this device, playable with the server
// away. Home shows it while the server is out of reach.
const groups: { kind: KeepKind; title: string }[] = [{ kind: 'album', title: 'Records' }, { kind: 'playlist', title: 'Playlists' }, { kind: 'mix', title: 'Mixes' }];
export function Kept() {
  const kept = useKept();
  const away = usePlayer(s => s.reach.away);
  const settings = useSettings();
  if (!keptSupported) return <>
    <header className="head"><div className="head-text"><h1>Kept</h1></div></header>
    {away && <OfflineNotice compact />}
    <Status>The browser version can't keep songs. The desktop and Android apps can.</Status>
  </>;
  const containers = kept?.containers ?? [];
  const limit = kept?.limitBytes ?? settings.keptLimitMb * MB;
  return <>
    <header className="head"><div className="head-text">
      <h1>Kept</h1>
      {kept && <p className="byline"><span>{plural(kept.songs, 'song')}, {formatBytes(kept.usedBytes)} of {roomOf(limit)}</span></p>}
    </div></header>
    {away && <OfflineNotice compact />}
    {kept?.notice && <p className="note">{kept.notice}</p>}
    {!kept ? <p className="status loading">Reading what is kept</p> : !containers.length
      ? <Status>Nothing is kept on this device yet. Choose Keep on this device on a record, playlist, or mix.</Status>
      : groups.map(group => {
        const list = containers.filter(c => c.kind === group.kind).sort((a, b) => b.keptAt - a.keptAt);
        return list.length ? <section key={group.kind} className="shelf-section" aria-labelledby={`kept-${group.kind}`}>
          <h2 id={`kept-${group.kind}`}>{group.title}</h2>
          <ul className="kept-rows">{list.map(container => <KeptRow key={`${container.kind}:${container.id}`} container={container} />)}</ul>
        </section> : null;
      })}
  </>;
}

// The room for kept songs, as short as it reads: 4 GB rather than 4,096 MB.
const roomOf = (bytes: number) => { const mb = Math.round(bytes / MB); return mb >= 1024 && mb % 1024 === 0 ? `${(mb / 1024).toLocaleString('en-US')} GB` : formatBytes(bytes); };
const kindName: Record<KeepKind, string> = { album: 'record', playlist: 'playlist', mix: 'mix' };
function KeptRow({ container }: { container: KeptContainer }) {
  const [open, setOpen] = useState(false);
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const revision = useKept()?.revision;
  const load = async () => {
    const result = await keptContainer(container.kind, container.id);
    if (!result.ok) { setError(result.error); return null; }
    setTracks(result.value.tracks);
    return result.value.tracks;
  };
  useEffect(() => { if (open) void load(); }, [open, revision]);
  const play = async (shuffle: boolean) => {
    setError(null);
    const list = tracks ?? await load();
    if (!list?.length) return;
    await player.play(shuffle ? shuffled(list) : list, 0);
    showNowPlaying();
  };
  const title = splitTitle(container.name).main;
  const count = container.present < container.total ? `${container.present} of ${plural(container.total, 'song')}` : plural(container.total, 'song');
  return <li className="kept-row">
    <div className="kept-row-head">
      <span className="kept-sleeve"><Cover id={container.coverArt} name={container.name} size={160} />{container.present >= container.total && <KeptMark className="on-sleeve" />}</span>
      <button type="button" className="kept-row-open" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span className="row-text">
          <span className="row-name">{title}<span className="sr-only">, {kindName[container.kind]}</span></span>
          {/* Who and how many. The size is for wider screens; a phone has the total above. */}
          <span className="row-sub">{[container.artist, count].filter(Boolean).join(', ')}<span className="kept-row-size">, {formatBytes(container.bytes)}</span></span>
        </span>
      </button>
      <span className="kept-row-actions">
        <button type="button" className="play-action small" disabled={!container.present} onClick={() => void play(false)}><span className="disc"><Glyph kind="play" /></span>Play<span className="sr-only"> {title}</span></button>
        <button type="button" className="text-button" disabled={!container.present} onClick={() => void play(true)}>Shuffle<span className="sr-only"> {title}</span></button>
        {confirming ? <span className="keep-confirm">
          <button type="button" className="text-button" onClick={async () => { setConfirming(false); const result = await forget(container.kind, container.id); if (!result.ok) setError(result.error); }}>Remove {title}</button>
          <button type="button" className="text-button quiet" onClick={() => setConfirming(false)}>Keep it</button>
        </span> : <button type="button" className="text-button" onClick={() => setConfirming(true)}>Remove<span className="sr-only"> {title}</span></button>}
      </span>
    </div>
    {error && <p className="note" role="alert">{error}</p>}
    {open && (tracks ? tracks.length ? <TrackTable tracks={tracks} showAlbum={container.kind !== 'album'} keptMarks={false} /> : <Status>None of its songs are kept yet.</Status>
      : <p className="status loading">Reading the songs</p>)}
  </li>;
}

// The Playlists page's section: a few kept containers and See all.
export function KeptSection() {
  const kept = useKept();
  if (!keptSupported || !kept?.containers.length) return null;
  const list = [...kept.containers].sort((a, b) => b.keptAt - a.keptAt).slice(0, 4);
  return <section className="shelf-section" aria-labelledby="kept-section">
    <div className="section-head"><h2 id="kept-section">Kept on this device</h2>
      <button type="button" className="text-button" onClick={() => nav.go({ view: 'kept' })}>See all<span className="sr-only"> kept records and playlists</span></button></div>
    <ul className="rows">
      {list.map(container => <li key={`${container.kind}:${container.id}`}>
        <button type="button" onClick={() => nav.go(container.kind === 'album' ? { view: 'album', id: container.id } : container.kind === 'playlist' ? { view: 'playlist', id: container.id } : { view: 'kept' })}>
          <Cover id={container.coverArt} name={container.name} size={160} />
          <span className="row-text"><span className="row-name">{splitTitle(container.name).main}</span>
            <span className="row-sub">{container.present < container.total ? `${container.present} of ${plural(container.total, 'song')}` : plural(container.total, 'song')}, {formatBytes(container.bytes)}</span></span>
          {container.present >= container.total && <KeptMark className="on-sleeve" />}
        </button>
      </li>)}
    </ul>
  </section>;
}

// Settings › Kept: how much is kept, the limit, the folder (desktop), and Forget all.
export function KeptSettings() {
  const kept = useKept();
  const settings = useSettings();
  const [value, setValue] = useState(String(settings.keptLimitMb));
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setValue(String(settings.keptLimitMb)); }, [settings.keptLimitMb]);
  if (!keptSupported) return null;
  const limitMb = settings.keptLimitMb;
  const over = !!kept && kept.usedBytes > limitMb * MB;
  const apply = () => {
    const next = Math.round(Number(value));
    if (!Number.isFinite(next) || next < KEPT_LIMIT_MB.min || next > KEPT_LIMIT_MB.max) { setError(`Enter a limit from ${KEPT_LIMIT_MB.min} to ${KEPT_LIMIT_MB.max.toLocaleString('en-US')} MB.`); return; }
    setError(null);
    if (next !== limitMb) void updateSettings({ keptLimitMb: next });
  };
  return <>
    <h2>Kept on this device</h2>
    <div className="setting-action">
      <p><strong>{kept ? `${plural(kept.songs, 'song')}, ${formatBytes(kept.usedBytes)} of ${formatLimit(limitMb)}` : 'Reading what is kept'}</strong>
        <span>Kept songs are the files as the server sent them, and play from this device whether the server answers or not.</span></p>
      {kept?.dir && <p className="kept-dir"><span>{kept.dir}</span></p>}
      <p className="actions kept-settings-actions">
        <button type="button" className="text-button" onClick={() => nav.go({ view: 'kept' })}>Open kept songs</button>
        {kept?.dir && <button type="button" className="text-button" onClick={async () => { const result = await openKeptFolder(); setError(result.ok ? null : result.error); }}>Open folder</button>}
      </p>
    </div>
    <label className="setting choice">
      <span><strong>Room for kept songs</strong><span>In MB. New keeps are refused once kept songs reach it.</span></span>
      <span className="kept-limit"><input type="number" inputMode="numeric" min={KEPT_LIMIT_MB.min} max={KEPT_LIMIT_MB.max} step={1} value={value}
        onChange={event => setValue(event.target.value)} onBlur={apply} onKeyDown={event => { if (event.key === 'Enter') apply(); }} /> MB</span>
    </label>
    {over && <p className="note">Kept songs use more than the new limit. Nothing is removed. New keeps are refused until you forget some.</p>}
    <div className="setting-action">
      <p><strong>Forget all</strong><span>Removes every kept song and cover from this device. Records and playlists on your server stay as they are.</span></p>
      {confirming ? <p className="keep-confirm">
        <span>Forget {kept ? plural(kept.songs, 'kept song') : 'every kept song'}?</span>
        <button type="button" className="text-button" onClick={async () => { setConfirming(false); const result = await forgetAll(); setError(result.ok ? null : result.error); }}>Forget all</button>
        <button type="button" className="text-button quiet" onClick={() => setConfirming(false)}>Keep them</button>
      </p> : <button type="button" className="text-button" disabled={!kept?.songs && !kept?.containers.length} onClick={() => setConfirming(true)}>Forget all</button>}
    </div>
    {error && <p className="note" role="alert">{error}</p>}
  </>;
}
