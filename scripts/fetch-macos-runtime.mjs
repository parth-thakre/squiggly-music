// Assembles the macOS audio-host runtime in .local/macos-runtime/<arch> for packaging, for
// arm64 and x64. The Electron utility process cannot host libmpv (see docs/packaging.md), so a
// release ships its own Node executable. libmpv is not bundled on macOS: the audio host loads
// the user's Homebrew (or MacPorts) copy, `brew install mpv`. Koffi's and esbuild's darwin
// binaries are optional npm packages that npm skips on other hosts, so they are fetched here.
//
// Every download is verified against a digest pinned below, never against live metadata.
// Archives are cached in .local/downloads and rehashed on every run; each arch's runtime
// directory is rebuilt from the verified archives.
//
// How the pins were checked (2026-09-30). Repeat this when bumping a version:
// - Node: each SHA-256 matches its line in https://nodejs.org/dist/<version>/SHASUMS256.txt.asc,
//   whose clearsigned signature verifies with gpg against the nodejs/release-keys keyring
//   (gpg-only-active-keys/pubring.kbx). v22.23.3 is signed by 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356
//   (Antoine du Hamel), which is listed in nodejs/release-keys keys.list. The tarballs were hashed locally.
// - Koffi and esbuild: each sha512 integrity matches package-lock.json and a local hash of the
//   tarball; the registry's ECDSA signature over "<package>@<version>:<integrity>" verifies with
//   npm's published key SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U. The script checks the
//   lockfile again on every run.
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { digest, downloads, fetchPinned } from './fetch-common.mjs';

const NODE_VERSION = 'v22.23.3';
const KOFFI_VERSION = '3.3.1';
const ESBUILD_VERSION = '0.25.12';
// Mach-O cputype: CPU_TYPE_ARM64 and CPU_TYPE_X86_64, read from the header of every binary below.
const ARCHES = {
  arm64: {
    cpu: 0x0100000c,
    nodeSha256: '72d5d8832b41c9d9646197af614ffd751406ea4d215060eb91b98864e1919a3e',
    koffiSha512: 'xVLQMZzACn6TQJsGp/mBF71mfRyuhmxTBGcQLfJM59YArNN/9+1JV8FFCElmgspffijASZsLwbSEdPwZMNeDhQ==',
    esbuildSha512: 'N3zl+lxHCifgIlcMUP5016ESkeQjLj/959RxxNYIthIg+CQHInujFuXeWbWMgnTo4cp5XVHqFPmpyu9J65C1Yg==',
  },
  x64: {
    cpu: 0x01000007,
    nodeSha256: 'ac41874c3352937119cfec39e1a98c578fe58ce8a86d7e785b89a4706015f305',
    koffiSha512: '+VGqqnBQvR+AbAbRyRDsxK0D6wwAivUURWsyVX8NhR5agf+0+sSAdNMsSy+9DyO7CmioTUVwV+Do+12uWnFrmA==',
    esbuildSha512: 'HQ9ka4Kx21qHXwtlTUVbKJOAnmG1ipXhdWTmNXiPzPfWKpXqASVcWdnf2bnL73wgjNrFXAa3yYvBSd9pzfEIpA==',
  },
};

// Both CPUs by default; `--arch arm64` or `--arch x64` fetches one.
const flag = process.argv.indexOf('--arch');
const only = flag === -1 ? null : process.argv[flag + 1];
if (only !== null && !ARCHES[only]) throw new Error('Usage: node scripts/fetch-macos-runtime.mjs [--arch arm64|x64]');
const wanted = only ? [only] : Object.keys(ARCHES);

// Each darwin binary must match the JavaScript that npm installed from the lockfile.
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages;
for (const arch of wanted) {
  const pins = ARCHES[arch];
  for (const [js, binary, version, sha512] of [
    ['koffi', `@koromix/koffi-darwin-${arch}`, KOFFI_VERSION, pins.koffiSha512],
    ['esbuild', `@esbuild/darwin-${arch}`, ESBUILD_VERSION, pins.esbuildSha512],
  ]) {
    const installed = JSON.parse(readFileSync(`node_modules/${js}/package.json`, 'utf8')).version;
    const locked = lock[`node_modules/${binary}`];
    if (installed !== version || locked?.version !== version || locked?.integrity !== `sha512-${sha512}`) {
      throw new Error(`${js} changed (installed ${installed}, locked ${binary} ${locked?.version}). Update its version and SHA-512 in ${import.meta.filename}.`);
    }
  }
}

// A thin 64-bit Mach-O for the arch it is meant for. Nothing here can run a darwin binary, so this
// is the check that a package did not get another arch's Node or Koffi.
function assertMachO(file, arch) {
  const header = Buffer.alloc(8);
  const fd = openSync(file, 'r');
  try { readSync(fd, header, 0, 8, 0); } finally { closeSync(fd); }
  if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== ARCHES[arch].cpu) {
    throw new Error(`${file} is not a 64-bit ${arch} Mach-O binary.`);
  }
}

// bsdtar (macOS, Windows) and GNU tar (Linux) both read .tar.xz and .tgz.
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

for (const arch of wanted) {
  const pins = ARCHES[arch];
  const nodeName = `node-${NODE_VERSION}-darwin-${arch}`;
  const nodeTar = `${nodeName}.tar.xz`;
  const koffiTgz = `koffi-darwin-${arch}-${KOFFI_VERSION}.tgz`;
  const esbuildTgz = `esbuild-darwin-${arch}-${ESBUILD_VERSION}.tgz`;
  await fetchPinned(`https://nodejs.org/dist/${NODE_VERSION}/${nodeTar}`, nodeTar, { sha256: pins.nodeSha256 });
  await fetchPinned(`https://registry.npmjs.org/@koromix/koffi-darwin-${arch}/-/${koffiTgz}`, koffiTgz, { sha512: pins.koffiSha512 });
  await fetchPinned(`https://registry.npmjs.org/@esbuild/darwin-${arch}/-/darwin-${arch}-${ESBUILD_VERSION}.tgz`, esbuildTgz, { sha512: pins.esbuildSha512 });

  const output = resolve('.local/macos-runtime', arch);
  const work = mkdtempSync(join(tmpdir(), `squiggly-macos-runtime-${arch}-`));
  try {
    execFileSync(TAR, ['-xJf', join(downloads, nodeTar), '-C', work, `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    copyFileSync(join(work, nodeName, 'bin', 'node'), join(output, 'node'));
    chmodSync(join(output, 'node'), 0o755);
    copyFileSync(join(work, nodeName, 'LICENSE'), join(output, 'LICENSE.node.txt'));
    for (const [dir, tgz] of [[`koffi-darwin-${arch}`, koffiTgz], [`esbuild-darwin-${arch}`, esbuildTgz]]) {
      mkdirSync(join(output, dir));
      execFileSync(TAR, ['-xzf', join(downloads, tgz), '-C', join(output, dir), '--strip-components=1']);
    }
    chmodSync(join(output, `esbuild-darwin-${arch}`, 'bin', 'esbuild'), 0o755);
    assertMachO(join(output, 'node'), arch);
    assertMachO(join(output, `koffi-darwin-${arch}`, `darwin_${arch}`, 'koffi.node'), arch);
    assertMachO(join(output, `esbuild-darwin-${arch}`, 'bin', 'esbuild'), arch);
    const versions = { node: NODE_VERSION, arch, koffi: KOFFI_VERSION, esbuild: ESBUILD_VERSION,
      sha256: { node: digest('sha256', readFileSync(join(output, 'node'))) } };
    writeFileSync(join(output, 'versions.json'), `${JSON.stringify(versions, null, 2)}\n`);
    console.log(`macOS ${arch} runtime extracted to ${output}:\n${JSON.stringify(versions, null, 2)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
