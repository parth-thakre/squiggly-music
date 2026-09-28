// Builds the Windows x64 libmpv (audio-only, LGPL-2.1-or-later) in a container and writes
// it to .local/libmpv-windows with manifest.json and the corresponding-source bundle.
//
//   npm run libmpv:build                 # podman, or docker when podman is missing
//   npm run libmpv:build -- --force      # rebuild even when the output matches the recipe
//   SQUIGGLY_CONTAINER_ENGINE=docker npm run libmpv:build
//   npm run libmpv:build -- --out <dir>
//
// The sources are downloaded on the host and checked against sources.json, then the build
// runs with --network=none. Only Node's standard library is used, so CI can run this
// without npm ci.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { downloads, fetchPinned } from '../../scripts/fetch-common.mjs';
import { DLL, SOURCE_BUNDLE, readSources, recipeDir, recipeHash, verifyBuild } from './recipe.mjs';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const output = resolve(outIndex >= 0 ? args[outIndex + 1] : '.local/libmpv-windows');
const force = args.includes('--force');

const hash = recipeHash();
if (!force && existsSync(join(output, 'manifest.json'))) {
  try {
    verifyBuild(output);
    console.log(`${output} is already built from recipe ${hash}. Pass --force to rebuild.`);
    process.exit(0);
  } catch (error) {
    console.log(`Rebuilding: ${error.message}`);
  }
}

const engine = process.env.SQUIGGLY_CONTAINER_ENGINE
  ?? (['podman', 'docker'].find(name => spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0));
if (!engine) throw new Error('Needs podman or docker. Set SQUIGGLY_CONTAINER_ENGINE to choose one.');

const recipe = readSources();
for (const source of recipe.sources) await fetchPinned(source.url, source.file, { sha256: source.sha256 });

// Tag the toolchain image by its Containerfile, so a recipe change that leaves the
// toolchain alone reuses the image.
const containerfile = join(recipeDir, 'Containerfile');
const image = `localhost/squiggly-libmpv-build:${createHash('sha256').update(readFileSync(containerfile)).digest('hex').slice(0, 16)}`;
const run = (command, commandArgs) => {
  console.log(`$ ${command} ${commandArgs.join(' ')}`);
  execFileSync(command, commandArgs, { stdio: 'inherit' });
};
if (spawnSync(engine, ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0) {
  run(engine, ['build', '-t', image, '-f', containerfile, recipeDir]);
}

const partial = `${output}.partial`;
rmSync(partial, { recursive: true, force: true });
mkdirSync(partial, { recursive: true });
const started = Date.now();
run(engine, ['run', '--rm', '--network=none', '--security-opt', 'label=disable',
  ...(engine === 'docker' && process.getuid ? ['-e', `HOST_UID=${process.getuid()}`, '-e', `HOST_GID=${process.getgid()}`] : []),
  '-v', `${recipeDir}:/recipe:ro`, '-v', `${downloads}:/sources:ro`, '-v', `${partial}:/out`,
  image, 'bash', '/recipe/build.sh']);

const entry = file => {
  const data = readFileSync(join(partial, file));
  return { file, size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
};
const info = JSON.parse(readFileSync(join(partial, 'build-info.json'), 'utf8'));
const manifest = {
  recipeHash: hash,
  image: recipe.image,
  toolchainImage: execFileSync(engine, ['image', 'inspect', '--format', '{{.Id}}', image]).toString().trim(),
  dll: entry(DLL),
  sourceBundle: entry(SOURCE_BUNDLE),
  licenses: readdirSync(join(partial, 'licenses')).sort().map(file => entry(`licenses/${file}`)),
  sources: recipe.sources.map(({ name, version, url, sha256, commit, license }) => ({ name, version, url, sha256, commit, license })),
  ...info,
};
writeFileSync(join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
// The build is reproducible, so a different DLL means the toolchain or an input drifted.
if (manifest.dll.sha256 !== recipe.expectedDllSha256) {
  throw new Error(`The build produced ${DLL} with SHA-256 ${manifest.dll.sha256}, but sources.json expects ${recipe.expectedDllSha256}. `
    + `If you changed the build on purpose, set expectedDllSha256 to the new value. The output is in ${partial}.`);
}
rmSync(output, { recursive: true, force: true });
renameSync(partial, output);
verifyBuild(output);
const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`;
console.log(`Built ${join(output, DLL)} (${mb(manifest.dll.size)}, sha256 ${manifest.dll.sha256}) and ${SOURCE_BUNDLE} (${mb(manifest.sourceBundle.size)}) from recipe ${hash} in ${Math.round((Date.now() - started) / 1000)} s.`);
if (statSync(join(output, DLL)).size > 40 * 1048576) console.warn('The DLL is unexpectedly large for an audio-only build.');
