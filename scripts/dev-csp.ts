import type { Plugin } from 'vite';

// The page's Content-Security-Policy (apps/desktop/renderer/index.html) allows no local
// WebSockets. Vite's dev server reloads the page over one, so only the dev server adds them;
// built pages keep the policy as written.
export function devServerCsp(): Plugin {
  return {
    name: 'squiggly-dev-server-csp',
    apply: 'serve',
    transformIndexHtml: html => html.replace(/connect-src [^;"]*/, sources => `${sources} ws://localhost:* ws://127.0.0.1:*`),
  };
}
