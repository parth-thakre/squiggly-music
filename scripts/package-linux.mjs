// npm run package:linux: builds the Linux packages (RPM, deb, AppImage) into dist/
// (after `npm run build` and `scripts/fetch-linux-runtime.mjs`).
//
// electron-builder's AppImage toolset (appimage-12.0.1) bundles six desktop libraries in
// lib/x64 (libappindicator, libindicator, libgconf-2, libnotify, libXss, libXtst) and copies
// them into every AppImage's usr/lib. Electron links none of them, Squiggly never uses
// libnotify, and libindicator is GPL-3.0-only. Staging the pinned toolset into
// .local/appimage-tools with lib/x64 and lib/ia32 emptied, then passing APPIMAGE_TOOLS_PATH,
// keeps those libraries out of the AppImage altogether. scripts/release-notices.mjs fails the
// build if an extracted AppImage's usr/lib contains any file.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { downloads, fetchPinned } from './fetch-common.mjs';

const require = createRequire(import.meta.url);

// Pinned to match app-builder-lib's appimageChecksums["0.0.0"] (appimage-12.0.1).
const APPIMAGE_ARCHIVE = 'appimage-12.0.1.7z';
const APPIMAGE_URL = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/appimage-12.0.1/appimage-12.0.1.7z';
const APPIMAGE_SHA256 = 'd12ff7eb8f1d1ec4652ca5237a7fbdca33acc0c758045636feca62dc6ecb8ec4';

async function sevenZip() {
  try {
    const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');
    if (typeof getPath7za === 'function') return await getPath7za();
  } catch { /* Fall back to PATH below. */ }
  for (const name of ['7z', '7za']) {
    if (spawnSync(name, ['i'], { stdio: 'ignore' }).status === 0) return name;
  }
  throw new Error('No 7-Zip found: electron-builder did not provide 7za and neither 7z nor 7za is on PATH.');
}

export async function prepareAppImageTools(toolsDir = resolve('.local/appimage-tools')) {
  await fetchPinned(APPIMAGE_URL, APPIMAGE_ARCHIVE, { sha256: APPIMAGE_SHA256 });
  rmSync(toolsDir, { recursive: true, force: true });
  mkdirSync(toolsDir, { recursive: true });
  execFileSync(await sevenZip(), ['x', '-y', `-o${toolsDir}`, join(downloads, APPIMAGE_ARCHIVE)], { stdio: 'inherit' });

  // Strip the six bundled desktop libraries while keeping the empty directories that
  // electron-builder's getAppImageTools() existence check expects.
  for (const arch of ['x64', 'ia32']) {
    const dir = join(toolsDir, 'lib', arch);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  for (const bin of [join(toolsDir, 'linux-x64', 'mksquashfs'), join(toolsDir, 'linux-x64', 'desktop-file-validate')]) {
    if (existsSync(bin)) chmodSync(bin, 0o755);
  }
  if (!existsSync(join(toolsDir, 'runtime-x64')) || readdirSync(join(toolsDir, 'lib', 'x64')).length !== 0) {
    throw new Error(`Prepared AppImage toolset in ${toolsDir} is incomplete or still contains libraries.`);
  }
  return toolsDir;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  if (process.platform !== 'linux') throw new Error('Build the Linux packages on Linux.');
  const toolsDir = await prepareAppImageTools();
  const env = { ...process.env, APPIMAGE_TOOLS_PATH: toolsDir };
  const args = [require.resolve('electron-builder/cli.js'), '--linux', ...process.argv.slice(2), '--publish', 'never'];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
