import { useSyncExternalStore } from 'react';

// Short messages from extensions (ctx.notify), stacked in a corner of the window. Info notes go
// away after a few seconds; errors stay until dismissed.

export interface Notice { id: number; from: string; message: string; level: 'info' | 'error' }

let notices: Notice[] = [];
let next = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function dismissNotice(id: number) {
  const before = notices.length;
  notices = notices.filter(notice => notice.id !== id);
  if (notices.length !== before) emit();
}
export function showNotice(from: string, message: string, level: Notice['level'] = 'info') {
  const notice: Notice = { id: ++next, from, message: String(message).slice(0, 500), level };
  // Keep the stack short; the oldest go first.
  notices = [...notices, notice].slice(-4);
  emit();
  if (level === 'info') setTimeout(() => dismissNotice(notice.id), 6000);
}
export const useNotices = () => useSyncExternalStore(subscribe, () => notices);

// Mount once, in the main window.
export function ExtensionNotices() {
  const list = useNotices();
  return <div className="extension-notices" aria-live="polite">
    {list.map(notice => <p key={notice.id} className={`extension-notice${notice.level === 'error' ? ' error' : ''}`} role={notice.level === 'error' ? 'alert' : undefined}>
      <strong>{notice.from}</strong> {notice.message}
      <button type="button" className="link" onClick={() => dismissNotice(notice.id)} aria-label={`Dismiss the message from ${notice.from}`}>Dismiss</button>
    </p>)}
  </div>;
}
