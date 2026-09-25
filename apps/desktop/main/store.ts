import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Either, Schema } from 'effect';

// A small validated JSON file under userData. A missing, oversized, unreadable, or invalid
// file reads as the fallback; nothing from it is trusted before decoding.
export class JsonStore<A, I> {
  value: A;
  private writes: Promise<void> = Promise.resolve();
  constructor(private path: string, private schema: Schema.Schema<A, I>, fallback: A) { this.value = fallback; }

  async load(): Promise<A> {
    try {
      if ((await stat(this.path)).size > 64 * 1024) return this.value;
      const decoded = Schema.decodeUnknownEither(this.schema)(JSON.parse(await readFile(this.path, 'utf8')));
      if (Either.isRight(decoded)) this.value = decoded.right;
    } catch { /* Keep the fallback. */ }
    return this.value;
  }

  // Validates before writing. Writes are serialized and atomic (temporary file, then rename).
  save(value: A): Promise<void> {
    const encoded = Schema.encodeSync(this.schema)(value);
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(encoded, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      this.value = value;
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
