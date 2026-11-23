import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { STORED_ANSWERS, STORED_MAX_CHARS } from '../../../packages/core/stored';
import { writeAtomic } from './store';

// Library answers kept on this computer (packages/core/stored.ts says which), one file each, in
// one folder for the account signed in, as lyricsCache.ts keeps lyrics: another account's, and
// everything on sign-out, is removed. An answer is only ever one the server gave this process, and
// one written by another version of the app is passed over, since its shape may have changed.
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);
const HOT_ANSWERS = 32;
const TOUCH_AFTER_MS = 3_600_000;
const STAT_BATCH = 32;
interface Entry { key: string; version: string; value: unknown }

export class AnswerStore {
  private folder: string | null = null;
  private files: Set<string> | null = null;
  private hot = new Map<string, unknown>();
  private hashes = new Map<string, string>();
  private writes = 0;

  constructor(private base: string, private version: string) {}

  async bind(account: string) {
    const name = digest(account);
    const folder = join(this.base, name);
    this.folder = folder;
    this.hot.clear();
    this.hashes.clear();
    this.files = null;
    for (const other of await readdir(this.base).catch(() => [] as string[])) {
      if (other !== name) await rm(join(this.base, other), { recursive: true, force: true }).catch(() => undefined);
    }
    const existing = (await readdir(folder).catch(() => [] as string[])).filter(file => file.endsWith('.json'));
    if (this.folder !== folder) return;
    this.files = new Set(existing);
    // Past the limit from earlier sessions too, not only after this one's writes.
    await this.trim(folder);
  }
  async clear() {
    this.folder = null;
    this.files = null;
    this.hot.clear();
    this.hashes.clear();
    await rm(this.base, { recursive: true, force: true }).catch(() => undefined);
  }

  private rememberHot(fileName: string, value: unknown) {
    this.hot.delete(fileName);
    this.hot.set(fileName, value);
    if (this.hot.size > HOT_ANSWERS) this.hot.delete(this.hot.keys().next().value!);
  }

  // The answer kept under key, or undefined.
  async read(key: string): Promise<unknown> {
    const folder = this.folder;
    if (!folder) return undefined;
    const fileName = `${digest(key)}.json`;
    if (this.hot.has(fileName)) {
      const value = this.hot.get(fileName);
      this.rememberHot(fileName, value);
      return value;
    }
    if (this.files && !this.files.has(fileName)) return undefined;
    const file = join(folder, fileName);
    try {
      const info = await stat(file);
      if (info.size > STORED_MAX_CHARS * 2) return undefined;
      const raw = await readFile(file, 'utf8');
      const entry = JSON.parse(raw) as Partial<Entry> | null;
      if (!entry || entry.key !== key || entry.version !== this.version || folder !== this.folder) return undefined;
      this.files?.add(fileName);
      this.hashes.set(fileName, digest(raw));
      this.rememberHot(fileName, entry.value);
      // Shown again: last to be removed, without hammering NTFS/ext4 on rapid reads.
      if (Date.now() - info.mtimeMs > TOUCH_AFTER_MS) {
        const now = new Date();
        void utimes(file, now, now).catch(() => undefined);
      }
      return entry.value;
    } catch { return undefined; }
  }
  async write(key: string, value: unknown) {
    const folder = this.folder;
    if (!folder) return;
    const text = JSON.stringify({ key, version: this.version, value } satisfies Entry);
    if (text.length > STORED_MAX_CHARS) return;
    const fileName = `${digest(key)}.json`;
    const hash = digest(text);
    // Skip disk write + atomic rename when the serialized answer hasn't changed.
    if (this.hashes.get(fileName) === hash && (!this.files || this.files.has(fileName))) {
      this.rememberHot(fileName, value);
      return;
    }
    const file = join(folder, fileName);
    const written = await writeAtomic(file, text).then(() => true, () => false);
    // Signed out or switched accounts while writing: it isn't this account's to keep.
    if (folder !== this.folder) { await rm(file, { force: true }).catch(() => undefined); return; }
    // A failed write (a full disk) records no hash, so the same answer is written again next time.
    if (!written) { this.rememberHot(fileName, value); return; }
    this.files?.add(fileName);
    this.hashes.set(fileName, hash);
    this.rememberHot(fileName, value);
    if (++this.writes % 100 === 0) await this.trim(folder);
  }
  // Past STORED_ANSWERS, the least recently shown are removed.
  async trim(folder = this.folder) {
    if (!folder) return;
    const names = this.files && folder === this.folder
      ? [...this.files]
      : (await readdir(folder).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
    if (names.length <= STORED_ANSWERS) return;
    const dated: { name: string; at: number }[] = [];
    for (let i = 0; i < names.length; i += STAT_BATCH) {
      const chunk = names.slice(i, i + STAT_BATCH);
      const stats = await Promise.all(chunk.map(async name => ({ name, at: await stat(join(folder, name)).then(info => info.mtimeMs, () => 0) })));
      dated.push(...stats);
    }
    dated.sort((a, b) => a.at - b.at);
    for (const { name } of dated.slice(0, dated.length - STORED_ANSWERS)) {
      await rm(join(folder, name), { force: true }).catch(() => undefined);
      if (folder === this.folder) {
        this.files?.delete(name);
        this.hot.delete(name);
        this.hashes.delete(name);
      }
    }
  }
}
