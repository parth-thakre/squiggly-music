import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { devServerCsp } from './scripts/dev-csp';
import { DIAGNOSTICS_MARKER, diagnosticsTarget } from './scripts/diagnostics-build';

// Packages unpack out/main from app.asar for the audio host, which runs under a separate
// Node that cannot read asar. The root package.json stays inside app.asar, so the unpacked
// ESM output needs its own module-type marker.
const moduleTypeMarker: Plugin = {
  name: 'squiggly-module-type-marker',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'package.json', source: '{ "type": "module" }\n' });
  },
};

// BETA BUILDS ONLY: remote diagnostics (apps/desktop/main/remoteDiagnostics.ts). Compiled into
// the main process only when both SQUIGGLY_DIAG_URL and SQUIGGLY_DIAG_TOKEN are set while
// building; the app never reads them at run time. Without them the constants are empty strings
// and the module does nothing. A stable version with either set fails here (diagnostics-build.ts).
function diagnosticsDefines() {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
  const found = diagnosticsTarget(process.env, version);
  if (!found) return { __SQUIGGLY_DIAG_URL__: '""', __SQUIGGLY_DIAG_TOKEN__: '""', __SQUIGGLY_DIAG_BUILD__: 'null' };
  const { url, token } = found;
  const target = new URL(url);
  const run = (command: string, args: string[]) => { try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  // The fuses electron-builder flips in the packaged executable, as configured for this build.
  const section = (readFileSync('electron-builder.yml', 'utf8').split(/^electronFuses:\s*$/m)[1] ?? '').split(/^\S/m)[0];
  const fuses = Object.fromEntries([...section.matchAll(/^ {2}(\w+):\s*(true|false)\s*$/gm)].map(([, name, value]) => [name, value === 'true']));
  const build = {
    marker: DIAGNOSTICS_MARKER, builtAt: new Date().toISOString(), commit: run('git', ['rev-parse', '--short', 'HEAD']),
    branch: run('git', ['rev-parse', '--abbrev-ref', 'HEAD']), dirty: Boolean(run('git', ['status', '--porcelain'])), fuses,
  };
  console.log(`Beta ${version} with diagnostics: events go to ${target.origin}${target.pathname}`);
  return { __SQUIGGLY_DIAG_URL__: JSON.stringify(url), __SQUIGGLY_DIAG_TOKEN__: JSON.stringify(token), __SQUIGGLY_DIAG_BUILD__: JSON.stringify(build) };
}

export default defineConfig({
  main: {
    define: diagnosticsDefines(),
    plugins: [externalizeDepsPlugin(), moduleTypeMarker],
    build: { rollupOptions: { input: {
      index: resolve('apps/desktop/main/index.ts'),
      player: resolve('packages/player-mpv/host.ts'),
    } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: {
      input: resolve('apps/desktop/preload/index.ts'),
      output: { format: 'cjs', entryFileNames: 'index.cjs' },
    } },
  },
  renderer: {
    root: 'apps/desktop/renderer',
    plugins: [react(), devServerCsp()],
    build: { minify: 'esbuild', rollupOptions: { input: resolve('apps/desktop/renderer/index.html') } },
  },
});
