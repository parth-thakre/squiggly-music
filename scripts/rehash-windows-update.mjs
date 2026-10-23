// Signing rewrites the Windows installer, so the update metadata electron-builder wrote beside it
// (latest.yml, and the installer's .blockmap) no longer matches. This rebuilds both with
// electron-builder's own block map code, as it wrote them, for every file latest.yml lists.
//   node scripts/rehash-windows-update.mjs [dist]
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');

const directory = process.argv[2] ?? 'dist';
const metadata = join(directory, 'latest.yml');
const lines = (await readFile(metadata, 'utf8')).split('\n');

// latest.yml names each file once under `files:` (- url:) and the main one again as `path:`,
// each followed by its sha512 and size.
const names = [...new Set(lines.map(line => /^\s*(?:- url|path): (.+)$/.exec(line)?.[1].trim()).filter(Boolean))];
const hashes = new Map();
for (const name of names) {
  const file = join(directory, name);
  if (!existsSync(file)) throw new Error(`latest.yml lists ${name}, which is not in ${directory}.`);
  hashes.set(name, await buildBlockMap(file, 'gzip', `${file}.blockmap`));
}

let current = null;
const rewritten = lines.map(line => {
  const named = /^\s*(?:- url|path): (.+)$/.exec(line);
  if (named) { current = named[1].trim(); return line; }
  const field = /^(\s*)(sha512|size): /.exec(line);
  if (!field || !current) return line;
  const hash = hashes.get(current);
  return `${field[1]}${field[2]}: ${field[2] === 'sha512' ? hash.sha512 : hash.size}`;
});
await writeFile(metadata, rewritten.join('\n'));
for (const [name, hash] of hashes) console.log(`${name}: ${hash.size} bytes, sha512 ${hash.sha512.slice(0, 16)}…`);
