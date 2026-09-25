// Shared by build.mjs (which produces the Windows libmpv build) and
// scripts/fetch-windows-runtime.mjs (which packages it).
//
// The recipe hash covers every file in build/libmpv. A build output directory carries a
// manifest.json with the hash it was built from and the SHA-256 of each output file, so
// packaging can refuse a DLL built from a different recipe or changed after the build.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const recipeDir = dirname(fileURLToPath(import.meta.url));
export const DLL = 'libmpv-2.dll';
export const SOURCE_BUNDLE = 'libmpv-windows-x64-source.tar';

const sha256 = data => createHash('sha256').update(data).digest('hex');

function files(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

// Line endings are normalized so a Windows checkout with core.autocrlf hashes the same.
export function recipeHash() {
  const lines = files(recipeDir)
    .map(path => [relative(recipeDir, path).split('\\').join('/'), path])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, path]) => `${name}\0${sha256(readFileSync(path, 'latin1').replaceAll('\r\n', '\n'))}\n`);
  return sha256(lines.join(''));
}

export function readSources() {
  return JSON.parse(readFileSync(join(recipeDir, 'sources.json'), 'utf8'));
}

// Checks a build output directory against the current recipe. Returns its manifest.
// licensesDir: the committed notices (licenses/libmpv-windows); every license file the
// build extracted from the pinned sources must be committed there unchanged.
export function verifyBuild(outputDir, { licensesDir } = {}) {
  const manifestPath = join(outputDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`No libmpv build in ${outputDir}. Run \`npm run libmpv:build\`, or download the libmpv-windows artifact from the release workflow into that directory.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const expected = recipeHash();
  if (manifest.recipeHash !== expected) {
    throw new Error(`${outputDir} was built from recipe ${manifest.recipeHash}, but build/libmpv is now ${expected}. Run \`npm run libmpv:build\` again.`);
  }
  for (const entry of [manifest.dll, manifest.sourceBundle, ...manifest.licenses]) {
    const path = join(outputDir, entry.file);
    if (!existsSync(path)) throw new Error(`Missing ${path} (listed in ${manifestPath}).`);
    const actual = sha256(readFileSync(path));
    if (actual !== entry.sha256) throw new Error(`${path} has SHA-256 ${actual}, but ${manifestPath} records ${entry.sha256}.`);
  }
  if (licensesDir) {
    for (const entry of manifest.licenses) {
      const committed = join(licensesDir, entry.file.replace(/^licenses\//, ''));
      if (!existsSync(committed) || sha256(readFileSync(committed)) !== entry.sha256) {
        throw new Error(`${committed} is missing or differs from ${entry.file} in the pinned sources. Copy it from ${join(outputDir, entry.file)}.`);
      }
    }
  }
  return manifest;
}
