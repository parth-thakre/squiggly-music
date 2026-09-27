import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { type PreviewOptions, navidromePreview } from '../scripts/navidrome-preview';

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export const webPassword = 'correct horse battery staple';

// Runs the real plugin middleware on 127.0.0.1 the way Vite's preview server mounts it.
// An `x-test-peer` request header stands in for a connection from another address.
export async function previewServer(options: PreviewOptions, host: string | boolean | undefined = '127.0.0.1') {
  const routes = new Map<string, Handler>();
  const errors: string[] = [];
  const plugin = navidromePreview(options);
  (plugin.configurePreviewServer as (server: unknown) => void)({
    middlewares: { use: (path: string, handler: Handler) => routes.set(path, handler) },
    config: { preview: { host }, logger: { error: (message: string) => errors.push(message) } },
  });
  const peers = new WeakMap<Socket, string | undefined>();
  const server = createServer((request, response) => {
    const socket = request.socket;
    if (!peers.has(socket)) peers.set(socket, socket.remoteAddress);
    const peer = request.headers['x-test-peer'];
    Object.defineProperty(socket, 'remoteAddress', { value: typeof peer === 'string' ? peer : peers.get(socket), configurable: true });
    // Connect strips the mount path before calling the handler.
    const mount = [...routes.keys()].find(path => request.url!.startsWith(`${path}/`) || request.url!.startsWith(`${path}?`));
    if (!mount) return void response.writeHead(404).end();
    request.url = request.url!.slice(mount.length);
    void routes.get(mount)!(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing preview address');
  const url = `http://127.0.0.1:${address.port}`;
  const origin = { origin: url };
  return {
    url, routes, errors,
    fetch: (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, init),
    // A same-origin browser POST, optionally with a session cookie.
    post: (path: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) => fetch(`${url}${path}`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...origin, ...(cookie ? { cookie } : {}), ...headers },
    }),
    async signIn(password = webPassword, headers: Record<string, string> = {}) {
      const response = await fetch(`${url}/api/session`, { method: 'POST', body: JSON.stringify({ password }), headers: { 'content-type': 'application/json', ...origin, ...headers } });
      const setCookie = response.headers.get('set-cookie') ?? '';
      return { response, body: await response.json() as unknown, setCookie, cookie: setCookie.split(';')[0] };
    },
    close: () => { server.closeAllConnections(); return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
