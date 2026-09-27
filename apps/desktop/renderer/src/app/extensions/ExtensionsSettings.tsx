import { useId, useState } from 'react';
import type { ExtensionInfo } from '../../../../../../packages/core/contracts';
import { removeExtension, useExtensionList, useExtensionsLoaded } from './runtime';
import { openExtensionPage, useExtensionPages } from './pages';

// Settings › Extensions: every extension in the folder, on or off, its errors in plain words,
// reload, open the folder, and remove (to the trash).

const bridge = typeof window !== 'undefined' ? window.squiggly : undefined;

export function ExtensionsSettings() {
  const list = useExtensionList();
  const loaded = useExtensionsLoaded();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!bridge?.extensions) return <section className="settings extensions-settings">
    <h2>Extensions</h2>
    <p className="note">Extensions run in the desktop app.</p>
  </section>;
  const run = async (label: string, task: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true); setStatus(null);
    try { const result = await task(); setStatus(result.ok ? label : result.error ?? 'That didn\'t work.'); }
    catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section className="settings extensions-settings" aria-busy={busy}>
    <h2>Extensions</h2>
    <p className="note">Extensions add commands, menu items, pages, and themes. Each is a folder of TypeScript in the extensions folder, inside the config folder. Save a file in one and it reloads.</p>
    <p className="note">An extension isn't sandboxed. It runs in this window with everything the window can do, including changing your playlists on the server. Add only extensions you trust.</p>
    <div className="actions settings-actions">
      <button type="button" className="text-button" disabled={busy} onClick={() => void run('', () => bridge.extensions.openDir())}>Open the extensions folder</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => void run('Reloaded every extension.', () => bridge.extensions.reload())}>Reload all</button>
    </div>
    {status && <p className="note" role="status">{status}</p>}
    {!loaded ? <p className="status">Loading extensions…</p>
      : list.length === 0 ? <p className="note">No extensions yet. Copy a folder from the examples into the extensions folder.</p>
      : <ul className="extension-list">{list.map(info => <Row key={info.id} info={info} busy={busy} run={run} />)}</ul>}
  </section>;
}

function Row({ info, busy, run }: { info: ExtensionInfo; busy: boolean; run: (label: string, task: () => Promise<{ ok: boolean; error?: string }>) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const pages = useExtensionPages().filter(page => page.owner === info.id);
  const describedBy = useId();
  return <li className={`extension${info.enabled ? '' : ' off'}`}>
    <label className="setting">
      <input type="checkbox" checked={info.enabled} disabled={busy} aria-describedby={describedBy}
        onChange={event => { const on = event.target.checked; void run(on ? `Turned on ${info.name}.` : `Turned off ${info.name}.`, () => bridge!.extensions.setEnabled(info.id, on)); }} />
      <span><strong>{info.name} <span className="extension-version">{info.version}</span></strong>
        <span id={describedBy}>{info.description ?? 'No description.'} <span className="extension-source">extensions/{info.folder} · {info.id}</span></span></span>
    </label>
    {info.error && <pre className="extension-error" role="alert">{info.error}</pre>}
    {pages.length > 0 && <p className="note">Pages: {pages.map((page, i) => <span key={page.id}>{i > 0 && ', '}
      <button type="button" className="link" onClick={() => openExtensionPage(page.id)}>{page.title}</button></span>)}</p>}
    <div className="actions extension-actions">
      {!confirming ? <button type="button" className="text-button quiet" disabled={busy} onClick={() => setConfirming(true)}>Remove</button> : <>
        <span className="note">Move this folder to the trash? Its settings are removed too.</span>
        <button type="button" className="text-button danger" disabled={busy} onClick={() => void run(`Moved ${info.name} to the trash.`, () => removeExtension(info.id))}>Remove</button>
        <button type="button" className="text-button quiet" onClick={() => setConfirming(false)}>Keep it</button>
      </>}
    </div>
  </li>;
}
