import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { TLSSocket } from 'node:tls';
import { Effect, Either, Schema } from 'effect';
import type { Connect, Plugin } from 'vite';
import { SubsonicClient, isLibraryMethod, libraryCall } from '../packages/adapter-opensubsonic/client';
import { Metrics } from '../packages/core/metrics';
import { IdSchema } from '../packages/core/validation';

// Dev/preview-server bridge so the browser build can browse and play a real library through
// the same OpenSubsonic connector as the desktop app. Credentials come from the environment
// and never reach the browser or the repo:
//   SQUIGGLY_PREVIEW_NAVIDROME_URL, SQUIGGLY_PREVIEW_NAVIDROME_USER, SQUIGGLY_PREVIEW_NAVIDROME_PASSWORD
//   SQUIGGLY_WEB_PASSWORD   the password the browser signs in with (12 or more characters)
//
// Whoever reaches /api acts as the configured Navidrome account, so every /api route needs a
// session cookie once SQUIGGLY_WEB_PASSWORD is set:
//   GET    /api/session  -> { ok: true, value: { signedIn, required } }
//   POST   /api/session  body: { "password": "..." } -> { ok: true } and an HttpOnly, SameSite=Strict
//                        session cookie (30 days, sliding), or 401/429 { ok: false, error }
//   DELETE /api/session  -> { ok: true }; forgets the session and clears the cookie
// Without a session every other route answers 401 { ok: false, error: 'Sign in to use this library.' }.
// Sessions live in memory: restarting the server signs everyone out.
//
// Binding. `npm run web` and `npm run preview` listen on 127.0.0.1 only. Without
// SQUIGGLY_WEB_PASSWORD the library is open to this computer alone: /api refuses requests that
// arrive through a reverse proxy, and if the server is bound to any other address it refuses
// /api entirely and says so at startup. A password shorter than 12 characters is refused everywhere.
//
// Using it from a phone on your tailnet (set SQUIGGLY_WEB_PASSWORD first):
//   a) HTTPS through Tailscale (recommended; the cookie is marked Secure):
//        npm run web
//        tailscale serve --bg 5173
//        SQUIGGLY_PREVIEW_HOST=<machine>.<tailnet>.ts.net so Vite accepts that Host header
//      then open https://<machine>.<tailnet>.ts.net/
//   b) Plain HTTP on the tailnet address (traffic is still encrypted by WireGuard):
//        npm run web -- --host <tailnet ip, e.g. 100.x.y.z>
//      then open http://100.x.y.z:5173/
// Never bind 0.0.0.0 on an untrusted network; the sign-in page is the only thing in the way.
//
// Proxy trust. X-Forwarded-Proto, X-Forwarded-Host and X-Forwarded-For are believed only when
// the TCP peer is a loopback address, which is where `tailscale serve` connects from. From any
// other peer they are ignored, so the cookie is Secure only for a real TLS socket and sign-in
// attempts are counted per peer address. A local process can forge them; it could equally read
// the environment, so that is outside this boundary.
//
// POST /api/<LibraryApi method>  body: JSON array of positional arguments
//   -> { ok: true, value } | { ok: false, error }   (200, or 400/401/403/404/405/502/503)
// GET  /api/cover?id=<coverArt>&size=<32..1200>  -> image bytes, or 404 with a Result
// GET  /api/stream?id=<song>[&format=mp3]         -> audio bytes (Range supported), or 404 with a Result
// Audio and image elements load cover and stream same-origin, so the cookie rides along.
// Writes (playlist edits, reportPlay, saveQueue) reach the configured account. `lyrics` contacts
// LRCLIB only when the browser passes lookup=true as its second argument.
const unconfigured = 'Navidrome preview is not configured.';
const signInRequired = 'Sign in to use this library.';
const minimumPasswordLength = 12;
const cookieName = 'squiggly_session';
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const maxSessions = 1000;
// Sign-in backoff per client address: after `freeAttempts` wrong passwords each further one
// doubles the wait, up to `maxBackoff`. An address is forgotten an hour after its last failure.
const freeAttempts = 4;
const maxBackoff = 15 * 60 * 1000;
const failureMemory = 60 * 60 * 1000;
const maxTrackedAddresses = 10_000;

export interface PreviewOptions {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Tests substitute a connector; by default one is built from the environment. */
  client?: SubsonicClient | null;
  now?: () => number;
}

function createClient(env: NodeJS.ProcessEnv) {
  const url = env.SQUIGGLY_PREVIEW_NAVIDROME_URL;
  const username = env.SQUIGGLY_PREVIEW_NAVIDROME_USER;
  const password = env.SQUIGGLY_PREVIEW_NAVIDROME_PASSWORD;
  if (!url || !username || !password) return null;
  try { return new SubsonicClient({ url, username, password }, new Metrics()); }
  catch { return null; }
}
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.statusCode = status; response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
};
const digest = (value: string) => createHash('sha256').update(value).digest();
const header = (request: IncomingMessage, name: string) => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export function isLoopbackAddress(address: string | undefined) {
  if (!address) return false;
  const plain = address.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  return plain === '::1' || (isIP(plain) === 4 && plain.startsWith('127.'));
}
// Vite's `host`: undefined or false means localhost, true means every interface.
export function isLoopbackHost(host: string | boolean | undefined) {
  if (host === undefined || host === false) return true;
  return typeof host === 'string' && (host === 'localhost' || isLoopbackAddress(host));
}

// Only a proxy on this machine (such as `tailscale serve`) may describe the original request.
const fromTrustedProxy = (request: IncomingMessage) => isLoopbackAddress(request.socket.remoteAddress);
const proxied = (request: IncomingMessage) => ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].some(name => name in request.headers);
function secure(request: IncomingMessage) {
  if ((request.socket as TLSSocket).encrypted) return true;
  return fromTrustedProxy(request) && header(request, 'x-forwarded-proto')?.split(',')[0].trim().toLowerCase() === 'https';
}
function clientAddress(request: IncomingMessage) {
  const peer = request.socket.remoteAddress ?? 'unknown';
  const forwarded = fromTrustedProxy(request) ? header(request, 'x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
  return forwarded ? `via ${forwarded}` : peer;
}

// Writes need proof they came from this page: a matching Origin, or, when a browser omits it,
// Sec-Fetch-Site: same-origin. The SameSite=Strict session cookie remains the main defense.
function sameOrigin(request: IncomingMessage) {
  const site = header(request, 'sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const origin = header(request, 'origin');
  if (!origin) return site === 'same-origin';
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  const forwardedHost = fromTrustedProxy(request) ? header(request, 'x-forwarded-host')?.split(',')[0].trim() : undefined;
  return host === request.headers.host || (!!forwardedHost && host === forwardedHost);
}
const jsonRequest = (request: IncomingMessage) => !!request.headers['content-type']?.startsWith('application/json');

async function readBody(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) throw new Error('Request body is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createAuth(password: string, now: () => number) {
  const secret = digest(password);
  // Keyed by a hash of the token, so the map never holds a usable cookie value.
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; last: number; until: number }>();
  const tokens = (request: IncomingMessage) => (request.headers.cookie ?? '').split(';')
    .map(part => part.trim().split('='))
    .filter(([name, value]) => name === cookieName && !!value && /^[\w-]{43}$/.test(value))
    .map(([, value]) => value);
  const cookie = (request: IncomingMessage, value: string, maxAge: number) =>
    `${cookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure(request) ? '; Secure' : ''}`;
  const prune = () => {
    const time = now();
    for (const [key, expires] of sessions) if (expires <= time) sessions.delete(key);
    for (const [key, record] of failures) if (time - record.last > failureMemory && record.until <= time) failures.delete(key);
  };
  return {
    // Sliding expiry: every authenticated request extends the session.
    session(request: IncomingMessage) {
      for (const token of tokens(request)) {
        const key = digest(token).toString('hex');
        const expires = sessions.get(key);
        if (expires === undefined) continue;
        if (expires <= now()) { sessions.delete(key); continue; }
        sessions.set(key, now() + sessionLifetime);
        return token;
      }
      return null;
    },
    refresh(request: IncomingMessage, response: ServerResponse, token: string) {
      response.setHeader('set-cookie', cookie(request, token, sessionLifetime / 1000));
    },
    retryAfter(request: IncomingMessage) {
      const record = failures.get(clientAddress(request));
      return record && record.until > now() ? Math.ceil((record.until - now()) / 1000) : 0;
    },
    // Compares digests so neither length nor content leaks through timing.
    verify(request: IncomingMessage, attempt: string) {
      const address = clientAddress(request);
      if (timingSafeEqual(digest(attempt), secret)) { failures.delete(address); return true; }
      const time = now();
      const previous = failures.get(address);
      const count = previous && time - previous.last <= failureMemory ? previous.count + 1 : 1;
      if (!previous && failures.size >= maxTrackedAddresses) {
        prune();
        if (failures.size >= maxTrackedAddresses) failures.delete(failures.keys().next().value!);
      }
      failures.set(address, { count, last: time, until: count > freeAttempts ? time + Math.min(maxBackoff, 1000 * 2 ** (count - freeAttempts)) : 0 });
      return false;
    },
    signIn(request: IncomingMessage, response: ServerResponse) {
      if (sessions.size >= maxSessions) prune();
      if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value!);
      const token = randomBytes(32).toString('base64url');
      sessions.set(digest(token).toString('hex'), now() + sessionLifetime);
      response.setHeader('set-cookie', cookie(request, token, sessionLifetime / 1000));
    },
    signOut(request: IncomingMessage, response: ServerResponse) {
      for (const token of tokens(request)) sessions.delete(digest(token).toString('hex'));
      response.setHeader('set-cookie', cookie(request, '', 0));
    },
  };
}
type Auth = ReturnType<typeof createAuth>;

async function handleSession(auth: Auth | null, request: IncomingMessage, response: ServerResponse) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (!auth) return json(response, 200, { ok: true, value: { signedIn: true, required: false } });
    const token = auth.session(request);
    if (token) auth.refresh(request, response, token);
    return json(response, 200, { ok: true, value: { signedIn: !!token, required: true } });
  }
  if (request.method !== 'POST' && request.method !== 'DELETE') return json(response, 405, { ok: false, error: 'Use GET, POST or DELETE.' });
  if (!sameOrigin(request) || (request.method === 'POST' && !jsonRequest(request))) {
    return json(response, 403, { ok: false, error: 'Cross-origin or non-JSON request refused.' });
  }
  if (request.method === 'DELETE') { auth?.signOut(request, response); return json(response, 200, { ok: true }); }
  if (!auth) return json(response, 200, { ok: true });
  const wait = auth.retryAfter(request);
  if (wait) {
    response.setHeader('retry-after', String(wait));
    return json(response, 429, { ok: false, error: `Too many sign-in attempts. Try again in ${wait} ${wait === 1 ? 'second' : 'seconds'}.` });
  }
  let password: unknown;
  try { password = (JSON.parse(await readBody(request, 4096)) as { password?: unknown } | null)?.password; }
  catch { return json(response, 400, { ok: false, error: 'Invalid sign-in request.' }); }
  if (typeof password !== 'string' || password.length > 1024) return json(response, 400, { ok: false, error: 'Invalid sign-in request.' });
  if (!auth.verify(request, password)) return json(response, 401, { ok: false, error: 'That password is incorrect.' });
  auth.signIn(request, response);
  json(response, 200, { ok: true });
}

async function sendCover(client: SubsonicClient, response: ServerResponse, searchParams: URLSearchParams) {
  const id = searchParams.get('id') ?? '';
  if (!id || id.length > 256) return json(response, 404, { ok: false, error: 'Cover art is not available.' });
  const result = await Effect.runPromise(Effect.either(client.coverArt(id, Number(searchParams.get('size') ?? 300))));
  if (Either.isLeft(result)) return json(response, 404, { ok: false, error: result.left.message });
  response.setHeader('content-type', result.right.contentType);
  response.setHeader('cache-control', 'private, max-age=86400');
  response.setHeader('x-content-type-options', 'nosniff');
  response.end(result.right.bytes);
}

// Browser playback. The credentialed stream URL stays on this server; the browser sees
// /api/stream?id=... and gets the bytes, with Range passed through so seeking works.
async function sendStream(client: SubsonicClient, request: IncomingMessage, response: ServerResponse, searchParams: URLSearchParams) {
  const id = searchParams.get('id') ?? '';
  if (!Schema.is(IdSchema)(id)) return json(response, 404, { ok: false, error: 'This song is not available.' });
  const controller = new AbortController();
  response.on('close', () => controller.abort());
  const range = request.headers.range;
  let upstream: Response;
  try {
    upstream = await fetch(client.streamLocation(id, searchParams.get('format') === 'mp3' ? 'mp3' : 'raw'), {
      headers: range ? { range } : {}, signal: controller.signal, redirect: 'error',
    });
  } catch { return json(response, 502, { ok: false, error: 'The server did not send this song.' }); }
  // Subsonic errors arrive as JSON with HTTP 200; only audio passes through.
  const type = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (!upstream.ok || !upstream.body || !(type.startsWith('audio/') || type === 'application/ogg')) {
    await upstream.body?.cancel().catch(() => {});
    return json(response, 404, { ok: false, error: 'The server could not stream this song.' });
  }
  response.statusCode = upstream.status;
  for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(header);
    if (value) response.setHeader(header, value);
  }
  response.setHeader('cache-control', 'private, no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  if (request.method === 'HEAD') { await upstream.body.cancel().catch(() => {}); return response.end(); }
  Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>).on('error', () => response.destroy()).pipe(response);
}

// Why /api must stay closed on this bind, or null when it may serve.
export function refusal(host: string | boolean | undefined, password: string | undefined) {
  if (password !== undefined && password.length < minimumPasswordLength) return `SQUIGGLY_WEB_PASSWORD must be at least ${minimumPasswordLength} characters.`;
  if (password === undefined && !isLoopbackHost(host)) return `Set SQUIGGLY_WEB_PASSWORD (${minimumPasswordLength} or more characters) to serve this library beyond 127.0.0.1.`;
  return null;
}

interface HostedServer {
  middlewares: Connect.Server;
  config?: { server?: { host?: string | boolean }; preview?: { host?: string | boolean }; logger?: { error(message: string): void } };
}

export function navidromePreview({ env = process.env, client = createClient(env), now = Date.now }: PreviewOptions = {}): Plugin {
  const password = env.SQUIGGLY_WEB_PASSWORD || undefined;
  const auth = password && password.length >= minimumPasswordLength ? createAuth(password, now) : null;
  return {
    name: 'squiggly-navidrome-preview',
    apply: 'serve',
    configureServer(server) { mount(server, server.config.server.host); },
    // `vite preview` serves the production build; phones load it far faster than the dev server's module graph.
    configurePreviewServer(server) { mount(server, server.config.preview.host); },
  };
  function mount(server: HostedServer, host: string | boolean | undefined) {
    const refused = refusal(host, password);
    if (refused) (server.config?.logger ?? console).error(`\n  Squiggly is not serving /api on ${host === true ? 'every interface' : String(host)}. ${refused}\n`);
    server.middlewares.use('/api', async (request, response) => {
      const { pathname, searchParams } = new URL(request.url ?? '/', 'http://preview');
      try {
        if (refused) return json(response, 503, { ok: false, error: refused });
        // Without a password the library is for this computer only, so a proxy may not relay it.
        if (!auth && proxied(request)) return json(response, 503, { ok: false, error: `Set SQUIGGLY_WEB_PASSWORD (${minimumPasswordLength} or more characters) to serve this library through a proxy.` });
        if (pathname === '/session') return await handleSession(auth, request, response);
        if (auth && !auth.session(request)) return json(response, 401, { ok: false, error: signInRequired });
        if (!client) return json(response, 503, { ok: false, error: unconfigured });
        if (pathname === '/cover') {
          if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { ok: false, error: 'Use GET.' });
          return await sendCover(client, response, searchParams);
        }
        if (pathname === '/stream') {
          if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { ok: false, error: 'Use GET.' });
          return await sendStream(client, request, response, searchParams);
        }
        const method = pathname.slice(1);
        if (!isLibraryMethod(method)) return json(response, 404, { ok: false, error: 'Unknown library method.' });
        if (request.method !== 'POST') return json(response, 405, { ok: false, error: 'Use POST.' });
        // Only same-origin JSON requests may reach the account.
        if (!jsonRequest(request) || !sameOrigin(request)) {
          return json(response, 403, { ok: false, error: 'Cross-origin or non-JSON request refused.' });
        }
        let args: unknown;
        // Large enough for a 5,000-song playlist reorder.
        try { args = JSON.parse(await readBody(request, 2 * 1024 * 1024)); }
        catch { return json(response, 400, { ok: false, error: 'Invalid library request.' }); }
        const result = await Effect.runPromise(Effect.either(libraryCall(client, method, args)));
        if (Either.isRight(result)) return json(response, 200, { ok: true, value: result.right.value });
        json(response, result.left.message === 'Invalid library request.' ? 400 : 502, { ok: false, error: result.left.message });
      } catch { if (!response.headersSent) json(response, 500, { ok: false, error: 'Preview request failed.' }); }
    });
  }
}
