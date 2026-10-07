import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const lock = JSON.parse(read('package-lock.json')).packages as Record<string, { version: string; integrity: string }>;
const fetchMac = read('scripts/fetch-macos-runtime.mjs');
const nodeVersion = (script: string) => /const NODE_VERSION = '(v[\d.]+)'/.exec(script)?.[1];

describe('the macOS runtime pins', () => {
  // The darwin binaries are optional packages that npm skips on other hosts, so the script fetches them by
  // the digest it carries. A dependency bump that leaves these behind would fail at package time.
  it.each(['@koromix/koffi-darwin-arm64', '@koromix/koffi-darwin-x64', '@esbuild/darwin-arm64', '@esbuild/darwin-x64'])('%s matches the lockfile', name => {
    const entry = lock[`node_modules/${name}`];
    expect(entry, `${name} is not in package-lock.json`).toBeDefined();
    expect(fetchMac).toContain(entry.integrity.replace(/^sha512-/, ''));
    expect(fetchMac).toContain(entry.version);
  });
  it('uses the same Node as the Windows and Linux builds', () => {
    const version = nodeVersion(fetchMac);
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(nodeVersion(read('scripts/fetch-linux-runtime.mjs'))).toBe(version);
    expect(nodeVersion(read('scripts/fetch-windows-runtime.mjs'))).toBe(version);
  });
  it('pins a SHA-256 for each Node archive', () => {
    expect([...fetchMac.matchAll(/nodeSha256: '([0-9a-f]{64})'/g)]).toHaveLength(2);
  });
});

describe('electron-builder.yml for macOS', () => {
  const config = read('electron-builder.yml');
  const mac = config.slice(config.indexOf('\nmac:\n'), config.indexOf('\nrpm:\n'));
  // Without these two, the mapped darwin binaries stay inside app.asar, where the audio host cannot load them.
  it('unpacks the mapped Koffi and esbuild binaries', () => {
    expect(config).toContain("'**/koffi-darwin-*/**'");
    expect(config).toContain("'**/esbuild-darwin-*/**'");
  });
  it('builds unsigned dmg and zip packages for both CPUs, named for the release', () => {
    expect(mac).toContain('identity: null');
    expect(mac).toMatch(/target: dmg\n\s+arch: \[arm64, x64\]/);
    expect(mac).toMatch(/target: zip\n\s+arch: \[arm64, x64\]/);
    expect(mac).toContain('artifactName: Squiggly-Music-${version}-macos-${arch}.${ext}');
  });
  it('takes each CPU\'s own runtime, Koffi, and esbuild', () => {
    expect(mac).toContain('from: .local/macos-runtime/${arch}/koffi-darwin-${arch}');
    expect(mac).toContain('to: node_modules/@esbuild/darwin-${arch}');
    expect(mac).toContain('from: .local/macos-runtime/${arch}\n      to: runtime');
  });
});
