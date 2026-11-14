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

export class CoverCache {
  private folder: string | null = null;
  private writes = 0;

  constructor(private base: string, private now = () => Date.now(), private maxBytes = MAX_BYTES) {}

  // Sleeves are kept for this account from now on; any other account's are removed.
  async bind(account: string) {
    const name = digest(account);
    this.folder = join(this.base, name);
    for (const other of await readdir(this.base).catch(() => [] as string[])) {
      if (other !== name) await rm(join(this.base, other), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  async clear() {
    this.folder = null;
    await rm(this.base, { recursive: true, force: true }).catch(() => undefined);
  }

  // A kept sleeve at this size while it's fresh, or null. The file is a line, "<content type> <when
  // it was fetched, in ms>", and then the image.
  async read(id: string, size: number): Promise<Sleeve | null> {
    const folder = this.folder;
    if (!folder) return null;
    const path = join(folder, `${digest(id)}-${size}`);
    try {
      const info = await stat(path);
      if (info.size > MAX_FILE) return null;
      const file = await readFile(path);
      const newline = file.indexOf(10);
      const [contentType = '', at = ''] = newline > 0 ? file.subarray(0, newline).toString('utf8').split(' ') : [];
      if (!TYPE.test(contentType) || !/^\d{1,15}$/.test(at) || newline + 1 >= file.length) return null;
      if (this.now() - Number(at) > FRESH_MS) return null;
      // Shown again: last to be removed.
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
      return { bytes: new Uint8Array(file.subarray(newline + 1)), contentType };
    } catch { return null; }
  }

  async write(id: string, size: number, sleeve: Sleeve) {
    const folder = this.folder;
    if (!folder || !TYPE.test(sleeve.contentType) || sleeve.bytes.length + 64 > MAX_FILE) return;
    const path = join(folder, `${digest(id)}-${size}`);
    await writeAtomic(path, Buffer.concat([Buffer.from(`${sleeve.contentType} ${this.now()}\n`), Buffer.from(sleeve.bytes)])).catch(() => undefined);
    // Signed out or switched accounts while writing: it isn't this account's to keep.
    if (folder !== this.folder) { await rm(path, { force: true }).catch(() => undefined); return; }
    if (++this.writes % 50 === 0) await this.trim(folder);
  }

  // Past the limit, the sleeves shown longest ago are removed.
  async trim(folder = this.folder) {
    if (!folder) return;
    const names = await readdir(folder).catch(() => [] as string[]);
    const files = await Promise.all(names.map(name => stat(join(folder, name)).then(info => ({ name, at: info.mtimeMs, size: info.size }), () => null)));
    const kept = files.filter(file => file !== null).sort((a, b) => a.at - b.at);
    let total = kept.reduce((sum, file) => sum + file.size, 0);
    for (const file of kept) {
      if (total <= this.maxBytes) break;
      total -= file.size;
      await rm(join(folder, file.name), { force: true }).catch(() => undefined);
    }
  }
}
