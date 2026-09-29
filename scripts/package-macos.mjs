// npm run package:mac: builds the macOS packages into dist/ (after `npm run build` and
// scripts/fetch-macos-runtime.mjs). The apps are unsigned; see docs/packaging.md.
//
// On a Mac this is `electron-builder --mac`: a dmg and a zip for arm64 and for x64. On any other
// host it builds the zips only, for two reasons:
// - The dmg needs hdiutil. electron-builder's dmgbuild bundle is a macOS Python, and it also runs sips.
// - electron-builder zips a macOS app with 7-Zip, which follows symlinks unless it gets -snl. That
//   flattens every .framework (Electron Framework's binary would be in the zip three times) and
//   breaks its layout. On a Mac electron-builder uses the system zip, which keeps them.
//   ELECTRON_BUILDER_7ZIP_PATH points electron-builder at a wrapper that adds -snl to its own 7za,
//   or to 7z from PATH if a later electron-builder moves its 7za. The build stops if neither works.
// Without an arch flag electron-builder builds only this host's CPU, so both are named here.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

// electron-builder's own 7za (app-builder-lib 26.15 exports getPath7za), else 7z from PATH.
// Either must understand -snl, which stores symlinks as links.
async function sevenZip() {
  try {
    const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');
    if (typeof getPath7za === 'function') return await getPath7za();
  } catch { /* Fall back to PATH below. */ }
  for (const name of ['7z', '7za']) {
    if (spawnSync(name, ['i'], { stdio: 'ignore' }).status === 0) return name;
  }
  throw new Error('No 7-Zip found: electron-builder no longer exports getPath7za and there is no 7z on PATH. A macOS zip made without 7-Zip -snl breaks the app bundle, so the build stops here.');
}

// The 7-Zip wrapper is a shell script.
if (process.platform === 'win32') throw new Error('Build the macOS packages on macOS or Linux.');
const onMac = process.platform === 'darwin';
const env = { ...process.env };
const work = mkdtempSync(join(tmpdir(), 'squiggly-package-mac-'));
try {
  if (!onMac) {
    const wrapper = join(work, '7za');
    writeFileSync(wrapper, `#!/bin/sh\nexec '${(await sevenZip()).replaceAll("'", "'\\''")}' -snl "$@"\n`);
    chmodSync(wrapper, 0o755);
    env.ELECTRON_BUILDER_7ZIP_PATH = wrapper;
    console.log('Not a Mac: building the zips only. The dmg needs macOS (hdiutil).');
  }
  const args = [require.resolve('electron-builder/cli.js'), '--mac', ...(onMac ? [] : ['zip', '--arm64', '--x64']), '--publish', 'never'];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
