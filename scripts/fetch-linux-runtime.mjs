// Downloads the Linux audio-host runtime into .local/linux-runtime for packaging.
// The Electron utility process cannot host libmpv (see README), so a release ships
// its own Node executable. libmpv is not bundled on Linux: the package depends on
// the distribution's libmpv (Fedora: mpv-libs). Koffi's linux-x64 binary is an
// optional npm package that is already installed on linux-x64 hosts (npm ci checks
// its lockfile integrity).
//
// The Node archive is verified against the digest pinned below, never against live
// metadata. It is cached in .local/downloads and rehashed on every run; the runtime
// directory is rebuilt from the verified archive each time.
//
// How the pin was checked (2026-09-25). Repeat this when bumping NODE_VERSION: the
// SHA-256 matches the line in https://nodejs.org/dist/<version>/SHASUMS256.txt.asc, whose
// clearsigned signature verifies with gpg against the nodejs/release-keys keyring
// (gpg-only-active-keys/pubring.kbx). v22.23.3 is signed by 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356
// (Antoine du Hamel), listed in nodejs/release-keys keys.list. The tarball was hashed locally.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { digest, downloads, fetchPinned } from './fetch-common.mjs';

const NODE_VERSION = 'v22.23.3';
const NODE_TAR_SHA256 = 'df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de';
const ARCH = 'x64';

if (!existsSync(`node_modules/@koromix/koffi-linux-${ARCH}/linux_${ARCH}/koffi.node`)) {
  throw new Error(`@koromix/koffi-linux-${ARCH} is missing from node_modules. Run npm ci on a linux-${ARCH} host.`);
}

// electron-builder's bundled fpm (used for the RPM) runs a Ruby that links libcrypt.so.1.
// Fail before the long packaging step instead of inside it.
const hasLibcrypt1 = execFileSync('/sbin/ldconfig', ['-p']).toString().includes('libcrypt.so.1 ')
  || (process.env.LD_LIBRARY_PATH ?? '').split(':').some(dir => dir && existsSync(join(dir, 'libcrypt.so.1')));
if (process.env.USE_SYSTEM_FPM !== 'true' && !hasLibcrypt1) {
  throw new Error('libcrypt.so.1 is missing; electron-builder needs it to build the RPM. On Fedora: sudo dnf install libxcrypt-compat');
}

const nodeName = `node-${NODE_VERSION}-linux-${ARCH}`;
const nodeTar = `${nodeName}.tar.xz`;
await fetchPinned(`https://nodejs.org/dist/${NODE_VERSION}/${nodeTar}`, nodeTar, { sha256: NODE_TAR_SHA256 });

const output = resolve('.local/linux-runtime');
const work = mkdtempSync(join(tmpdir(), 'squiggly-linux-runtime-'));
try {
  execFileSync('tar', ['-xJf', join(downloads, nodeTar), '-C', work, `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  copyFileSync(join(work, nodeName, 'bin', 'node'), join(output, 'node'));
  chmodSync(join(output, 'node'), 0o755);
  copyFileSync(join(work, nodeName, 'LICENSE'), join(output, 'LICENSE.node.txt'));
  const versions = { node: NODE_VERSION, arch: ARCH, sha256: { node: digest('sha256', readFileSync(join(output, 'node'))) } };
  writeFileSync(join(output, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
  console.log(`Node ${NODE_VERSION} linux-${ARCH} extracted to ${output}:\n${JSON.stringify(versions, null, 2)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
