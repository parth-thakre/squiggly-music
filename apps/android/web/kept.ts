import type { KeepKind, KeptApi, KeptProgress, Result, Track } from '../../../packages/core/contracts';
import { clampLimitMb, KEPT_MESSAGES, keptTrack, MB } from '../../../packages/core/kept';
import type { SubsonicClient } from '../../../packages/adapter-opensubsonic/client';
import { Squiggly } from './plugin';

// window.squigglyAndroid.kept: Keep on this device, over the native side (Kept.kt), which owns the
// index and the downloads so the player can find kept files whether or not the page is there.
// The page hands over each song's stream address, as it does for playback.

// The renderer's settings (settings.ts) keep the limit in localStorage on Android.
const limitBytes = () => {
  try { return clampLimitMb((JSON.parse(localStorage.getItem('squiggly.settings') ?? '{}') as { keptLimitMb?: unknown }).keptLimitMb) * MB; }
  catch { return clampLimitMb(undefined) * MB; }
};
const answer = (result: { ok: boolean; error: string | null } | null, fallback: string): Result =>
  result?.ok ? { ok: true, value: undefined } : { ok: false, error: result?.error || fallback };

export function createKept(deps: { client(): SubsonicClient | null; away(): boolean; unreachable(): void }): KeptApi {
  const listeners = new Set<(progress: KeptProgress) => void>();
  let paused = false;
  void Squiggly.addListener('kept', progress => {
    // A keep that paused got no answer from the server: ask whether it is still there.
    const now = progress.jobs.some(job => job.state === 'paused');
    if (now && !paused) deps.unreachable();
    paused = now;
    for (const listener of [...listeners]) listener(progress);
  });
  return {
    async state() {
      const state = await Squiggly.keptState();
      return { revision: state.revision, songs: state.songs, usedBytes: state.usedBytes, limitBytes: limitBytes(),
        containers: state.containers, jobs: state.jobs, dir: null, notice: state.notice };
    },
    async present() { return (await Squiggly.keptPresent().catch(() => ({ ids: [] }))).ids; },
    async container(kind, id) {
      const found = await Squiggly.keptContainer({ kind, id }).catch(() => null);
      if (!found) return { ok: false, error: KEPT_MESSAGES.unknown };
      const tracks: Track[] = [];
      for (const json of found.tracks) { try { tracks.push(JSON.parse(json) as Track); } catch { /* Skipped. */ } }
      return { ok: true, value: { container: found.container, trackIds: found.trackIds, tracks } };
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async keep(request) {
      if (deps.away()) return { ok: false, error: KEPT_MESSAGES.away };
      const client = deps.client();
      if (!client) return { ok: false, error: 'Connect to your server first.' };
      const songs = request.tracks.filter(track => track.source === 'navidrome')
        .map(track => ({ id: track.id, track: JSON.stringify(keptTrack(track)), url: client.streamLocation(track.id), size: track.size ?? null }));
      if (!songs.length) return { ok: false, error: KEPT_MESSAGES.notLoaded };
      const result = await Squiggly.keptKeep({ kind: request.kind, id: request.id, name: request.name, artist: request.artist, coverArt: request.coverArt, songs, limitBytes: limitBytes() }).catch(() => null);
      return answer(result, 'These songs couldn\'t be kept.');
    },
    cancel: async (kind: KeepKind, id: string) => answer(await Squiggly.keptCancel({ kind, id }).catch(() => null), 'That keep couldn\'t be stopped.'),
    forget: async (kind: KeepKind, id: string) => answer(await Squiggly.keptForget({ kind, id }).catch(() => null), KEPT_MESSAGES.unknown),
    forgetAll: async () => answer(await Squiggly.keptForgetAll().catch(() => null), 'The kept songs couldn\'t be forgotten.'),
  };
}
