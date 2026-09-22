import { useSyncExternalStore } from 'react';
import { emptyDiagnostics, emptyPlayer } from '../../../../packages/core/contracts';
import type { AppSnapshot } from '../../../../packages/core/contracts';

let snapshot: AppSnapshot = {
  player: { ...emptyPlayer(), engine: 'unavailable', error: window.squiggly ? null : 'Browser preview. Open the desktop app for native playback and live diagnostics.' },
  diagnostics: emptyDiagnostics(), server: { connected: false, name: null, sessionId: null },
};
const listeners = new Set<() => void>();
const update = (next: AppSnapshot) => { snapshot = next; listeners.forEach(listener => listener()); };
if (window.squiggly) {
  let receivedEvent = false;
  let disposed = false;
  const unsubscribe = window.squiggly.subscribe(next => { receivedEvent = true; update(next); });
  void window.squiggly.snapshot().then(next => { if (!disposed && !receivedEvent) update(next); });
  import.meta.hot?.dispose(() => { disposed = true; unsubscribe(); });
}
export const useSnapshot = () => useSyncExternalStore(
  listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  () => snapshot,
);
export const desktop = window.squiggly;
