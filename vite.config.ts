import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { navidromePreview } from './scripts/navidrome-preview';

// The browser build talks to the library through scripts/navidrome-preview.ts. Both servers
// listen on 127.0.0.1 unless `--host` says otherwise; see that file before exposing them.
const allowedHosts = [hostname(), ...(process.env.SQUIGGLY_PREVIEW_HOST ? [process.env.SQUIGGLY_PREVIEW_HOST] : [])];
export default defineConfig({
  root: 'apps/desktop/renderer', plugins: [react(), navidromePreview()],
  build: { outDir: resolve('out/web'), emptyOutDir: true },
  preview: { host: '127.0.0.1', allowedHosts },
  server: { host: '127.0.0.1', allowedHosts },
});
