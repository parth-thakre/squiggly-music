import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

// Packages unpack out/main from app.asar for the audio host, which runs under a separate
// Node that cannot read asar. The root package.json stays inside app.asar, so the unpacked
// ESM output needs its own module-type marker.
const moduleTypeMarker: Plugin = {
  name: 'squiggly-module-type-marker',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'package.json', source: '{ "type": "module" }\n' });
  },
};

export default defineConfig({
  main: {
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
    plugins: [react()],
    build: { minify: 'esbuild', rollupOptions: { input: resolve('apps/desktop/renderer/index.html') } },
  },
});
