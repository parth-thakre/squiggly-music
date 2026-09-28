import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { androidNotices } from './scripts/android-notices';
import { navidromePreview } from './scripts/navidrome-preview';

// The Android app's page (`vite build --mode android`, see docs/android.md): the same renderer
// with apps/android/web/main.ts as its entry, which installs window.squigglyAndroid first.
// Capacitor copies out/android-web into the APK.
const androidEntry: Plugin = {
  name: 'squiggly-android-entry',
  // 'pre', so the swap happens before Vite collects the page's scripts.
  transformIndexHtml: { order: 'pre', handler: html => html.replace('src="/src/main.tsx"', 'src="../../android/web/main.ts"') },
};

// The browser build talks to the library through scripts/navidrome-preview.ts. Both servers
// listen on 127.0.0.1 unless `--host` says otherwise; see that file before exposing them.
const allowedHosts = [hostname(), ...(process.env.SQUIGGLY_PREVIEW_HOST ? [process.env.SQUIGGLY_PREVIEW_HOST] : [])];
export default defineConfig(({ mode }) => mode === 'android' ? {
  root: 'apps/desktop/renderer', plugins: [react(), androidEntry, androidNotices()],
  build: { outDir: resolve('out/android-web'), emptyOutDir: true },
} : {
  root: 'apps/desktop/renderer', plugins: [react(), navidromePreview()],
  build: { outDir: resolve('out/web'), emptyOutDir: true },
  preview: { host: '127.0.0.1', allowedHosts },
  server: { host: '127.0.0.1', allowedHosts },
});
