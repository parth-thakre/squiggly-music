import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { Either, Schema } from 'effect';
import type { Lyrics } from '../../../packages/core/contracts';
import { writeAtomic } from './store';

// Lyrics already looked up, kept on disk so a song played before shows its lyrics at once, while
// away from the server too, and LRCLIB isn't asked again each time it plays. One folder for the
// account signed in: another account's, and everything on sign-out, is removed, since the songs
// looked up say what was listened to.
//
// Found lyrics are reused for 30 days, then asked for again; an answer of none for a day, so
// lyrics added on the server or to LRCLIB since turn up. A lookup that fails, or the server out of
// reach, falls back to what is kept however old. Failures aren't kept.
const DAY = 86_400_000;
export const FOUND_MS = 30 * DAY;
export const NONE_MS = DAY;
// Songs kept: the least recently shown go first.
const KEEP = 4000;
const MAX_BYTES = 4 * 1024 * 1024;

const Time = Schema.Number.pipe(Schema.finite());
const Text = Schema.String.pipe(Schema.maxLength(200_000));
const LyricsSchema = Schema.Struct({
  synced: Schema.Boolean,
  lines: Schema.Array(Schema.Struct({
    start: Schema.NullOr(Time), end: Schema.optional(Schema.NullOr(Time)), text: Text,
    words: Schema.optional(Schema.Array(Schema.Struct({ start: Time, end: Time, text: Text }))),
  })),
  wordTiming: Schema.NullOr(Schema.Literal('exact', 'estimated')),
  source: Schema.Literal('server', 'lrclib'),
});
// lookup: whether LRCLIB was allowed, which matters to an answer of none.
const EntrySchema = Schema.Struct({ id: Schema.String, at: Time, lookup: Schema.Boolean, lyrics: Schema.NullOr(LyricsSchema) });
type Entry = Schema.Schema.Type<typeof EntrySchema>;

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

// Whether a kept answer answers this request. Server lyrics always do. LRCLIB's only while lookups
// are allowed. None does if LRCLIB was asked too, or isn't now.
const answers = (entry: Entry, lookup: boolean) => entry.lyrics ? entry.lyrics.source === 'server' || lookup : entry.lookup || !lookup;

export class LyricsCache {
  private folder: string | null = null;
  // One lookup per song and lookup setting at a time: the deck, the sheet, and the next song's
  // warming ask together.
  private asking = new Map<string, Promise<{ lyrics: Lyrics | null; failed: unknown }>>();
  private writes = 0;

  constructor(private base: string, private now = () => Date.now()) {}

  // Lyrics are kept for this account from now on; any other account's are removed.
  async bind(account: string) {
    const name = digest(account);
    this.folder = join(this.base, name);
    this.asking.clear();
    for (const other of await readdir(this.base).catch(() => [] as string[])) {
      if (other !== name) await rm(join(this.base, other), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  async clear() {
    this.folder = null;
    this.asking.clear();
    await rm(this.base, { recursive: true, force: true }).catch(() => undefined);
  }

  // A song's lyrics: kept ones while fresh (or while away, however old), otherwise ask's answer,
  // which is then kept. failed is ask's error when kept lyrics answered in its place; with
  // nothing kept, the error is thrown.
  answer(id: string, lookup: boolean, ask: () => Promise<Lyrics | null>, away: boolean): Promise<{ lyrics: Lyrics | null; failed: unknown }> {
    const folder = this.folder;
    const key = `${id}\n${lookup}`;
    const current = this.asking.get(key);
    if (current) return current;
    const task = (async () => {
      const kept = folder ? await this.read(folder, id) : null;
      const usable = kept && answers(kept, lookup) ? kept : null;
      if (usable && (away || this.now() - usable.at < (usable.lyrics ? FOUND_MS : NONE_MS))) return { lyrics: usable.lyrics as Lyrics | null, failed: null };
      try {
        const lyrics = await ask();
        if (folder) await this.write(folder, { id, at: this.now(), lookup, lyrics });
        return { lyrics, failed: null };
      } catch (error) {
        if (usable) return { lyrics: usable.lyrics as Lyrics | null, failed: error };
        throw error;
      }
    })().finally(() => { if (this.asking.get(key) === task) this.asking.delete(key); });
    this.asking.set(key, task);
    return task;
  }

  private async read(folder: string, id: string): Promise<Entry | null> {
    const path = join(folder, `${digest(id)}.json`);
    try {
      if ((await stat(path)).size > MAX_BYTES) return null;
      const decoded = Schema.decodeUnknownEither(EntrySchema)(JSON.parse(await readFile(path, 'utf8')));
      if (Either.isLeft(decoded) || decoded.right.id !== id) return null;
      // Shown again: last to be removed.
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
      return decoded.right;
    } catch { return null; }
  }
  private async write(folder: string, entry: Entry) {
    const path = join(folder, `${digest(entry.id)}.json`);
    const text = JSON.stringify(entry);
    if (text.length > MAX_BYTES || folder !== this.folder) return;
    await writeAtomic(path, text).catch(() => undefined);
    // Signed out or switched accounts while writing: it isn't this account's to keep.
    if (folder !== this.folder) { await rm(path, { force: true }).catch(() => undefined); return; }
    if (++this.writes % 50 === 0) await this.trim(folder);
  }
  // Past KEEP songs, the least recently shown are removed.
  async trim(folder = this.folder) {
    if (!folder) return;
    const names = (await readdir(folder).catch(() => [] as string[])).filter(name => name.endsWith('.json'));
    if (names.length <= KEEP) return;
    const dated = await Promise.all(names.map(async name => ({ name, at: await stat(join(folder, name)).then(info => info.mtimeMs, () => 0) })));
    dated.sort((a, b) => a.at - b.at);
    for (const { name } of dated.slice(0, dated.length - KEEP)) await rm(join(folder, name), { force: true }).catch(() => undefined);
  }
}
