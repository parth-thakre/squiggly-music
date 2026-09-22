import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { hostname } from 'node:os';

// Browser preview deliberately has no playback or credential bridge.
export default defineConfig({
  root: 'apps/desktop/renderer', plugins: [react()],
  server: { allowedHosts: [hostname(), ...(process.env.SQUIGGLY_PREVIEW_HOST ? [process.env.SQUIGGLY_PREVIEW_HOST] : [])] },
});
