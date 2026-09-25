// electron-builder afterPack hook (see electron-builder.yml). It writes
// resources/licenses/npm-packages.txt with the license text of every production npm
// package in the app (read from resources/app.asar), then checks that each third-party notice the package must carry
// is present. Any missing notice, unreviewed license, or unlisted shipped package fails
// the build.
//
// It can also check an unpacked app directory by hand:
//   node scripts/release-notices.mjs dist/win-unpacked win32
//   node scripts/release-notices.mjs dist/linux-unpacked linux
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import asar from '@electron/asar';

// Licenses reviewed as compatible with redistribution in a closed or open app.
// Add to this list only after reviewing the new package's terms.
const REVIEWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'OFL-1.1', 'Zlib']);
// Packages the renderer bundle includes, excluded from resources/app/node_modules by electron-builder.yml.
const RENDERER_ONLY = new Set(['react', 'react-dom', 'scheduler', 'lucide-react']);
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

function packageDirs(root) {
  const found = [];
  const visit = modules => {
    if (!existsSync(modules)) return;
    for (const name of readdirSync(modules)) {
      if (name.startsWith('.')) continue;
      const path = join(modules, name);
      if (name.startsWith('@')) { visit(path); continue; }
      if (!existsSync(join(path, 'package.json'))) continue;
      found.push(path);
      visit(join(path, 'node_modules'));
    }
  };
  visit(join(root, 'node_modules'));
  return found;
}

function licenseText(dir, name) {
  const files = existsSync(dir) ? readdirSync(dir).filter(file => LICENSE_FILE.test(file) && statSync(join(dir, file)).isFile()).sort() : [];
  if (files.length) return files.map(file => readFileSync(join(dir, file), 'utf8').trim()).join('\n\n');
  // Koffi's and esbuild's per-platform binary packages carry no license file; the main
  // package's license covers them.
  if (name.startsWith('@koromix/koffi-')) return readFileSync(join('node_modules', 'koffi', 'LICENSE.txt'), 'utf8').trim();
  if (name.startsWith('@esbuild/')) return readFileSync(join('node_modules', 'esbuild', 'LICENSE.md'), 'utf8').trim();
  return null;
}

export function writeNotices(appDir, platform) {
  const resources = join(appDir, 'resources');
  // Packages ship the app in resources/app.asar. Inspect a temporary extraction of it
  // (extractAll also reads the app.asar.unpacked files).
  const archive = join(resources, 'app.asar');
  const extracted = existsSync(archive) ? mkdtempSync(join(tmpdir(), 'squiggly-notices-')) : null;
  try {
    if (extracted) asar.extractAll(archive, extracted);
    checkNotices(appDir, platform, resources, extracted ?? join(resources, 'app'), extracted ? 'resources/app.asar' : 'resources/app');
  } finally {
    if (extracted) rmSync(extracted, { recursive: true, force: true });
  }
}

function checkNotices(appDir, platform, resources, shippedRoot, shippedLabel) {
  const shipped = new Set(packageDirs(shippedRoot).map(dir => dir.slice(shippedRoot.length + 1).replaceAll('\\', '/')));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')).packages;

  const entries = [];
  const problems = [];
  const unlicensedText = [];
  for (const [key, meta] of Object.entries(lock)) {
    if (!key || meta.dev || meta.devOptional || meta.link) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    // Optional per-platform binaries ship only when electron-builder kept them.
    if (meta.optional && !shipped.has(key)) continue;
    const isShipped = shipped.has(key);
    if (!isShipped && !RENDERER_ONLY.has(name)) problems.push(`${key} is a production dependency but is not in ${shippedLabel}`);
    const dir = existsSync(key) ? key : join(shippedRoot, key);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const license = typeof manifest.license === 'string' ? manifest.license : meta.license;
    if (!REVIEWED.has(license)) problems.push(`${name}@${manifest.version} has an unreviewed license: ${license ?? 'none'}`);
    let text = licenseText(dir, name);
    if (!text) {
      unlicensedText.push(`${name}@${manifest.version}`);
      const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name;
      text = `The package includes no license file. Its package.json declares "${license}"${author ? ` and names ${author} as author` : ''}.`
        + (manifest.repository ? `\nSource: ${typeof manifest.repository === 'string' ? manifest.repository : manifest.repository.url}` : '');
    }
    entries.push({ name, version: manifest.version, license, where: isShipped ? `${shippedLabel}/${key}` : 'bundled into the renderer (out/renderer)', text });
  }
  for (const key of shipped) {
    if (!lock[key] || lock[key].dev) problems.push(`${key} ships in the app but is not a production dependency in package-lock.json`);
  }

  const required = ['LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources/runtime/LICENSE.node.txt', 'resources/licenses/THIRD-PARTY-NOTICES.md'];
  if (platform === 'win32') {
    // NOTICE.md and every component license of the LGPL libmpv build (build/libmpv).
    required.push('resources/runtime/libmpv-2.dll', ...readdirSync('licenses/libmpv-windows').map(file => `resources/licenses/libmpv-windows/${file}`));
  } else if (existsSync(join(resources, 'runtime', 'libmpv-2.dll')) || existsSync(join(resources, 'licenses', 'libmpv-windows'))) {
    problems.push('A non-Windows package includes the Windows libmpv build or its notices.');
  }
  for (const file of required) if (!existsSync(join(appDir, file))) problems.push(`Missing ${file}`);
  if (problems.length) throw new Error(`Third-party notice check failed:\n- ${problems.join('\n- ')}`);

  entries.sort((a, b) => a.name.localeCompare(b.name));
  const header = [
    'Squiggly Music: npm packages included in this app',
    '',
    'Each production npm package in this build, with its license text. Other notices are in',
    'THIRD-PARTY-NOTICES.md in this directory.',
    '',
    ...entries.map(entry => `- ${entry.name}@${entry.version} (${entry.license}), ${entry.where}`),
    '',
  ].join('\n');
  const body = entries.map(entry => `${'='.repeat(78)}\n${entry.name}@${entry.version} (${entry.license})\n${'='.repeat(78)}\n\n${entry.text}\n`).join('\n');
  mkdirSync(join(resources, 'licenses'), { recursive: true });
  writeFileSync(join(resources, 'licenses', 'npm-packages.txt'), `${header}\n${body}`);
  console.log(`Wrote notices for ${entries.length} npm packages to ${join(resources, 'licenses', 'npm-packages.txt')}`);
  if (unlicensedText.length) console.warn(`No license file shipped by: ${unlicensedText.join(', ')} (declared license recorded instead).`);
}

export default async function afterPack(context) {
  if (context.electronPlatformName === 'darwin') throw new Error('Notice checks do not support macOS bundles yet.');
  writeNotices(context.appOutDir, context.electronPlatformName);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [appDir, platform] = process.argv.slice(2);
  if (!appDir || !['win32', 'linux'].includes(platform)) throw new Error('Usage: node scripts/release-notices.mjs <unpacked app dir> <win32|linux>');
  writeNotices(resolve(appDir), platform);
}
