// Published builds never carry diagnostics (docs/packaging.md, "Diagnostics builds"). Every
// diagnostics build has DIAGNOSTICS_MARKER (scripts/diagnostics-build.ts) in its compiled code;
// this looks for it before release-checksums.mjs writes SHA256SUMS, and stops the release if
// it's there.
//
// It reads what can be read without unpacking an installer: script files and app.asar under
// the given directories (dist/win-unpacked, dist/linux-unpacked, and the .app folders the
// installers, RPM, deb, AppImage, and zips are made from), and the app files inside .zip and
// .apk assets. NSIS installers, RPMs, debs, and AppImages are compressed, so their unpacked
// folder in dist/ is what's checked.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// scripts/diagnostics-build.ts, DIAGNOSTICS_MARKER (tests/diagnosticsBuild.test.ts keeps them equal).
export const MARKER = 'squiggly-diagnostics-build';
const SCRIPTS = /\.(?:c|m)?js$/;
// Inside an archive: the app's code, not its media or native libraries.
const ARCHIVE_ENTRIES = /(?:^|\/)app\.asar$|\/out\/.*\.(?:c|m)?js$|^assets\/.*\.(?:c|m)?js$/;

function* walk(path) {
  const stat = statSync(path);
  if (stat.isFile()) { yield path; return; }
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(path)) yield* walk(join(path, name));
}

// The entries of a zip or apk that hold the marker, or [] if unzip isn't available.
function inArchive(path) {
  const list = spawnSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (list.status !== 0) throw new Error(`Could not list ${path} (unzip -Z1): ${list.stderr || list.error?.message}`);
  const found = [];
  for (const entry of list.stdout.split('\n').filter(name => ARCHIVE_ENTRIES.test(name))) {
    const content = spawnSync('unzip', ['-p', path, entry], { maxBuffer: 1024 * 1024 * 1024 });
    if (content.status !== 0) throw new Error(`Could not read ${entry} in ${path}`);
    if (content.stdout.includes(MARKER)) found.push(`${path}!${entry}`);
  }
  return found;
}

// Every file under these paths (missing ones are skipped) that carries the marker.
export function findDiagnostics(paths) {
  const found = [];
  for (const root of paths.filter(path => existsSync(path))) {
    for (const file of walk(root)) {
      if (/\.(?:zip|apk)$/i.test(file)) found.push(...inArchive(file));
      else if (SCRIPTS.test(file) || file.endsWith('.asar')) { if (readFileSync(file).includes(MARKER)) found.push(file); }
    }
  }
  return found;
}
