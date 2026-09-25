// Writes SHA256SUMS for the release assets in a directory (default: dist/).
// The output uses the `sha256sum -c` format, so users can verify downloads with:
//   sha256sum --ignore-missing -c SHA256SUMS
// CI runs the same script on the collected release assets.
//   node scripts/release-checksums.mjs [directory]
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'dist');
// electron-builder bookkeeping, not release assets.
const ignored = new Set(['SHA256SUMS', 'builder-debug.yml', 'builder-effective-config.yaml']);

const files = readdirSync(directory)
  .filter(name => !ignored.has(name) && !name.startsWith('.') && statSync(join(directory, name)).isFile())
  .sort();
if (files.length === 0) throw new Error(`No release assets found in ${directory}`);

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolveHash(hash.digest('hex')));
  });
}

const lines = [];
for (const name of files) {
  if (/[\n\\]/.test(name)) throw new Error(`Unsupported file name for SHA256SUMS: ${JSON.stringify(name)}`);
  lines.push(`${await sha256(join(directory, name))}  ${name}`);
}
writeFileSync(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
console.log(`${join(directory, 'SHA256SUMS')}:\n${lines.join('\n')}`);
