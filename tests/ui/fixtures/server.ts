import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { preview } from 'vite';
import { navidromePreview } from '../../../scripts/navidrome-preview';
import { FakeNavidrome, trackOf } from './library';
import { serveNavidrome } from './native';
import { toneWav } from './media';

export const webPassword = 'squiggly test password';
const root = resolve(import.meta.dirname, '../../..');
const outDir = resolve(root, 'out/web');

// The upstream "Navidrome" the preview plugin streams from: WAV bytes for a track id, honouring
// Range the way Navidrome does so seeking works in the browser. The track listing's routes are
// answered first (native.ts).
async function audioServer(navidrome: (request: IncomingMessage, response: ServerResponse) => boolean) {
  const server: Server = createServer((request, response) => {
    if (navidrome(request, response)) return;
    const url = new URL(request.url ?? '/', 'http://audio');
    const id = url.searchParams.get('id') ?? '';
    const track = /^tr-\d+-\d+$/.test(id) ? trackOf(id) : undefined;
    if (!track) { response.writeHead(200, { 'content-type': 'application/json' }); return void response.end('{"subsonic-response":{"status":"failed"}}'); }
    const wav = toneWav(track.duration ?? 10, 220 + (id.length * 37) % 400);
    response.setHeader('content-type', 'audio/wav');
    response.setHeader('accept-ranges', 'bytes');
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    if (!range) { response.setHeader('content-length', String(wav.length)); return void response.end(request.method === 'HEAD' ? undefined : wav); }
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : wav.length - 1, wav.length - 1);
    if (start >= wav.length || start > end) { response.writeHead(416, { 'content-range': `bytes */${wav.length}` }); return void response.end(); }
    response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${wav.length}`, 'content-length': String(end - start + 1) });
    response.end(request.method === 'HEAD' ? undefined : wav.subarray(start, end + 1));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => { server.closeAllConnections(); return new Promise<void>(done => server.close(() => done())); } };
}

// The browser build (out/web) served by Vite's real preview server with the real
// navidrome-preview plugin, backed by the fake account. One per Playwright worker.
export async function startPreview() {
  if (!existsSync(resolve(outDir, 'index.html'))) throw new Error('out/web is missing. Run `npx vite build` (or `npm run test:ui`) first.');
  // The fake needs the server's address, and the server the fake.
  let fake: FakeNavidrome | undefined;
  const audio = await audioServer((request, response) => serveNavidrome(fake!, request, response));
  fake = new FakeNavidrome(() => audio.url);
  const server = await preview({
    configFile: false, root: resolve(root, 'apps/desktop/renderer'), logLevel: 'warn',
    build: { outDir },
    plugins: [navidromePreview({ env: { SQUIGGLY_WEB_PASSWORD: webPassword }, client: fake.subsonic, now: () => fake.clock.now })],
    preview: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('The preview server has no address.');
  return {
    url: `http://127.0.0.1:${address.port}`, fake,
    async close() { await server.close(); await audio.close(); },
  };
}
