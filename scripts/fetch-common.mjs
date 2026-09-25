// Shared download cache for the runtime fetch scripts.
// Every archive is checked against a digest committed in the calling script. Cached
// archives are rehashed on every run, and a mismatch is deleted and downloaded again.
// Live upstream metadata (SHASUMS256.txt, registry documents) is never trusted here.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const downloads = resolve('.local/downloads');

export function digest(algorithm, data, encoding = 'hex') {
  return createHash(algorithm).update(data).digest(encoding);
}

// expected: { sha256: 'hex' } or { sha512: 'base64' } (npm integrity without the prefix).
function matches(data, expected) {
  if (expected.sha256) return digest('sha256', data) === expected.sha256;
  if (expected.sha512) return digest('sha512', data, 'base64') === expected.sha512;
  throw new Error('No pinned digest given.');
}

// Returns the verified archive bytes, from the cache when its digest still matches.
export async function fetchPinned(url, fileName, expected) {
  mkdirSync(downloads, { recursive: true });
  const cached = join(downloads, fileName);
  if (existsSync(cached)) {
    const data = readFileSync(cached);
    if (matches(data, expected)) {
      console.log(`Verified cached ${fileName}`);
      return data;
    }
    console.warn(`Cached ${fileName} does not match its pinned digest. Downloading it again.`);
    rmSync(cached);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!matches(data, expected)) {
    throw new Error(`Checksum mismatch for ${fileName} from ${url}. Expected ${JSON.stringify(expected)}, got sha256 ${digest('sha256', data)}.`);
  }
  // Write then rename, so an interrupted run never leaves a partial file under the final name.
  writeFileSync(`${cached}.partial`, data);
  renameSync(`${cached}.partial`, cached);
  console.log(`Downloaded and verified ${fileName}`);
  return data;
}
