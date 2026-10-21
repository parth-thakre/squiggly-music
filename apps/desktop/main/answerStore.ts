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
interface Entry { key: string; version: string; value: unknown }

export class AnswerStore {
  private folder: string | null = null;
  private writes = 0;

  constructor(private base: string, private version: string) {}

  async bind(account: string) {
    const name = digest(account);
    this.folder = join(this.base, name);
    for (const other of await readdir(this.base).catch(() => [] as string[])) {
      if (other !== name) await rm(join(this.base, other), { recursive: true, force: true }).catch(() => undefined);
    }
    // Past the limit from earlier sessions too, not only after this one's writes.
    await this.trim();
  }
  async clear() {
    this.folder = null;
    await rm(this.base, { recursive: true, force: true }).catch(() => undefined);
  }

  // The answer kept under key, or undefined.
  async read(key: string): Promise<unknown> {
    const folder = this.folder;
    if (!folder) return undefined;
    const file = path(folder, key);
    try {
      if ((await stat(file)).size > STORED_MAX_CHARS * 2) return undefined;
      const entry = JSON.parse(await readFile(file, 'utf8')) as Partial<Entry> | null;
      if (!entry || entry.key !== key || entry.version !== this.version || folder !== this.folder) return undefined;
      // Shown again: last to be removed.
      const now = new Date();
      void utimes(file, now, now).catch(() => undefined);
      return entry.value;
    } catch { return undefined; }
  }
  async write(key: string, value: unknown) {
    const folder = this.folder;
    if (!folder) return;
    const text = JSON.stringify({ key, version: this.version, value } satisfies Entry);
    if (text.length > STORED_MAX_CHARS) return;
    await writeAtomic(path(folder, key), text).catch(() => undefined);
    // Signed out or switched accounts while writing: it isn't this account's to keep.
    if (folder !== this.folder) { await rm(path(folder, key), { force: true }).catch(() => undefined); return; }
    if (++this.writes % 100 === 0) await this.trim(folder);
  }
  // Past STORED_ANSWERS, the least recently shown are removed.
  async trim(folder = this.folder) {
    if (!folder) return;
    const names = (await readdir(folder).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
    if (names.length <= STORED_ANSWERS) return;
    const dated = await Promise.all(names.map(async name => ({ name, at: await stat(join(folder, name)).then(info => info.mtimeMs, () => 0) })));
    dated.sort((a, b) => a.at - b.at);
    for (const { name } of dated.slice(0, dated.length - STORED_ANSWERS)) await rm(join(folder, name), { force: true }).catch(() => undefined);
  }
}
const path = (folder: string, key: string) => join(folder, `${digest(key)}.json`);
