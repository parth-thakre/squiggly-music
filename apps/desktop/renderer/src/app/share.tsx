import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Share } from '../../../../../packages/core/contracts';
import { copyText } from './exports';
import { api, invalidate, useResource } from './library';
import { plural } from './ui';
import './share.css';

// Shares: public links the server makes to songs, a record, or a playlist (Subsonic createShare).
// Navidrome makes them only with EnableSharing on; its refusal is shown as it comes. The dialog
// opens from the menus (menu.tsx); Settings lists the links that exist.

export interface ShareRequest { ids: string[]; title: string }
let request: ShareRequest | null = null;
let invoker: HTMLElement | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function openShare(next: ShareRequest) {
  const focus = document.activeElement;
  invoker = focus instanceof HTMLElement && focus !== document.body && !focus.closest('.menu-layer') ? focus : null;
  request = next; emit();
}
function closeShare() {
  request = null; emit();
  if (invoker?.isConnected) invoker.focus({ preventScroll: true });
  invoker = null;
}

const DAY = 86_400_000;
const expiries: { id: string; label: string; at: () => number | undefined }[] = [
  { id: 'day', label: '1 day', at: () => Date.now() + DAY },
  { id: 'week', label: '1 week', at: () => Date.now() + 7 * DAY },
  { id: 'month', label: '1 month', at: () => { const date = new Date(); date.setMonth(date.getMonth() + 1); return date.getTime(); } },
  // The server may still set a limit of its own (Navidrome: a year). The link then says when.
  { id: 'never', label: 'Never', at: () => undefined },
];

const dateOf = (iso: string | null) => {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null;
};
const expiryOf = (share: Share) => {
  const date = dateOf(share.expires);
  if (!date) return 'It doesn\'t expire.';
  return new Date(share.expires!).getTime() < Date.now() ? `It expired on ${date}.` : `It expires on ${date}.`;
};

export function ShareDialog() {
  const target = useSyncExternalStore(subscribe, () => request);
  return target ? <Dialog key={target.ids.join(',')} target={target} /> : null;
}

function Dialog({ target }: { target: ShareRequest }) {
  const [expiry, setExpiry] = useState('week');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [share, setShare] = useState<Share | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const sheet = matchMedia('(max-width: 760px)').matches;

  useLayoutEffect(() => { box.current?.querySelector<HTMLElement>(share ? '.share-copy' : 'input:checked')?.focus({ preventScroll: true }); }, [share]);

  const create = async () => {
    setBusy(true); setError(null);
    const result = await api.createShare(target.ids, description.trim() || undefined, expiries.find(e => e.id === expiry)?.at());
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    invalidate('shares');
    setShare(result.value);
  };
  const copy = async (url: string) => {
    const result = await copyText(url);
    setCopied(result.ok ? 'Copied the link.' : result.error);
  };
  // Modal: Escape closes, and Tab stays inside.
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeShare(); return; }
    if (event.key !== 'Tab') return;
    const items = [...(box.current?.querySelectorAll<HTMLElement>('input:not([type="radio"]), input[type="radio"]:checked, button:not(:disabled)') ?? [])];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && at <= 0) { event.preventDefault(); items[items.length - 1].focus(); }
    else if (!event.shiftKey && at === items.length - 1) { event.preventDefault(); items[0].focus(); }
  };

  return <div className="share-layer" onPointerDown={event => { if (event.target === event.currentTarget && !busy) closeShare(); }}>
    <div ref={box} className={`menu share-dialog${sheet ? ' sheet' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-own-keys onKeyDown={onKeyDown}>
      <p className="menu-title" id={titleId}><span>Share “{target.title}”</span></p>
      {!share ? <form className="share-form" aria-busy={busy} onSubmit={event => { event.preventDefault(); if (!busy) void create(); }}>
        <fieldset>
          <legend>Expires after</legend>
          <div className="share-expiries">{expiries.map(choice => <label key={choice.id}>
            <input type="radio" name="expiry" value={choice.id} checked={expiry === choice.id} onChange={() => setExpiry(choice.id)} />{choice.label}
          </label>)}</div>
        </fieldset>
        <label className="share-field"><span>Description</span>
          <input value={description} maxLength={1024} autoComplete="off" placeholder="Optional" onChange={event => setDescription(event.target.value)} /></label>
        <p className="menu-note">Anyone with the link can listen without signing in, until it expires.</p>
        {error && <p className="menu-note error" role="alert">{error}</p>}
        <div className="actions share-actions">
          <button type="submit" className="text-button" disabled={busy}>{busy ? 'Creating' : 'Create'}</button>
          <button type="button" className="text-button quiet" onClick={closeShare}>Cancel</button>
        </div>
      </form> : <div className="share-form">
        <label className="share-field"><span>Link</span>
          <input readOnly value={share.url} onFocus={event => event.currentTarget.select()} /></label>
        <p className="menu-note">{expiryOf(share)}</p>
        {copied && <p className="menu-note" role="status">{copied}</p>}
        <div className="actions share-actions">
          <button type="button" className="text-button share-copy" onClick={() => void copy(share.url)}>Copy</button>
          <button type="button" className="text-button quiet" onClick={closeShare}>Done</button>
        </div>
      </div>}
    </div>
  </div>;
}

// Settings › Shares: every link on the server. Hidden when there are none, and when the server
// doesn't share at all.
export function SharesSettings() {
  const result = useResource('shares', () => api.shares());
  const [status, setStatus] = useState<string | null>(null);
  const headingId = useId();
  if (!result?.ok || !result.value.length) return null;
  return <section className="settings shares-settings" aria-labelledby={headingId}>
    <h2 id={headingId}>Shares</h2>
    <p className="note">Public links made on your server. Anyone with one can listen without signing in, until it expires.</p>
    {status && <p className="note" role="status">{status}</p>}
    <ul className="share-list">{result.value.map(share => <ShareRow key={share.id} share={share} report={setStatus} />)}</ul>
  </section>;
}

function ShareRow({ share, report }: { share: Share; report(message: string): void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const first = share.entries[0]?.title;
  const name = share.description ?? (first ? share.entries.length > 1 ? `${first} and ${plural(share.entries.length - 1, 'more')}` : first : 'A shared link');
  const facts = [
    dateOf(share.created) && `Made on ${dateOf(share.created)}.`, expiryOf(share),
    share.visitCount !== null && (share.visitCount ? `Opened ${plural(share.visitCount, 'time')}.` : 'Not opened yet.'),
  ].filter(Boolean).join(' ');
  return <li className="share-row">
    <p><strong>{name}</strong><span>{facts}</span><span className="share-url">{share.url}</span></p>
    <div className="actions share-row-actions">
      {!confirming ? <>
        <button type="button" className="text-button" onClick={async () => { const result = await copyText(share.url); report(result.ok ? `Copied the link to ${name}.` : result.error); }}>Copy</button>
        <button type="button" className="text-button quiet" onClick={() => setConfirming(true)}>Delete</button>
      </> : <>
        <span className="note">Delete this link? Anyone who has it can no longer listen.</span>
        <button type="button" className="text-button danger" disabled={busy} onClick={async () => {
          setBusy(true);
          const result = await api.deleteShare(share.id);
          setBusy(false);
          if (!result.ok) { report(result.error); return; }
          report(`Deleted the link to ${name}.`);
          invalidate('shares');
        }}>Delete</button>
        <button type="button" className="text-button quiet" onClick={() => setConfirming(false)}>Keep it</button>
      </>}
    </div>
  </li>;
}
