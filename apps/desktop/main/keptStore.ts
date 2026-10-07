import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Either, Schema } from 'effect';
import type { KeepKind, KeptContainer, KeptDetail, Track } from '../../../packages/core/contracts';
import { emptyIndex, jsonBytes, KEPT_FILE, KEPT_LIMITS, KEPT_MESSAGES, type CoverType, type KeptContainerRecord, type KeptCover, type KeptIndex, type KeptSong } from '../../../packages/core/kept';
import { KeptContainerSchema, KeptCoverSchema, KeptIndexShapeSchema, KeptSongSchema } from '../../../packages/core/keptValidation';
import { IdSchema } from '../../../packages/core/validation';
import { writeAtomic } from './store';

// The kept index and folder on the desktop: <userData>/kept/index.json and one file per song and
// cover. Node only, no Electron, so the tests run it against real folders.
//
// Two orders are never broken. A file is written, checked, synced and renamed before its entry
// is added, so an entry always names a whole file. Forgetting removes the entries and writes the
// index before any file is deleted, so a crash between the two leaves files no entry names, and
// the next start sweeps them. Only names matching KEPT_FILE (and temporary files) are ever deleted.

// A song's or cover's file name: the writer's alone. Readers take names from the index only.
export const keptFileName = (prefix: 's' | 'c', id: string, ext: string) =>
  `${prefix}-${createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32)}.${ext}`;
const INDEX = 'index.json';
const BROKEN = 'index.broken.json';
const temporary = /^index\.json\.\d+\.tmp$/;

// Files an entry used to name, once nothing refers to them.
export interface Orphan { kind: 'song' | 'cover'; id: string; file: string; bytes: number; track?: Track }

export class KeptStore {
  private index: KeptIndex = emptyIndex();
  // Bumped by every change to what is kept.
  revision = 0;
  // A one-time line for the Kept page, not persisted.
  notice: string | null = null;
  usedBytes = 0;
  // A running estimate of the index's size on disk.
  indexBytes = 0;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWrite = 0;
  private writes: Promise<void> = Promise.resolve();
  private readonly unlink: (path: string) => Promise<void>;
  private readonly now: () => number;

  constructor(readonly dir: string, options: { unlink?: (path: string) => Promise<void>; now?: () => number; debounceMs?: number } = {}) {
    this.unlink = options.unlink ?? unlink;
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? 2000;
  }
  private readonly debounceMs: number;

  get account() { return this.index.account; }
  get songCount() { return Object.keys(this.index.songs).length; }
  get containerCount() { return this.index.containers.length; }
  hasSongsFor(key: string) { return this.index.account === key && this.songCount > 0; }

  // Reads the index and cleans the folder. Anything unreadable starts empty; a broken index is
  // kept aside as index.broken.json.
  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, INDEX);
    let raw: unknown = null;
    let broken = false;
    try {
      if ((await stat(path)).size > KEPT_LIMITS.readBytes) broken = true;
      else raw = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') broken = true; }
    const shape = raw === null ? null : Schema.decodeUnknownEither(KeptIndexShapeSchema)(raw);
    if (shape && Either.isLeft(shape)) broken = true;
    this.index = shape && Either.isRight(shape) ? this.decode(shape.right) : emptyIndex();
    if (broken) {
      await rename(path, join(this.dir, BROKEN)).catch(() => undefined);
      this.notice = KEPT_MESSAGES.broken;
      this.index = emptyIndex();
    }
    this.recount();
    this.revision++;
    if (broken) await this.write();
    await this.sweep();
  }

  // Entry by entry: one bad entry is dropped, the rest stay.
  private decode(shape: Schema.Schema.Type<typeof KeptIndexShapeSchema>): KeptIndex {
    const index = emptyIndex(shape.account);
    const songs: [string, KeptSong][] = [];
    for (const [id, value] of Object.entries(shape.songs)) {
      const song = Schema.decodeUnknownEither(KeptSongSchema)(value);
      if (!Schema.is(IdSchema)(id) || Either.isLeft(song) || song.right.track.id !== id || jsonBytes(song.right.track) > KEPT_LIMITS.trackJsonBytes || !this.present(song.right.file, song.right.bytes)) continue;
      songs.push([id, { ...song.right, track: song.right.track as Track }]);
    }
    songs.sort((a, b) => b[1].keptAt - a[1].keptAt);
    for (const [id, song] of songs.slice(0, KEPT_LIMITS.songs)) index.songs[id] = song;
    const covers: [string, KeptCover][] = [];
    for (const [id, value] of Object.entries(shape.covers)) {
      const cover = Schema.decodeUnknownEither(KeptCoverSchema)(value);
      if (Schema.is(IdSchema)(id) && Either.isRight(cover) && this.present(cover.right.file, cover.right.bytes)) covers.push([id, cover.right]);
    }
    covers.sort((a, b) => b[1].keptAt - a[1].keptAt);
    for (const [id, cover] of covers.slice(0, KEPT_LIMITS.covers)) index.covers[id] = cover;
    const seen = new Set<string>();
    const containers: KeptContainerRecord[] = [];
    for (const value of shape.containers) {
      const container = Schema.decodeUnknownEither(KeptContainerSchema)(value);
      if (Either.isLeft(container) || seen.has(`${container.right.kind}:${container.right.id}`)) continue;
      seen.add(`${container.right.kind}:${container.right.id}`);
      containers.push({ ...container.right, trackIds: [...container.right.trackIds] });
    }
    index.containers = containers;
    return index;
  }

  // A stored name is used only when it is one the writer makes, stays inside the folder, and the
  // file is there with the recorded size.
  resolveFile(file: string): string | null {
    if (!KEPT_FILE.test(file)) return null;
    const path = resolve(this.dir, file);
    return path.startsWith(resolve(this.dir) + sep) ? path : null;
  }
  private present(file: string, bytes: number) {
    const path = this.resolveFile(file);
    if (!path) return false;
    try { return statSync(path).size === bytes; } catch { return false; }
  }

  // Deletes temporary and partial files, and kept files no entry names. Never anything else.
  async sweep(keep: ReadonlySet<string> = new Set()) {
    const named = new Set([...Object.values(this.index.songs).map(song => song.file), ...Object.values(this.index.covers).map(cover => cover.file), ...keep]);
    const names = await readdir(this.dir).catch(() => [] as string[]);
    await Promise.all(names.map(async name => {
      const stray = name.endsWith('.part') ? KEPT_FILE.test(name.slice(0, -5)) : temporary.test(name) || (KEPT_FILE.test(name) && !named.has(name));
      if (stray) await this.unlink(join(this.dir, name)).catch(() => undefined);
    }));
  }

  // Where a kept song's file is, checked now. A missing or resized file drops its entry, and the
  // song streams instead.
  locate(trackId: string): string | null {
    const song = this.index.songs[trackId];
    if (!song) return null;
    const path = this.resolveFile(song.file);
    let ok = false;
    try { ok = !!path && statSync(path).size === song.bytes; } catch { ok = false; }
    if (ok) return path;
    delete this.index.songs[trackId];
    this.usedBytes -= song.bytes;
    this.revision++;
    this.markDirty();
    return null;
  }
  has(trackId: string) { return trackId in this.index.songs; }
  song(trackId: string): KeptSong | undefined { return this.index.songs[trackId]; }
  track(trackId: string): Track | undefined { return this.index.songs[trackId]?.track; }
  presentIds() { return Object.keys(this.index.songs); }
  coverFile(coverArt: string): { path: string; type: CoverType } | null {
    const cover = this.index.covers[coverArt];
    const path = cover && this.resolveFile(cover.file);
    return cover && path ? { path, type: cover.type } : null;
  }
  async cover(coverArt: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string } | null> {
    const found = this.coverFile(coverArt);
    if (!found) return null;
    try { return { bytes: new Uint8Array(await readFile(found.path)), contentType: found.type }; } catch { return null; }
  }
  hasCover(coverArt: string) { return coverArt in this.index.covers; }

  record(kind: KeepKind, id: string) { return this.index.containers.find(c => c.kind === kind && c.id === id); }
  records() { return this.index.containers; }
  summary(record: KeptContainerRecord): KeptContainer {
    let present = 0, bytes = 0;
    for (const trackId of record.trackIds) { const song = this.index.songs[trackId]; if (song) { present++; bytes += song.bytes; } }
    return { kind: record.kind, id: record.id, name: record.name, artist: record.artist, coverArt: record.coverArt, total: record.trackIds.length, present, bytes, keptAt: record.keptAt };
  }
  containers(): KeptContainer[] { return this.index.containers.map(record => this.summary(record)); }
  detail(kind: KeepKind, id: string): KeptDetail | null {
    const record = this.record(kind, id);
    if (!record) return null;
    const tracks = record.trackIds.flatMap(trackId => this.index.songs[trackId] ? [this.index.songs[trackId].track] : []);
    return { container: this.summary(record), trackIds: [...record.trackIds], tracks };
  }
  // Whether a container still lists this song.
  referenced(trackId: string) { return this.index.containers.some(c => c.trackIds.includes(trackId)); }
  coverReferenced(coverArt: string) {
    return this.index.containers.some(c => c.coverArt === coverArt || c.trackIds.some(trackId => this.index.songs[trackId]?.track.coverArt === coverArt));
  }

  // A whole, synced file under its final name becomes an entry.
  addSong(track: Track, file: string, bytes: number) {
    const previous = this.index.songs[track.id];
    const song = { track, file, bytes, keptAt: this.now() };
    this.index.songs[track.id] = song;
    this.usedBytes += bytes - (previous?.bytes ?? 0);
    this.indexBytes += jsonBytes(song) + track.id.length + 8;
    this.revision++;
    this.markDirty();
  }
  addCover(coverArt: string, file: string, bytes: number, type: CoverType) {
    const previous = this.index.covers[coverArt];
    this.index.covers[coverArt] = { file, bytes, type, keptAt: this.now() };
    this.usedBytes += bytes - (previous?.bytes ?? 0);
    this.indexBytes += 120 + coverArt.length;
    this.revision++;
    this.markDirty();
  }
  // Adds or replaces a container, and returns what nothing refers to any more. Written at once.
  async setContainer(record: KeptContainerRecord): Promise<Orphan[]> {
    this.index.containers = [...this.index.containers.filter(c => !(c.kind === record.kind && c.id === record.id)), record];
    const orphans = this.prune();
    this.revision++;
    await this.write();
    return orphans;
  }
  async removeContainer(kind: KeepKind, id: string): Promise<Orphan[]> {
    this.index.containers = this.index.containers.filter(c => !(c.kind === kind && c.id === id));
    const orphans = this.prune();
    this.revision++;
    this.notice = null;
    await this.write();
    return orphans;
  }
  async forgetAll(): Promise<Orphan[]> {
    const orphans = [...this.orphanSongs(() => true), ...this.orphanCovers(() => true)];
    this.index = emptyIndex(this.index.account);
    this.recount();
    this.revision++;
    this.notice = null;
    await this.write();
    return orphans;
  }
  // Kept songs belong to one account. The same one does nothing; the first is adopted; another
  // forgets everything.
  async bind(key: string, keep: ReadonlySet<string> = new Set()) {
    if (this.index.account === key) return;
    if (this.index.account === null) { this.index.account = key; await this.write(); return; }
    this.index = emptyIndex(key);
    this.recount();
    this.revision++;
    await this.write();
    await this.sweep(keep);
  }
  // Takes back an entry that was forgotten while its file was still in use, when its file is unchanged.
  reclaim(orphan: Orphan): boolean {
    const path = this.resolveFile(orphan.file);
    try { if (!path || statSync(path).size !== orphan.bytes) return false; } catch { return false; }
    if (orphan.kind === 'song' && orphan.track) this.addSong(orphan.track, orphan.file, orphan.bytes);
    else return false;
    return true;
  }

  private orphanSongs(unreferenced: (trackId: string) => boolean): Orphan[] {
    return Object.entries(this.index.songs).filter(([trackId]) => unreferenced(trackId))
      .map(([trackId, song]) => ({ kind: 'song' as const, id: trackId, file: song.file, bytes: song.bytes, track: song.track }));
  }
  private orphanCovers(unreferenced: (coverArt: string) => boolean): Orphan[] {
    return Object.entries(this.index.covers).filter(([coverArt]) => unreferenced(coverArt))
      .map(([coverArt, cover]) => ({ kind: 'cover' as const, id: coverArt, file: cover.file, bytes: cover.bytes }));
  }
  // Drops entries no container refers to, and returns them.
  private prune(): Orphan[] {
    const listed = new Set(this.index.containers.flatMap(c => c.trackIds));
    const songs = this.orphanSongs(trackId => !listed.has(trackId));
    for (const orphan of songs) delete this.index.songs[orphan.id];
    const covers = this.orphanCovers(coverArt => !this.coverReferenced(coverArt));
    for (const orphan of covers) delete this.index.covers[orphan.id];
    this.recount();
    return [...songs, ...covers];
  }
  private recount() {
    this.usedBytes = Object.values(this.index.songs).reduce((sum, song) => sum + song.bytes, 0) + Object.values(this.index.covers).reduce((sum, cover) => sum + cover.bytes, 0);
    this.indexBytes = jsonBytes(this.index);
  }

  // Unlinks forgotten files; a file in use (Windows) or already gone is left to the next sweep.
  async remove(orphans: readonly Orphan[]) {
    await Promise.all(orphans.map(async orphan => {
      const path = this.resolveFile(orphan.file);
      if (path && !this.named(orphan.file)) await this.unlink(path).catch(() => undefined);
    }));
  }
  private named(file: string) {
    return Object.values(this.index.songs).some(song => song.file === file) || Object.values(this.index.covers).some(cover => cover.file === file);
  }

  // Downloads mark the index dirty; it is written at most every two seconds while they run.
  markDirty() {
    this.dirty = true;
    if (this.timer) return;
    const wait = Math.max(0, this.lastWrite + this.debounceMs - this.now());
    this.timer = setTimeout(() => { this.timer = null; if (this.dirty) void this.write().catch(() => undefined); }, wait);
  }
  // Writes now if anything changed since the last write.
  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.dirty) await this.write();
    else await this.writes;
  }
  // Serialized, durable, atomic. The index holds no paths, addresses, or credentials.
  write(): Promise<void> {
    this.dirty = false;
    const text = `${JSON.stringify(this.index)}\n`;
    this.indexBytes = Buffer.byteLength(text);
    this.lastWrite = this.now();
    const write = this.writes.then(() => writeAtomic(join(this.dir, INDEX), text, { durable: true }));
    this.writes = write.catch(() => { this.dirty = true; });
    return write;
  }
}

