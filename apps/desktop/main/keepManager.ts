import { createWriteStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { KeepKind, KeptJob, KeptProgress, KeptState, Result, Track } from '../../../packages/core/contracts';
import { coverExt, isCoverType, jsonBytes, keptOnly, keptTrack, KEPT_LIMITS, KEPT_MESSAGES, limitMessage, MB, suffixFor } from '../../../packages/core/kept';
import type { PlayableTrack } from '../../../packages/player-mpv/protocol';
import type { KeepRequestIds } from '../../../packages/core/desktopValidation';
import { Unreachable } from '../../../packages/adapter-opensubsonic/client';
import { keptFileName, type KeptStore, type Orphan } from './keptStore';

// Downloads for Keep on this device, on the desktop. The main process owns them, so they go on
// whatever page the window shows. Two songs are fetched at a time across every keep, first
// asked, first fetched. Each song is the original file (format=raw) as the server sent it,
// written to a .part file, checked, synced, and renamed before the index names it.

export interface KeepDeps {
  store: KeptStore;
  // The original file's response (SubsonicClient.original). Its errors are the connector's own.
  open(trackId: string, signal: AbortSignal): Promise<Response>;
  cover(coverArt: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  // Tracks the main process has returned to a window this session.
  known(trackId: string): Track | undefined;
  limitBytes(): number;
  freeBytes(): Promise<number>;
  away(): boolean;
  // A download got no answer: the host asks whether the server is still there.
  unreachable(): void;
  // Server songs in the player's queue now. Their files are not deleted until they leave it.
  inQueue(): ReadonlySet<string>;
  changed(kind: 'progress' | 'revision'): void;
  now?(): number;
  concurrency?: number;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
}

interface Job extends KeptJob {
  songs: string[];          // still to fetch, in order
  tracks: Map<string, Track>;
  covers: string[];         // after the songs
  estimate: number;         // bytes still expected, for other keeps' admission
  attempts: Map<string, number>;
  controllers: Set<AbortController>;
  // Songs and covers of this job being fetched now.
  working: number;
  // Pauses in a row without a song kept: a server that answers pings but not downloads ends the keep.
  pauses: number;
}
class LimitReached extends Error {}
const refusedTypes = (type: string) => type.startsWith('text/') || type === 'application/json' || type === 'application/xml';
const fail = (error: string): Result => ({ ok: false, error });

export class KeepManager {
  private jobs: Job[] = [];
  private downloading = new Set<string>();
  private active = new Set<Promise<void>>();
  private inFlightBytes = new Map<string, number>();
  private pending = new Map<string, Orphan>();
  private waiters: (() => void)[] = [];
  private readonly concurrency: number;
  private readonly now: () => number;

  constructor(private readonly d: KeepDeps) {
    this.concurrency = d.concurrency ?? 2;
    this.now = d.now ?? Date.now;
  }

  state(dir: string | null): KeptState {
    const { store } = this.d;
    return {
      revision: store.revision, songs: store.songCount, usedBytes: store.usedBytes, limitBytes: this.d.limitBytes(),
      containers: store.containers(), jobs: this.jobViews(), dir, notice: store.notice,
    };
  }
  progress(): KeptProgress { return { revision: this.d.store.revision, usedBytes: this.d.store.usedBytes, jobs: this.jobViews() }; }
  private jobViews(): KeptJob[] {
    return this.jobs.map(({ kind, id, name, done, total, failed, state, error }) => ({ kind, id, name, done, total, failed, state, error }));
  }

  // Admission: checked against what is kept now, then written, then queued. Resolves before any
  // song is fetched.
  async keep(request: KeepRequestIds): Promise<Result> {
    const { store } = this.d;
    if (this.d.away()) return fail(KEPT_MESSAGES.away);
    const tracks = new Map<string, Track>();
    for (const trackId of request.trackIds) {
      const track = this.d.known(trackId) ?? store.track(trackId);
      if (!track || track.source !== 'navidrome' || track.id !== trackId) return fail(KEPT_MESSAGES.notLoaded);
      tracks.set(trackId, keptTrack(track));
    }
    // A song past the size an entry may take can't be kept; it counts as failed.
    const oversized = [...tracks.values()].filter(track => jsonBytes(track) > KEPT_LIMITS.trackJsonBytes).map(track => track.id);
    for (const trackId of oversized) tracks.delete(trackId);
    // Songs forgotten while they played, whose files are still here, come back without a download.
    for (const trackId of tracks.keys()) {
      const orphan = this.pending.get(trackId);
      if (orphan && !store.has(trackId)) { if (store.reclaim(orphan)) this.pending.delete(trackId); }
    }
    // A new record, playlist, or mix past the bound is refused; one already kept can be kept again.
    // The index is read whole or not at all, so one container too many would clear everything.
    if (!store.record(request.kind, request.id) && store.containerCount >= KEPT_LIMITS.containers) return fail(KEPT_MESSAGES.tooManyContainers);
    const missing = [...tracks.keys()].filter(trackId => !store.has(trackId) && !this.downloading.has(trackId));
    if (store.songCount + missing.length > KEPT_LIMITS.songs) return fail(KEPT_MESSAGES.tooMany);
    const entries = missing.reduce((sum, trackId) => sum + jsonBytes(tracks.get(trackId)) + KEPT_LIMITS.entryOverhead, 0);
    if (store.indexBytes + entries > KEPT_LIMITS.writeBudgetBytes) return fail(KEPT_MESSAGES.indexFull);
    const covers = this.coversFor(request.coverArt, [...tracks.values()]);
    const estimate = missing.reduce((sum, trackId) => sum + (tracks.get(trackId)?.size ?? 0), 0) + covers.length * KEPT_LIMITS.coverEstimate;
    const limit = this.d.limitBytes();
    const existing = this.jobs.find(job => job.kind === request.kind && job.id === request.id);
    const reserved = this.jobs.filter(job => job !== existing).reduce((sum, job) => sum + job.estimate, 0);
    if (missing.length && store.usedBytes + reserved + estimate > limit) {
      return fail(limitMessage(missing.length, estimate, limit - store.usedBytes - reserved, Math.round(limit / MB)));
    }
    if (missing.length && (await this.d.freeBytes().catch(() => Infinity)) - estimate < KEPT_LIMITS.headroomBytes) return fail(KEPT_MESSAGES.noDisk('computer'));
    // The record first, replacing an older one: songs only it listed are forgotten.
    const orphans = await store.setContainer({
      kind: request.kind, id: request.id, name: request.name, artist: request.artist, coverArt: request.coverArt,
      trackIds: [...request.trackIds], keptAt: this.now(),
    });
    await this.removeFiles(orphans);
    const present = request.trackIds.filter(trackId => store.has(trackId)).length;
    const job: Job = existing ?? {
      kind: request.kind, id: request.id, name: request.name, done: 0, total: 0, failed: 0, state: 'waiting', error: null,
      songs: [], tracks: new Map(), covers: [], estimate: 0, attempts: new Map(), controllers: new Set(), working: 0, pauses: 0,
    };
    Object.assign(job, {
      name: request.name, total: request.trackIds.length, done: present, failed: oversized.length, error: null,
      songs: request.trackIds.filter(trackId => tracks.has(trackId) && !store.has(trackId)), tracks, covers, estimate, attempts: new Map(), pauses: 0,
      state: job.state === 'keeping' ? 'keeping' : 'waiting',
    });
    if (!existing) this.jobs.push(job);
    this.d.changed('revision');
    this.pump();
    return { ok: true, value: undefined };
  }
  private coversFor(coverArt: string | null, tracks: Track[]) {
    const ids = [...new Set([coverArt, ...tracks.map(track => track.coverArt ?? null)].filter((id): id is string => !!id))];
    return ids.filter(id => !this.d.store.hasCover(id)).slice(0, KEPT_LIMITS.coversPerJob);
  }

  // Stops a keep, or clears one that stopped or paused. Kept songs stay.
  cancel(kind: KeepKind, id: string): Result {
    const job = this.jobs.find(j => j.kind === kind && j.id === id);
    if (!job) return { ok: true, value: undefined };
    this.drop(job);
    this.d.changed('revision');
    return { ok: true, value: undefined };
  }
  private drop(job: Job) {
    for (const controller of job.controllers) controller.abort();
    job.songs = []; job.covers = [];
    this.jobs = this.jobs.filter(j => j !== job);
    this.settle();
  }

  async forget(kind: KeepKind, id: string): Promise<Result> {
    this.cancel(kind, id);
    if (!this.d.store.record(kind, id)) return fail(KEPT_MESSAGES.unknown);
    const orphans = await this.d.store.removeContainer(kind, id);
    await this.removeFiles(orphans);
    this.d.changed('revision');
    return { ok: true, value: undefined };
  }
  async forgetAll(): Promise<Result> {
    for (const job of [...this.jobs]) this.drop(job);
    const orphans = await this.d.store.forgetAll();
    await this.removeFiles(orphans);
    await this.d.store.sweep(new Set([...this.pending.values()].map(orphan => orphan.file)));
    this.d.changed('revision');
    return { ok: true, value: undefined };
  }

  // Files in the player's queue wait until they leave it; the rest go now. A file that can't go
  // (Windows keeps open files) is left for the next launch's sweep.
  private async removeFiles(orphans: readonly Orphan[]) {
    const queued = this.d.inQueue();
    const now: Orphan[] = [];
    for (const orphan of orphans) {
      if (orphan.kind === 'song' && queued.has(orphan.id) && this.pending.size < 1000) this.pending.set(orphan.id, orphan);
      else now.push(orphan);
    }
    await this.d.store.remove(now);
  }
  // After each player snapshot, and once at quit.
  async retryPending(all = false) {
    if (!this.pending.size) return;
    const queued = all ? new Set<string>() : this.d.inQueue();
    const ready = [...this.pending.values()].filter(orphan => !queued.has(orphan.id) && !this.d.store.has(orphan.id));
    for (const orphan of ready) this.pending.delete(orphan.id);
    for (const [trackId] of this.pending) if (this.d.store.has(trackId)) this.pending.delete(trackId);
    await this.d.store.remove(ready);
  }
  get pendingDeletes() { return this.pending.size; }

  // The server answers again: paused keeps go on.
  resumePaused() {
    let resumed = false;
    for (const job of this.jobs) if (job.state === 'paused') { job.state = 'waiting'; job.attempts = new Map(); resumed = true; }
    if (resumed) { this.d.changed('progress'); this.pump(); }
  }

  // At quit: stops every download and writes what is kept.
  async stop() {
    for (const job of this.jobs) for (const controller of job.controllers) controller.abort();
    for (const job of this.jobs) { job.songs = []; job.covers = []; }
    await Promise.allSettled([...this.active]);
    await this.d.store.flush().catch(() => undefined);
  }
  // Resolves when nothing is being fetched. For tests.
  idle(): Promise<void> {
    if (!this.active.size && !this.runnable()) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }
  private settle() {
    if (this.active.size || this.runnable()) return;
    const waiters = this.waiters; this.waiters = [];
    waiters.forEach(resolve => resolve());
  }
  private runnable() { return this.jobs.some(job => job.state !== 'paused' && job.state !== 'stopped' && (job.songs.some(t => !this.downloading.has(t)) || (!job.songs.length && job.covers.length))); }

  // The queue: the first job with work, song by song, then its covers.
  private pump() {
    while (this.active.size < this.concurrency) {
      const next = this.next();
      if (!next) break;
      const task = next.run().finally(() => { next.job.working--; this.active.delete(task); this.finishJobs(); this.pump(); this.settle(); });
      next.job.working++;
      this.active.add(task);
    }
    this.finishJobs();
    this.settle();
  }
  private next(): { job: Job; run: () => Promise<void> } | null {
    for (const job of this.jobs) {
      if (job.state === 'paused' || job.state === 'stopped') continue;
      const at = job.songs.findIndex(trackId => !this.downloading.has(trackId));
      if (at >= 0) {
        const [trackId] = job.songs.splice(at, 1);
        return { job, run: () => this.song(job, trackId) };
      }
      if (!job.songs.length && job.covers.length && ![...this.downloading].some(t => job.tracks.has(t))) {
        const coverArt = job.covers.shift()!;
        return { job, run: () => this.coverTask(job, coverArt) };
      }
    }
    return null;
  }
  private finishJobs() {
    let changed = false;
    for (const job of [...this.jobs]) {
      if (job.state === 'paused' || job.state === 'stopped' || job.songs.length || job.covers.length || job.working) continue;
      if ([...this.downloading].some(trackId => job.tracks.has(trackId))) continue;
      changed = true;
      if (job.failed > 0) { job.state = 'stopped'; job.error = KEPT_MESSAGES.failed(job.failed); job.estimate = 0; }
      else this.jobs = this.jobs.filter(j => j !== job);
      void this.d.store.flush().catch(() => undefined);
    }
    if (changed) this.d.changed('revision');
  }
  private stopJob(job: Job, error: string) {
    job.state = 'stopped'; job.error = error; job.songs = []; job.covers = []; job.estimate = 0;
    for (const controller of job.controllers) controller.abort();
  }
  private pauseAll() {
    for (const job of this.jobs) {
      if (job.state === 'stopped') continue;
      job.state = 'paused';
      for (const controller of job.controllers) controller.abort();
    }
  }

  private async song(job: Job, trackId: string): Promise<void> {
    const { store } = this.d;
    const track = job.tracks.get(trackId);
    if (!track || store.has(trackId) || !store.referenced(trackId)) {
      if (store.has(trackId)) job.done++;
      this.d.changed('progress');
      return;
    }
    this.downloading.add(trackId);
    if (job.state === 'waiting') job.state = 'keeping';
    this.d.changed('progress');
    const controller = new AbortController();
    job.controllers.add(controller);
    let part: string | null = null;
    try {
      const outcome = await this.fetchSong(track, controller, path => { part = path; });
      job.done++; job.pauses = 0;
      job.estimate = Math.max(0, job.estimate - (track.size ?? outcome));
      this.d.changed('progress');
    } catch (error) {
      if (part) await rm(part, { force: true }).catch(() => undefined);
      if (!this.jobs.includes(job) || job.state === 'stopped' || job.state === 'paused') {
        // Cancelled, or another song already ended this keep. Put it back for a resume.
        if (job.state === 'paused' && !job.songs.includes(trackId)) job.songs.unshift(trackId);
        return;
      }
      if (error instanceof Unreachable) {
        job.songs.unshift(trackId);
        if (++job.pauses > 3) { this.stopJob(job, KEPT_MESSAGES.stoppedAnswering(job.done, job.total)); this.d.changed('revision'); return; }
        this.pauseAll();
        this.d.unreachable();
        this.d.changed('revision');
        return;
      }
      if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') { this.stopJob(job, KEPT_MESSAGES.diskFull(job.done, job.total)); this.d.changed('revision'); return; }
      if (error instanceof LimitReached) { this.stopJob(job, KEPT_MESSAGES.limitReached(Math.round(this.d.limitBytes() / MB), job.done, job.total)); this.d.changed('revision'); return; }
      const tries = (job.attempts.get(trackId) ?? 0) + 1;
      job.attempts.set(trackId, tries);
      if (tries < 2) job.songs.unshift(trackId);
      else { job.failed++; this.d.changed('progress'); }
    } finally {
      job.controllers.delete(controller);
      this.downloading.delete(trackId);
      this.inFlightBytes.delete(trackId);
    }
  }

  // One song: headers within 15 s, no more than 30 s between chunks, no more bytes than the limit
  // leaves, and exactly as many as the server said it would send.
  private async fetchSong(track: Track, controller: AbortController, started: (part: string) => void): Promise<number> {
    const { store } = this.d;
    const headers = setTimeout(() => controller.abort(), this.d.headerTimeoutMs ?? 15_000);
    let response: Response;
    try { response = await this.d.open(track.id, controller.signal); } finally { clearTimeout(headers); }
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (!response.ok || !response.body || refusedTypes(type)) { await response.body?.cancel().catch(() => {}); throw new Error('The server sent an error instead of the song.'); }
    const budget = this.d.limitBytes() - store.usedBytes - [...this.inFlightBytes].filter(([id]) => id !== track.id).reduce((sum, [, bytes]) => sum + bytes, 0);
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > budget) { await response.body.cancel().catch(() => {}); throw new LimitReached(); }
    const file = keptFileName('s', track.id, suffixFor(track.sourceFormat, type));
    const final = store.resolveFile(file);
    if (!final) throw new Error('Unexpected file name.');
    const part = `${final}.part`;
    started(part);
    let count = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const idleMs = this.d.idleTimeoutMs ?? 30_000;
    const kick = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), idleMs); };
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        count += chunk.byteLength;
        this.inFlightBytes.set(track.id, count);
        kick();
        done(count > budget ? new LimitReached() : null, chunk);
      },
    });
    kick();
    try {
      await pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>, { signal: controller.signal }), counter, createWriteStream(part, { mode: 0o600 }), { signal: controller.signal });
    } finally { clearTimeout(idle); }
    if (Number.isFinite(declared) && declared !== count) throw new Error('The song arrived incomplete.');
    const handle = await open(part, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(part, final);
    if (!store.referenced(track.id)) { await rm(final, { force: true }).catch(() => undefined); return count; }
    store.addSong(track, file, count);
    this.d.changed('revision');
    return count;
  }

  private async coverTask(job: Job, coverArt: string): Promise<void> {
    const { store } = this.d;
    if (store.hasCover(coverArt) || !store.coverReferenced(coverArt)) return;
    try {
      const cover = await this.d.cover(coverArt);
      const ext = cover && coverExt(cover.contentType);
      if (!cover || !ext || !isCoverType(cover.contentType) || !this.jobs.includes(job) || job.state === 'stopped') return;
      if (store.usedBytes + cover.bytes.byteLength > this.d.limitBytes()) return;
      const file = keptFileName('c', coverArt, ext);
      const final = store.resolveFile(file);
      if (!final) return;
      const part = `${final}.part`;
      try {
        const handle = await open(part, 'w', 0o600);
        try { await handle.writeFile(cover.bytes); await handle.sync(); } finally { await handle.close(); }
        await rename(part, final);
      } catch { await rm(part, { force: true }).catch(() => undefined); return; }
      if (!store.coverReferenced(coverArt)) { await rm(final, { force: true }).catch(() => undefined); return; }
      store.addCover(coverArt, file, cover.bytes.byteLength, cover.contentType);
      this.d.changed('revision');
    } catch { /* A cover that can't be kept isn't a failed keep. */ }
  }
}

// What the audio host loads for a track: a kept song's file on this computer, or its stream.
// Stations and local files pass through unchanged. The renderer never sees either.
export function pickLocation(track: Track, locate: (trackId: string) => string | null, stream: () => string): PlayableTrack {
  if (track.source !== 'navidrome') return { track, location: stream() };
  const path = locate(track.id);
  return path ? { track, location: path, kept: true } : { track, location: stream() };
}
// While the server is away only kept songs can play (stations and local files don't need it).
export function choosePlayable(tracks: readonly Track[], start: number, has: (trackId: string) => boolean, away: boolean) {
  if (!away) return { items: [...tracks], start };
  return keptOnly(tracks, start, track => track.source !== 'navidrome' || has(track.id));
}
