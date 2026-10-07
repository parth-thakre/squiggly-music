import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Either, Schema } from 'effect';

// Writes a file whole or not at all: a private temporary file beside it, then a rename. Durable
// writes also reach the disk before the rename (and the folder's entry after it, where the system
// allows), so a crash leaves the old file or the new one, never a torn one.
export async function writeAtomic(path: string, text: string, { durable = false }: { durable?: boolean } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    if (durable) await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  if (durable && process.platform !== 'win32') {
    const folder = await open(dirname(path), 'r').catch(() => null);
    if (folder) { await folder.sync().catch(() => undefined); await folder.close().catch(() => undefined); }
  }
}

// A small validated JSON file under userData. A missing, oversized, unreadable, or invalid
// file reads as the fallback; nothing from it is trusted before decoding. maxBytes (64 KiB unless
// given) bounds what is read; compact writes one line instead of indented JSON.
export class JsonStore<A, I> {
  value: A;
  private writes: Promise<void> = Promise.resolve();
  constructor(private path: string, private schema: Schema.Schema<A, I>, fallback: A, private options: { maxBytes?: number; compact?: boolean } = {}) { this.value = fallback; }

  async load(): Promise<A> {
    try {
      if ((await stat(this.path)).size > (this.options.maxBytes ?? 64 * 1024)) return this.value;
      const decoded = Schema.decodeUnknownEither(this.schema)(JSON.parse(await readFile(this.path, 'utf8')));
      if (Either.isRight(decoded)) this.value = decoded.right;
    } catch { /* Keep the fallback. */ }
    return this.value;
  }

  // Validates before writing. Writes are serialized and atomic (temporary file, then rename).
  save(value: A): Promise<void> {
    const encoded = Schema.encodeSync(this.schema)(value);
    const write = this.writes.then(async () => {
      await writeAtomic(this.path, this.options.compact ? `${JSON.stringify(encoded)}\n` : `${JSON.stringify(encoded, null, 2)}\n`);
      this.value = value;
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
