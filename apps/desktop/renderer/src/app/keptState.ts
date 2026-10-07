import { useEffect, useState, useSyncExternalStore } from 'react';
import type { KeepKind, KeepRequest, KeptApi, KeptDetail, KeptState, Result, Track } from '../../../../../packages/core/contracts';
import { keepStatus, type KeepView } from '../../../../../packages/core/kept';

// Songs kept on this device, as the host reports them: the desktop's main process
// (window.squiggly.kept) or the Android bridge (window.squigglyAndroid.kept). The browser build
// has neither and keeps nothing. Progress arrives as pushes; when what is kept changes (the
// revision), the state and the kept ids are read again, at most once a second.
const source: KeptApi | null = typeof window !== 'undefined' ? window.squiggly?.kept ?? window.squigglyAndroid?.kept ?? null : null;
export const keptSupported = !!source;

let state: KeptState | null = null;
let present: ReadonlySet<string> = new Set();
let complete: ReadonlySet<string> = new Set();
let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

let pulling = false, again = false, lastPull = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
async function pull() {
  if (!source) return;
  if (pulling) { again = true; return; }
  pulling = true; lastPull = Date.now();
  try {
    const [next, ids] = await Promise.all([source.state(), source.present()]);
    state = next;
    present = new Set(ids);
    complete = new Set(next.containers.filter(c => c.present >= c.total).map(c => `${c.kind}:${c.id}`));
    emit();
  } catch { /* The next change tries again. */ }
  finally {
    pulling = false;
    if (again) { again = false; schedule(); }
  }
}
function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = undefined; void pull(); }, Math.max(0, lastPull + 1000 - Date.now()));
}
if (source) {
  source.subscribe(progress => {
    if (!state) { schedule(); return; }
    const changed = progress.revision !== state.revision;
    state = { ...state, jobs: progress.jobs, usedBytes: progress.usedBytes };
    emit();
    if (changed) schedule();
  });
  void pull();
}
// Asks again at once, after something this page did.
export const refreshKept = () => { if (source) void pull(); };

export const getKept = () => state;
export const useKept = () => useSyncExternalStore(subscribe, () => state);
export const useKeptVersion = () => useSyncExternalStore(subscribe, () => version);
export const isKept = (trackId: string) => present.has(trackId);
export const isContainerKept = (kind: KeepKind, id: string) => complete.has(`${kind}:${id}`);
export const keptCount = () => present.size;

// A Keep control's state. `current` is the list the page shows now, to tell a stale copy.
export type KeepControl = Omit<KeepView, 'status'> & { status: KeepView['status'] | 'admitting' };
export function useKeepStatus(kind: KeepKind, id: string, current?: readonly string[]): KeepView {
  const kept = useKept();
  const [detail, setDetail] = useState<KeptDetail | null>(null);
  const revision = kept?.revision ?? -1;
  const listed = !!kept?.containers.some(c => c.kind === kind && c.id === id);
  useEffect(() => {
    if (!source || !listed) { setDetail(null); return; }
    let live = true;
    void source.container(kind, id).then(result => { if (live) setDetail(result.ok ? result.value : null); });
    return () => { live = false; };
  }, [kind, id, revision, listed]);
  return keepStatus(kept, detail, kind, id, current);
}

export async function keep(request: KeepRequest): Promise<Result> {
  if (!source) return { ok: false, error: 'This version of Squiggly can\'t keep songs.' };
  const result = await source.keep(request);
  refreshKept();
  return result;
}
export async function cancelKeep(kind: KeepKind, id: string): Promise<Result> {
  if (!source) return { ok: true, value: undefined };
  const result = await source.cancel(kind, id);
  refreshKept();
  return result;
}
export async function forget(kind: KeepKind, id: string): Promise<Result> {
  if (!source) return { ok: true, value: undefined };
  const result = await source.forget(kind, id);
  refreshKept();
  return result;
}
export async function forgetAll(): Promise<Result> {
  if (!source) return { ok: true, value: undefined };
  const result = await source.forgetAll();
  refreshKept();
  return result;
}
export const keptContainer = (kind: KeepKind, id: string): Promise<Result<KeptDetail>> => source
  ? source.container(kind, id) : Promise.resolve({ ok: false, error: 'This version of Squiggly can\'t keep songs.' });
export const openKeptFolder = (): Promise<Result> => source?.openDir ? source.openDir() : Promise.resolve({ ok: true, value: undefined });
export const keptTracks = (tracks: readonly Track[]) => tracks.filter(track => track.source === 'navidrome' && present.has(track.id));
