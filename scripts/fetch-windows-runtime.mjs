// Downloads the Windows audio-host runtime into .local/windows-runtime for packaging.
// The Electron utility process cannot host libmpv (see README), so a release ships
// its own Node executable beside libmpv. Koffi's Windows binary is a separate optional
// package that npm skips on other hosts.
//
// Every archive is verified against a digest pinned below, never against live metadata.
// Archives are cached in .local/downloads and rehashed on every run; the runtime directory
// is rebuilt from the verified archives each time.
//
// How the pins were checked (2026-09-25). Repeat this when bumping a version:
// - Node: the SHA-256 matches the line in https://nodejs.org/dist/<version>/SHASUMS256.txt.asc,
//   whose clearsigned signature verifies with gpg against the nodejs/release-keys keyring
//   (gpg-only-active-keys/pubring.kbx). v22.23.3 is signed by 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356
//   (Antoine du Hamel), which is listed in nodejs/release-keys keys.list. The downloaded zip was hashed locally.
// - libmpv: SHA-256 of the release asset from shinchiro/mpv-winbuild-cmake tag 20260925
//   (tag commit 05a60b3cfd04e3e3b89918f4a27f3dde2935dff2). shinchiro publishes no signatures.
// - Koffi: the sha512 integrity matches package-lock.json, the registry document, and a
//   local hash of the tarball; the registry's ECDSA signature over
//   "@koromix/koffi-win32-x64@3.3.1:<integrity>" verifies with npm's published key
//   SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { digest, downloads, fetchPinned } from './fetch-common.mjs';

const NODE_VERSION = 'v22.23.3';
const NODE_ZIP_SHA256 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71';
const MPV_BUILD = '20260925';
const MPV_ARCHIVE = 'mpv-dev-x86_64-20260925-git-2a4eb8067c.7z';
const MPV_SHA256 = 'bae4b8275f4db6ec5a6bb0c0e5d497c305a2aa9fb065097a0d86bb7b86895c7d';
const KOFFI_VERSION = '3.3.1';
const KOFFI_SHA512 = 'LYoO19cTIA7xjl+3s4VeGagCAO38VNXZ969DNszb1wTwJUjrHLrAbHFkk8fYkXineM3HJkFwElW0VLmZqXcfRg==';

// The Windows binary must match the koffi JavaScript that npm installed from the lockfile.
const installedKoffi = JSON.parse(readFileSync('node_modules/koffi/package.json', 'utf8')).version;
const locked = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages['node_modules/@koromix/koffi-win32-x64'];
if (installedKoffi !== KOFFI_VERSION || locked?.version !== KOFFI_VERSION || locked?.integrity !== `sha512-${KOFFI_SHA512}`) {
  throw new Error(`Koffi changed (installed ${installedKoffi}, locked win32-x64 ${locked?.version}). Update KOFFI_VERSION and KOFFI_SHA512 in ${import.meta.filename}.`);
}

// On Windows, use the system bsdtar: Git's GNU tar can shadow it on PATH and reads
// "C:\..." as a remote host.
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

const nodeZip = `node-${NODE_VERSION}-win-x64.zip`;
const koffiTgz = `koffi-win32-x64-${KOFFI_VERSION}.tgz`;
await fetchPinned(`https://nodejs.org/dist/${NODE_VERSION}/${nodeZip}`, nodeZip, { sha256: NODE_ZIP_SHA256 });
await fetchPinned(`https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${MPV_BUILD}/${MPV_ARCHIVE}`, MPV_ARCHIVE, { sha256: MPV_SHA256 });
await fetchPinned(`https://registry.npmjs.org/@koromix/koffi-win32-x64/-/${koffiTgz}`, koffiTgz, { sha512: KOFFI_SHA512 });

const output = resolve('.local/windows-runtime');
const work = mkdtempSync(join(tmpdir(), 'squiggly-win-runtime-'));
try {
  execFileSync('7z', ['x', '-y', `-o${join(work, 'node')}`, join(downloads, nodeZip), `node-${NODE_VERSION}-win-x64/node.exe`, `node-${NODE_VERSION}-win-x64/LICENSE`], { stdio: 'ignore' });
  execFileSync('7z', ['x', '-y', `-o${join(work, 'mpv')}`, join(downloads, MPV_ARCHIVE), 'libmpv-2.dll'], { stdio: 'ignore' });

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const nodeDir = join(work, 'node', `node-${NODE_VERSION}-win-x64`);
  copyFileSync(join(nodeDir, 'node.exe'), join(output, 'node.exe'));
  copyFileSync(join(nodeDir, 'LICENSE'), join(output, 'LICENSE.node.txt'));
  copyFileSync(join(work, 'mpv', 'libmpv-2.dll'), join(output, 'libmpv-2.dll'));
  mkdirSync(join(output, 'koffi-win32-x64'));
  execFileSync(TAR, ['-xzf', join(downloads, koffiTgz), '-C', join(output, 'koffi-win32-x64'), '--strip-components=1']);

  const versions = { node: NODE_VERSION, mpv: MPV_ARCHIVE, koffi: KOFFI_VERSION,
    sha256: Object.fromEntries(['node.exe', 'libmpv-2.dll'].map(file => [file, digest('sha256', readFileSync(join(output, file)))])) };
  writeFileSync(join(output, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
  console.log(`Windows runtime extracted to ${output}:\n${JSON.stringify(versions, null, 2)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
