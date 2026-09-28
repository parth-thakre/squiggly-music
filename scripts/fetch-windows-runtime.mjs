// Assembles the Windows audio-host runtime in .local/windows-runtime for packaging.
// The Electron utility process cannot host libmpv (see docs/packaging.md), so a release
// ships its own Node executable beside libmpv. Koffi's and esbuild's Windows binaries are
// separate optional packages that npm skips on other hosts.
//
// libmpv-2.dll is not downloaded: it comes from this repository's own audio-only LGPL
// build (build/libmpv). `npm run libmpv:build` writes it to .local/libmpv-windows, and the
// release workflow restores the same directory from its libmpv job. This script refuses a
// build whose manifest does not match the current recipe or whose files changed after the
// build (see build/libmpv/recipe.mjs). Set SQUIGGLY_LIBMPV_WINDOWS_DIR to use another
// build directory.
//
// Every download is verified against a digest pinned below, never against live metadata.
// Archives are cached in .local/downloads and rehashed on every run; the runtime directory
// is rebuilt from the verified archives each time.
//
// How the pins were checked (2026-09-25). Repeat this when bumping a version:
// - Node: the SHA-256 matches the line in https://nodejs.org/dist/<version>/SHASUMS256.txt.asc,
//   whose clearsigned signature verifies with gpg against the nodejs/release-keys keyring
//   (gpg-only-active-keys/pubring.kbx). v22.23.3 is signed by 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356
//   (Antoine du Hamel), which is listed in nodejs/release-keys keys.list. The downloaded zip was hashed locally.
// - Koffi: the sha512 integrity matches package-lock.json, the registry document, and a
//   local hash of the tarball; the registry's ECDSA signature over
//   "@koromix/koffi-win32-x64@3.3.1:<integrity>" verifies with npm's published key
//   SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U.
// - esbuild: the sha512 integrity of @esbuild/win32-x64 matches package-lock.json and a
//   local hash of the tarball. The script checks the lockfile again on every run.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { digest, downloads, fetchPinned } from './fetch-common.mjs';
import { DLL, verifyBuild } from '../build/libmpv/recipe.mjs';

const NODE_VERSION = 'v22.23.3';
const NODE_ZIP_SHA256 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71';
const KOFFI_VERSION = '3.3.1';
const KOFFI_SHA512 = 'LYoO19cTIA7xjl+3s4VeGagCAO38VNXZ969DNszb1wTwJUjrHLrAbHFkk8fYkXineM3HJkFwElW0VLmZqXcfRg==';
const ESBUILD_VERSION = '0.25.12';
const ESBUILD_SHA512 = 'alJC0uCZpTFrSL0CCDjcgleBXPnCrEAhTBILpeAp7M/OFgoqtAetfBzX0xM00MUsVVPpVjlPuMbREqnZCXaTnA==';

// Each Windows binary must match the JavaScript that npm installed from the lockfile.
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages;
for (const [js, binary, version, sha512] of [
  ['koffi', '@koromix/koffi-win32-x64', KOFFI_VERSION, KOFFI_SHA512],
  ['esbuild', '@esbuild/win32-x64', ESBUILD_VERSION, ESBUILD_SHA512],
]) {
  const installed = JSON.parse(readFileSync(`node_modules/${js}/package.json`, 'utf8')).version;
  const locked = lock[`node_modules/${binary}`];
  if (installed !== version || locked?.version !== version || locked?.integrity !== `sha512-${sha512}`) {
    throw new Error(`${js} changed (installed ${installed}, locked ${binary} ${locked?.version}). Update its version and SHA-512 in ${import.meta.filename}.`);
  }
}

// On Windows, use the system bsdtar: Git's GNU tar can shadow it on PATH and reads
// "C:\..." as a remote host.
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

const nodeZip = `node-${NODE_VERSION}-win-x64.zip`;
const koffiTgz = `koffi-win32-x64-${KOFFI_VERSION}.tgz`;
const esbuildTgz = `esbuild-win32-x64-${ESBUILD_VERSION}.tgz`;
await fetchPinned(`https://nodejs.org/dist/${NODE_VERSION}/${nodeZip}`, nodeZip, { sha256: NODE_ZIP_SHA256 });
await fetchPinned(`https://registry.npmjs.org/@koromix/koffi-win32-x64/-/${koffiTgz}`, koffiTgz, { sha512: KOFFI_SHA512 });
await fetchPinned(`https://registry.npmjs.org/@esbuild/win32-x64/-/win32-x64-${ESBUILD_VERSION}.tgz`, esbuildTgz, { sha512: ESBUILD_SHA512 });

const libmpvBuild = resolve(process.env.SQUIGGLY_LIBMPV_WINDOWS_DIR ?? '.local/libmpv-windows');
const libmpv = verifyBuild(libmpvBuild, { licensesDir: resolve('licenses/libmpv-windows') });
console.log(`Verified ${join(libmpvBuild, DLL)} from recipe ${libmpv.recipeHash}`);

const output = resolve('.local/windows-runtime');
const work = mkdtempSync(join(tmpdir(), 'squiggly-win-runtime-'));
try {
  execFileSync('7z', ['x', '-y', `-o${join(work, 'node')}`, join(downloads, nodeZip), `node-${NODE_VERSION}-win-x64/node.exe`, `node-${NODE_VERSION}-win-x64/LICENSE`], { stdio: 'ignore' });

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const nodeDir = join(work, 'node', `node-${NODE_VERSION}-win-x64`);
  copyFileSync(join(nodeDir, 'node.exe'), join(output, 'node.exe'));
  copyFileSync(join(nodeDir, 'LICENSE'), join(output, 'LICENSE.node.txt'));
  copyFileSync(join(libmpvBuild, DLL), join(output, DLL));
  for (const [dir, tgz] of [['koffi-win32-x64', koffiTgz], ['esbuild-win32-x64', esbuildTgz]]) {
    mkdirSync(join(output, dir));
    execFileSync(TAR, ['-xzf', join(downloads, tgz), '-C', join(output, dir), '--strip-components=1']);
  }

  const versions = { node: NODE_VERSION, libmpv: { recipeHash: libmpv.recipeHash, mpv: libmpv.sources.find(source => source.name === 'mpv').version,
    ffmpeg: libmpv.sources.find(source => source.name === 'ffmpeg').version }, koffi: KOFFI_VERSION, esbuild: ESBUILD_VERSION,
    sha256: Object.fromEntries(['node.exe', 'libmpv-2.dll'].map(file => [file, digest('sha256', readFileSync(join(output, file)))])) };
  writeFileSync(join(output, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
  console.log(`Windows runtime extracted to ${output}:\n${JSON.stringify(versions, null, 2)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
