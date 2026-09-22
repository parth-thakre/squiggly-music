import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
