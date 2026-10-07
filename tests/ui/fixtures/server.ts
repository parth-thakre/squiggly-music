import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { preview } from 'vite';
import { SubsonicClient } from '../../../packages/adapter-opensubsonic/client';
import type { Connection } from '../../../packages/core/contracts';
import { Metrics } from '../../../packages/core/metrics';
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
// While `down()` says the server is unreachable, every connection is dropped unanswered.
async function audioServer(navidrome: (request: IncomingMessage, response: ServerResponse) => boolean, hearing: (id: string) => void,
  down: () => boolean = () => false, streamed: (id: string) => void = () => {}) {
  const server: Server = createServer((request, response) => {
    if (down()) return void request.socket.destroy();
    if (navidrome(request, response)) return;
    const url = new URL(request.url ?? '/', 'http://audio');
    const station = /^\/radio\/(st-\d+)$/.exec(url.pathname)?.[1];
    if (station) { hearing(station); return void live(request, response); }
    const id = url.searchParams.get('id') ?? '';
    if (url.pathname.endsWith('/stream.view') && id) streamed(id);
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
function live(request: IncomingMessage, response: ServerResponse) {
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

// A page connecting to the fake (the unconfigured host): the real connector finds the address
// (HTTPS, then HTTP) and checks the login against the fixture server's ping (native.ts); once it
// has, everything else is the fake account, as with the configured host.
function fakeConnector(fake: FakeNavidrome) {
  return (connection: Connection) => {
    const real = new SubsonicClient(connection, new Metrics());
    return new Proxy(fake.subsonic, {
      get: (target, key) => key === 'probe' || key === 'ping' ? real[key].bind(real) : key === 'baseUrl' ? real.baseUrl : Reflect.get(target, key),
    });
  };
}

// The browser build (out/web) served by Vite's real preview server with the real
// navidrome-preview plugin, backed by the fake account. One per Playwright worker.
// Configured, the host has the fake account from the start and a password for the page, as when
// started with SQUIGGLY_PREVIEW_NAVIDROME_* and SQUIGGLY_WEB_PASSWORD; a page may still connect
// to the fake's address as another server. Unconfigured, it has neither, and the page connects
// to the fake's address itself.
export async function startPreview({ configured = true }: { configured?: boolean } = {}) {
  if (!existsSync(resolve(outDir, 'index.html'))) throw new Error('out/web is missing. Run `npx vite build` (or `npm run test:ui`) first.');
  // The fake needs the server's address, and the server the fake.
  let fake: FakeNavidrome | undefined;
  const audio = await audioServer((request, response) => serveNavidrome(fake!, request, response), id => fake!.stationStreams.push(id),
    () => fake?.unreachable === true, id => fake!.streamed.push(id));
  fake = new FakeNavidrome(() => audio.url);
  // The stations stream from this machine (audioServer, on 127.0.0.1), which the relay refuses
  // unless told otherwise; every other address is checked as usual.
  const stationAddress = (address: string) => address === '127.0.0.1' || publicAddress(address);
  const server = await preview({
    configFile: false, root: resolve(root, 'apps/desktop/renderer'), logLevel: 'warn',
    build: { outDir },
    plugins: [configured
      ? navidromePreview({ env: { SQUIGGLY_WEB_PASSWORD: webPassword }, client: fake.subsonic, connector: fakeConnector(fake), now: () => fake.clock.now, stationAddress })
      : navidromePreview({ env: {}, client: null, connector: fakeConnector(fake), now: () => fake.clock.now, stationAddress })],
    preview: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('The preview server has no address.');
  return {
    url: `http://127.0.0.1:${address.port}`, fake,
    /** The fake server's address without its scheme, as someone would type it. */
    navidrome: audio.url.replace(/^http:\/\//, ''),
    async close() { await server.close(); await audio.close(); },
  };
}
