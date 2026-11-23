import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './store';

// The server's sleeves, kept on disk at each size asked for, so a page seen before shows its
// sleeves without asking the server again, after a restart too. Over a slow connection (the
// server's home upload, reached over Tailscale) every sleeve is a crossing that costs time and
// shares the line with the music. One folder for the account signed in: another account's, and
// all of them on sign-out, are removed, since the sleeves say what the library holds.
//
// A sleeve is reused for FRESH_MS, then asked for again, so one changed on the server turns up.
// Past MAX_BYTES, the sleeves shown longest ago go first.
const DAY = 86_400_000;
export const FRESH_MS = 14 * DAY;
export const MAX_BYTES = 300 * 1024 * 1024;
// A sleeve bigger than this isn't kept (the largest asked for is 1200 px).
const MAX_FILE = 4 * 1024 * 1024;
const TYPE = /^image\/[a-z0-9.+-]{1,40}$/;

export interface Sleeve { bytes: Uint8Array<ArrayBuffer>; contentType: string }
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);
const ENTRY = /^([0-9a-f]{32})-(\d{1,5})$/;
interface EntryMeta { at: number; size: number }

export class CoverCache {
  private folder: string | null = null;
  private writes = 0;
  // In-memory index of cached sleeves: digest -> cached sizes, and filename -> last-shown time & size.
  // Eliminates stat() syscalls on misses and full-directory stat storms during trim().
  private byId = new Map<string, Set<number>>();
  private meta = new Map<string, EntryMeta>();
  private totalBytes = 0;
  private indexed = false;

  constructor(private base: string, private now = () => Date.now(), private maxBytes = MAX_BYTES) {}

  // Sleeves are kept for this account from now on; any other account's are removed.
  async bind(account: string) {
    const name = digest(account);
    const folder = join(this.base, name);
    this.folder = folder;
    this.byId.clear();
    this.meta.clear();
    this.totalBytes = 0;
    this.indexed = false;
    for (const other of await readdir(this.base).catch(() => [] as string[])) {
      if (other !== name) await rm(join(this.base, other), { recursive: true, force: true }).catch(() => undefined);
    }
    const names = await readdir(folder).catch(() => [] as string[]);
    if (this.folder !== folder) return;
    for (const entry of names) {
      // A write cut short by a crash or quit (store.ts writeAtomic), never counted against the budget.
      const partial = /\.(\d+)\.tmp$/.exec(entry);
      if (partial && Number(partial[1]) !== process.pid) { void rm(join(folder, entry), { force: true }).catch(() => undefined); continue; }
      const match = ENTRY.exec(entry);
      if (!match) continue;
      const size = Number(match[2]);
      let sizes = this.byId.get(match[1]);
      if (!sizes) this.byId.set(match[1], sizes = new Set());
      sizes.add(size);
    }
    this.indexed = true;
  }
  async clear() {
    this.folder = null;
    this.byId.clear();
    this.meta.clear();
    this.totalBytes = 0;
    this.indexed = false;
    await rm(this.base, { recursive: true, force: true }).catch(() => undefined);
  }

  private forgetEntry(folder: string, hash: string, size: number) {
    if (this.folder !== folder) return;
    const name = `${hash}-${size}`;
    const prev = this.meta.get(name);
    if (prev) { this.totalBytes = Math.max(0, this.totalBytes - prev.size); this.meta.delete(name); }
    const sizes = this.byId.get(hash);
    if (sizes) { sizes.delete(size); if (!sizes.size) this.byId.delete(hash); }
  }

  private async readEntry(folder: string, hash: string, size: number): Promise<Sleeve | null> {
    const name = `${hash}-${size}`;
    const path = join(folder, name);
    try {
      const known = this.meta.get(name);
      if (!known) {
        const info = await stat(path);
        if (info.size > MAX_FILE) return null;
      }
      const file = await readFile(path);
      if (file.length > MAX_FILE) return null;
      const newline = file.indexOf(10);
      const [contentType = '', at = ''] = newline > 0 ? file.subarray(0, newline).toString('utf8').split(' ') : [];
      if (!TYPE.test(contentType) || !/^\d{1,15}$/.test(at) || newline + 1 >= file.length) return null;
      if (this.now() - Number(at) > FRESH_MS) return null;
      // Shown again: last to be removed. Updated in memory immediately; disk mtime refreshes in the background.
      const nowMs = Date.now();
      if (this.folder === folder) {
        const prev = this.meta.get(name);
        if (prev) prev.at = nowMs;
        else { this.meta.set(name, { at: nowMs, size: file.length }); this.totalBytes += file.length; }
      }
      const stamp = new Date(nowMs);
      void utimes(path, stamp, stamp).catch(() => undefined);
      return { bytes: new Uint8Array(file.subarray(newline + 1)), contentType };
    } catch {
      this.forgetEntry(folder, hash, size);
      return null;
    }
  }

  // A kept sleeve at this size while it's fresh, or null. The file is a line, "<content type> <when
  // it was fetched, in ms>", and then the image.
  async read(id: string, size: number): Promise<Sleeve | null> {
    const folder = this.folder;
    if (!folder) return null;
    const hash = digest(id);
    if (this.indexed && !this.byId.get(hash)?.has(size)) return null;
    return this.readEntry(folder, hash, size);
  }

  // The smallest kept sleeve on disk at or above `size`, so thumbnails and palettes reuse a larger
  // sleeve already cached on disk without crossing the network again.
  async readAtLeast(id: string, size: number): Promise<{ sleeve: Sleeve; size: number } | null> {
    const folder = this.folder;
    if (!folder) return null;
    const hash = digest(id);
    if (!this.indexed) {
      const exact = await this.readEntry(folder, hash, size);
      return exact ? { sleeve: exact, size } : null;
    }
    const sizes = this.byId.get(hash);
    if (!sizes || !sizes.size) return null;
    const candidates = [...sizes].filter(have => have >= size).sort((a, b) => a - b);
    for (const have of candidates) {
      const sleeve = await this.readEntry(folder, hash, have);
      if (sleeve) return { sleeve, size: have };
    }
    return null;
  }

  async write(id: string, size: number, sleeve: Sleeve) {
    const folder = this.folder;
    if (!folder || !TYPE.test(sleeve.contentType) || sleeve.bytes.length + 64 > MAX_FILE) return;
    const hash = digest(id);
    const name = `${hash}-${size}`;
    const path = join(folder, name);
    const payload = Buffer.concat([Buffer.from(`${sleeve.contentType} ${this.now()}\n`), Buffer.from(sleeve.bytes)]);
    const wrote = await writeAtomic(path, payload).then(() => true, () => false);
    if (!wrote) return;
    // Signed out or switched accounts while writing: it isn't this account's to keep.
    if (folder !== this.folder) { await rm(path, { force: true }).catch(() => undefined); return; }
    let sizes = this.byId.get(hash);
    if (!sizes) this.byId.set(hash, sizes = new Set());
    sizes.add(size);
    const prev = this.meta.get(name);
    this.totalBytes += payload.length - (prev?.size ?? 0);
    this.meta.set(name, { at: Date.now(), size: payload.length });
    if (++this.writes % 50 === 0) await this.trim(folder);
  }

  // Past the limit, the sleeves shown longest ago are removed.
  async trim(folder = this.folder) {
    if (!folder) return;
    const names = this.indexed && folder === this.folder
      ? [...this.byId.entries()].flatMap(([hash, sizes]) => [...sizes].map(size => `${hash}-${size}`))
      : await readdir(folder).catch(() => [] as string[]);
    // Only stat files whose size/mtime we haven't recorded yet, in small batches to avoid starving I/O.
    const unknown = names.filter(name => !this.meta.has(name));
    const BATCH = 32;
    for (let i = 0; i < unknown.length; i += BATCH) {
      if (folder !== this.folder) return;
      const chunk = unknown.slice(i, i + BATCH);
      const stats = await Promise.all(chunk.map(name => stat(join(folder, name)).then(info => ({ name, at: info.mtimeMs, size: info.size }), () => null)));
      for (const info of stats) {
        if (!info) continue;
        if (!this.meta.has(info.name)) {
          this.meta.set(info.name, { at: info.at, size: info.size });
          this.totalBytes += info.size;
        }
      }
    }
    if (folder !== this.folder) return;
    const kept = names.map(name => {
      const info = this.meta.get(name);
      return info ? { name, at: info.at, size: info.size } : null;
    }).filter((file): file is { name: string; at: number; size: number } => file !== null);
    let total = kept.reduce((sum, file) => sum + file.size, 0);
    this.totalBytes = total;
    if (total <= this.maxBytes) return;
    kept.sort((a, b) => a.at - b.at);
    for (const file of kept) {
      if (total <= this.maxBytes) break;
      total -= file.size;
      const match = ENTRY.exec(file.name);
      if (match) this.forgetEntry(folder, match[1], Number(match[2]));
      await rm(join(folder, file.name), { force: true }).catch(() => undefined);
    }
  }
}
