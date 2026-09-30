import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { preview } from 'vite';
import { navidromePreview, publicAddress } from '../../../scripts/navidrome-preview';
import { FakeNavidrome, trackOf } from './library';
import { serveNavidrome } from './native';
import { liveWavHeader, toneWav } from './media';

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
    const station = /^\/radio\/(st-\d+)$/.exec(url.pathname)?.[1];
    if (station) return void live(station, request, response);
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

// An internet radio station: a WAV stream that never ends, a second of tone looped (330 whole
// cycles, so the joins are seamless), sent about as fast as it plays until the listener goes.
// Chunked, with no length, as a live stream is.
let hearing: ((id: string) => void) | undefined;
function live(id: string, request: IncomingMessage, response: ServerResponse) {
  hearing?.(id);
  response.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-cache' });
  if (request.method === 'HEAD') return void response.end();
  const second = toneWav(1, 330).subarray(44);
  // A burst first, as a station's server sends from its buffer: Chrome doesn't open a stream
  // until it holds about 256 KB, sixteen seconds of this. Then one second a second.
  response.write(liveWavHeader());
  for (let i = 0; i < 16; i++) response.write(second);
  const timer = setInterval(() => { if (!response.destroyed) response.write(second); }, 1000);
  response.on('close', () => clearInterval(timer));
}

// The browser build (out/web) served by Vite's real preview server with the real
// navidrome-preview plugin, backed by the fake account. One per Playwright worker.
export async function startPreview() {
  if (!existsSync(resolve(outDir, 'index.html'))) throw new Error('out/web is missing. Run `npx vite build` (or `npm run test:ui`) first.');
  // The fake needs the server's address, and the server the fake.
  let fake: FakeNavidrome | undefined;
  const audio = await audioServer((request, response) => serveNavidrome(fake!, request, response));
  fake = new FakeNavidrome(() => audio.url);
  hearing = id => fake!.stationStreams.push(id);
  // The stations stream from this machine (audioServer, on 127.0.0.1), which the relay refuses
  // unless told otherwise; every other address is checked as usual.
  const stationAddress = (address: string) => address === '127.0.0.1' || publicAddress(address);
  const server = await preview({
    configFile: false, root: resolve(root, 'apps/desktop/renderer'), logLevel: 'warn',
    build: { outDir },
    plugins: [navidromePreview({ env: { SQUIGGLY_WEB_PASSWORD: webPassword }, client: fake.subsonic, now: () => fake.clock.now, stationAddress })],
    preview: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('The preview server has no address.');
  return {
    url: `http://127.0.0.1:${address.port}`, fake,
    async close() { await server.close(); await audio.close(); },
  };
}
