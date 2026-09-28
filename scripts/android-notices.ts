import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

// The Android app's page lists the npm packages its bundle contains, with their licence texts,
// in licenses/npm-packages.txt. The packages are whatever Rollup put in the bundle, so the list
// can't drift from the code. @capacitor/android ships as native code and is added by name.
// Licences outside the reviewed set fail the build (as scripts/release-notices.mjs does).
const REVIEWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'OFL-1.1']);
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;
const NATIVE = ['@capacitor/android'];

export function androidNotices(): Plugin {
  return {
    name: 'squiggly-android-notices',
    apply: 'build',
    generateBundle(_options, bundle) {
      const packages = new Set(NATIVE);
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          const name = packageOf(id);
          if (name) packages.add(name);
        }
      }
      // Fonts arrive as CSS and files, not modules.
      for (const asset of Object.values(bundle)) if (asset.type === 'asset' && /familjen-grotesk|young-serif/.test(asset.fileName)) {
        packages.add(asset.fileName.includes('young-serif') ? '@fontsource/young-serif' : '@fontsource-variable/familjen-grotesk');
      }
      const sections = [...packages].sort().map(name => {
        const dir = resolve('node_modules', name);
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string; license?: string };
        if (!manifest.license || !REVIEWED.has(manifest.license)) this.error(`Review ${name}'s licence (${manifest.license ?? 'none'}) before it ships in the Android app.`);
        const files = readdirSync(dir).filter(file => LICENSE_FILE.test(file) && statSync(join(dir, file)).isFile()).sort();
        if (!files.length) this.error(`${name} has no licence file to ship.`);
        const text = files.map(file => readFileSync(join(dir, file), 'utf8').trim()).join('\n\n');
        return `${name} ${manifest.version} (${manifest.license})\n\n${text}`;
      });
      this.emitFile({
        type: 'asset', fileName: 'licenses/npm-packages.txt',
        source: `npm packages in Squiggly's Android app, with their licences.\n\n${sections.join(`\n\n${'-'.repeat(72)}\n\n`)}\n`,
      });
    },
  };
}

// The package a bundled module came from: the last node_modules/<name> or node_modules/@scope/<name> in its path.
function packageOf(id: string): string | null {
  const path = id.replace(/^\0/, '').split('?')[0];
  const marker = `${sep}node_modules${sep}`;
  const at = path.lastIndexOf(marker);
  if (at < 0) return null;
  const parts = path.slice(at + marker.length).split(sep);
  const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  return existsSync(resolve('node_modules', name, 'package.json')) ? name : null;
}
