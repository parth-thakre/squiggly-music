import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { type IncomingMessage, type ServerResponse, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, type LookupFunction, isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { TLSSocket } from 'node:tls';
import { Effect, Either, Schema } from 'effect';
import type { Connect, Plugin } from 'vite';
import { SubsonicClient, isLibraryMethod, libraryCall, resolveServerAddress } from '../packages/adapter-opensubsonic/client';
import type { Connection } from '../packages/core/contracts';
import { Metrics } from '../packages/core/metrics';
import { ConnectionSchema, IdSchema } from '../packages/core/validation';

// Dev/preview-server bridge so the browser build can browse and play a real library through
// the same OpenSubsonic connector as the desktop app. The server login comes from the page
// (POST /api/connect) or from the environment, and never reaches the browser or the repo:
//   SQUIGGLY_PREVIEW_NAVIDROME_URL, SQUIGGLY_PREVIEW_NAVIDROME_USER, SQUIGGLY_PREVIEW_NAVIDROME_PASSWORD
//                           optional: a server every browser uses until it connects to its own
//   SQUIGGLY_WEB_PASSWORD   the password the browser signs in with (12 or more characters)
//
// Whoever reaches /api acts as the connected Navidrome account, so every /api route needs a
// session cookie once SQUIGGLY_WEB_PASSWORD is set:
//   GET    /api/session  -> { ok: true, value: { signedIn, required, connected, serverName, pageConnection } }
//                        connected: library calls have a server. pageConnection: it is this
//                        browser's own (POST /api/connect), not the environment's.
//   POST   /api/session  body: { "password": "..." } -> { ok: true } and an HttpOnly, SameSite=Strict
//                        session cookie (30 days, sliding), or 401/429 { ok: false, error }
//   DELETE /api/session  -> { ok: true }; forgets the session and clears the cookie
// Without a session every other route answers 401 { ok: false, error: 'Sign in to use this library.' }.
// Sessions live in memory: restarting the server signs everyone out.
//
// Connecting from the page (same-origin JSON, and the session above when there is a password):
//   POST   /api/connect     body: { url, username, password } -> { ok: true, value: { serverName } }
//                           and an HttpOnly, SameSite=Strict `squiggly-connection` cookie, or
//                           { ok: false, error } with the connector's own message. An address
//                           without a scheme is tried as HTTPS, then HTTP, as on the desktop.
//   POST   /api/disconnect  -> { ok: true }; forgets this browser's connection and clears the cookie
// The cookie holds a random id; the connector, with the password it needs, stays in this
// process's memory and is never written to disk or logged. At most 32 are kept (the one used
// least recently goes first), each until 24 hours pass without a request, the browser
// disconnects or signs out, or the server restarts. A browser's own connection is used before
// the environment's. With neither, the library, cover, stream and station routes answer
// 503 { ok: false, error: 'Not connected to a server. Connect from the page.' }.
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
// Library calls, cover, stream and station use the browser's own connection, or else the environment's.
// GET  /api/cover?id=<coverArt>&size=<32..1200>  -> image bytes, or 404 with a Result
// GET  /api/stream?id=<song>[&format=mp3]         -> audio bytes (Range supported), or 404 with a Result
// GET  /api/station?id=<station>                  -> an internet radio station's live stream, or 404/502 with a Result
// Audio and image elements load cover and stream same-origin, so the cookie rides along.
// Writes (playlist edits, reportPlay, saveQueue) reach the connected account. `lyrics` contacts
// LRCLIB only when the browser passes lookup=true as its second argument.
export const notConnected = 'Not connected to a server. Connect from the page.';
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
// Connections made from the page: one per browser, in memory only.
const connectionCookie = 'squiggly-connection';
export const maxConnections = 32;
export const connectionIdle = 24 * 60 * 60 * 1000;

export interface PreviewOptions {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Tests substitute a connector; by default one is built from the environment. */
  client?: SubsonicClient | null;
  /** Builds the connector for an address a page connects to. Tests substitute one. */
  connector?: (connection: Connection) => SubsonicClient;
  now?: () => number;
  /** Where the station relay may connect. Tests let their local stations through; by default only public addresses. */
  stationAddress?: (address: string) => boolean;
}

const newClient = (connection: Connection) => new SubsonicClient(connection, new Metrics());
function createClient(env: NodeJS.ProcessEnv) {
  const url = env.SQUIGGLY_PREVIEW_NAVIDROME_URL;
  const username = env.SQUIGGLY_PREVIEW_NAVIDROME_USER;
  const password = env.SQUIGGLY_PREVIEW_NAVIDROME_PASSWORD;
  if (!url || !username || !password) return null;
  try { return newClient({ url, username, password }); }
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

// A plain HTTP server is named with its scheme, since nothing sent to it is encrypted (as the
// desktop names it).
function hostName(client: SubsonicClient) {
  try {
    const address = new URL(client.baseUrl);
    return `${address.protocol === 'http:' ? 'http://' : ''}${address.host}`;
  } catch { return null; }
}

// Each browser's own connector, found by the `squiggly-connection` cookie. Keyed by a hash of the
// id, as sessions are, and kept in order of use so the first entry is the one idle longest.
function createConnections(now: () => number) {
  const connections = new Map<string, { client: SubsonicClient; serverName: string; used: number }>();
  const values = (request: IncomingMessage) => (request.headers.cookie ?? '').split(';')
    .map(part => part.trim().split('='))
    .filter(([name, value]) => name === connectionCookie && !!value && /^[0-9a-f]{64}$/.test(value))
    .map(([, value]) => value);
  const ids = (request: IncomingMessage) => values(request).map(value => digest(value).toString('hex'));
  const cookie = (request: IncomingMessage, value: string, maxAge: number) =>
    `${connectionCookie}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure(request) ? '; Secure' : ''}`;
  const prune = () => {
    const time = now();
    for (const [key, entry] of connections) if (time - entry.used >= connectionIdle) connections.delete(key);
  };
  return {
    // Every request through a connection counts as use.
    get(request: IncomingMessage) {
      prune();
      for (const key of ids(request)) {
        const entry = connections.get(key);
        if (!entry) continue;
        entry.used = now();
        connections.delete(key); connections.set(key, entry);
        return entry;
      }
      return null;
    },
    add(request: IncomingMessage, response: ServerResponse, client: SubsonicClient, serverName: string) {
      prune();
      // Connecting again replaces this browser's connection rather than adding a second.
      for (const key of ids(request)) connections.delete(key);
      while (connections.size >= maxConnections) connections.delete(connections.keys().next().value!);
      const id = randomBytes(32).toString('hex');
      connections.set(digest(id).toString('hex'), { client, serverName, used: now() });
      response.setHeader('set-cookie', cookie(request, id, sessionLifetime / 1000));
    },
    // The cookie lasts as long as the page keeps coming back; the host forgets it sooner when idle.
    refresh(request: IncomingMessage, response: ServerResponse) {
      const value = values(request).find(value => connections.has(digest(value).toString('hex')));
      if (value) response.appendHeader('set-cookie', cookie(request, value, sessionLifetime / 1000));
    },
    // Whether the browser sent a connection cookie at all, known here or not.
    carries: (request: IncomingMessage) => values(request).length > 0,
    remove(request: IncomingMessage) {
      for (const key of ids(request)) connections.delete(key);
      return cookie(request, '', 0);
    },
  };
}
type Connections = ReturnType<typeof createConnections>;

// The page's server login: resolved and checked as the desktop does it, then kept here.
async function handleConnect(connections: Connections, connector: (connection: Connection) => SubsonicClient, request: IncomingMessage, response: ServerResponse) {
  if (request.method !== 'POST') return json(response, 405, { ok: false, error: 'Use POST.' });
  if (!jsonRequest(request) || !sameOrigin(request)) return json(response, 403, { ok: false, error: 'Cross-origin or non-JSON request refused.' });
  let body: unknown;
  try { body = JSON.parse(await readBody(request, 16 * 1024)); }
  catch { return json(response, 400, { ok: false, error: 'Invalid connection request.' }); }
  const typed = Schema.decodeUnknownEither(ConnectionSchema)(body);
  if (Either.isLeft(typed)) return json(response, 400, { ok: false, error: 'Enter the server address, username, and password.' });
  const attempt = await Effect.runPromise(Effect.either(Effect.gen(function* () {
    const connection = yield* resolveServerAddress(typed.right, connector);
    // The address check's own message (a bad address says how), not Effect's generic one.
    const client = yield* Effect.try({ try: () => connector(connection), catch: error => error instanceof Error ? error : new Error('Check the server address.') });
    const info = yield* client.ping();
    return { client, info };
  })));
  // The connector's messages are its own, never the server's text or an address with credentials.
  if (Either.isLeft(attempt)) return json(response, 502, { ok: false, error: attempt.left.message || 'Could not connect.' });
  const { client, info } = attempt.right;
  const host = hostName(client);
  const serverName = host ? `${info.name} (${host})` : info.name;
  connections.add(request, response, client, serverName);
  json(response, 200, { ok: true, value: { serverName } });
}

// What the page may know about its server: nothing until it has signed in.
type Server = { client: SubsonicClient; serverName: string | null; pageConnection: boolean } | null;
async function handleSession(auth: Auth | null, connections: Connections, server: (request: IncomingMessage) => Server, configured: Server, request: IncomingMessage, response: ServerResponse) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const token = auth?.session(request) ?? null;
    if (auth && token) auth.refresh(request, response, token);
    const signedIn = !auth || !!token;
    let found = signedIn ? server(request) : null;
    if (found?.pageConnection) connections.refresh(request, response);
    else if (signedIn && connections.carries(request)) {
      // A connection this host no longer has (it restarted, or the connection sat idle or was
      // pushed out): the cookie goes, and the environment's server, if any, is the page's again.
      response.appendHeader('set-cookie', connections.remove(request));
      found = configured;
    }
    return json(response, 200, { ok: true, value: {
      signedIn, required: !!auth, connected: !!found, serverName: found?.serverName ?? null, pageConnection: found?.pageConnection ?? false,
    } });
  }
  if (request.method !== 'POST' && request.method !== 'DELETE') return json(response, 405, { ok: false, error: 'Use GET, POST or DELETE.' });
  if (!sameOrigin(request) || (request.method === 'POST' && !jsonRequest(request))) {
    return json(response, 403, { ok: false, error: 'Cross-origin or non-JSON request refused.' });
  }
  // Signing out forgets this browser's connection too, so the next person to sign in here
  // doesn't find the last one's account.
  if (request.method === 'DELETE') {
    const connected = connections.carries(request);
    const cleared = connections.remove(request);
    auth?.signOut(request, response);
    if (connected) response.appendHeader('set-cookie', cleared);
    return json(response, 200, { ok: true });
  }
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

// An internet radio station, relayed. Its stream address comes from the server's station list and
// stays here, as a song's does; the browser sees /api/station?id=... . Stations live elsewhere on
// the web, so up to five redirects are followed, to http or https only. Every hop must lead to a
// public address, never this machine or the networks around it, and the connection goes to the
// address that was checked, so a second DNS answer can't swap in another. Only audio passes, and
// no ICY metadata is asked for, so the bytes are the stream alone. The relay runs until the
// browser lets go.
const maxStationRedirects = 5;
// A station the last list didn't have makes the server list every station again; that happens
// at most this often, however many unknown ids are asked for.
const stationListInterval = 30_000;
const missingStation = 'This station is no longer on the server. Refresh the stations and try again.';
const localNetworks = new BlockList();
// Unspecified, private, CGNAT, loopback, link-local, multicast, and reserved (with broadcast).
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) localNetworks.addSubnet(network, prefix, 'ipv4');
// Unspecified, loopback and IPv4-compatible, unique local, link-local, site-local, multicast.
// BlockList checks IPv4-mapped addresses (::ffff:10.0.0.1) against the IPv4 networks itself.
for (const [network, prefix] of [['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) localNetworks.addSubnet(network, prefix, 'ipv6');
export function publicAddress(address: string) {
  const family = isIP(address);
  return family !== 0 && !localNetworks.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
const notPublic = () => Object.assign(new Error('The station is not at a public address.'), { code: 'EACCES' });
// Resolves as usual, then refuses the lot if any answer isn't allowed.
const checkedLookup = (allowed: (address: string) => boolean): LookupFunction => (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    if (!addresses.length || addresses.some(({ address }) => !allowed(address))) return callback(notPublic(), '');
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};
export async function openStation(location: string, allowed: (address: string) => boolean, signal: AbortSignal): Promise<IncomingMessage> {
  const lookup = checkedLookup(allowed);
  let url = new URL(location);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The station is not at a web address.');
    // An address written as one is connected to without a lookup, so it's checked here.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !allowed(host)) throw notPublic();
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    // A connection of its own (agent: false), never a pooled socket opened without the check.
    const upstream = await new Promise<IncomingMessage>((resolve, reject) => { send(url, { signal, lookup, agent: false }, resolve).on('error', reject).end(); });
    const next = upstream.headers.location;
    if (!upstream.statusCode || upstream.statusCode < 300 || upstream.statusCode > 399 || !next) return upstream;
    upstream.destroy();
    if (hop >= maxStationRedirects) throw new Error('The station redirected too many times.');
    url = new URL(next, url);
  }
}
// When each server last listed its stations for an unknown id. Kept per server, since each page
// may use its own; a browser asking for unknown stations never holds back another's.
interface StationRelay { allowed: (address: string) => boolean; listedAt: WeakMap<SubsonicClient, number>; now: () => number }
async function sendStation(client: SubsonicClient, request: IncomingMessage, response: ServerResponse, searchParams: URLSearchParams, relay: StationRelay) {
  const id = searchParams.get('id') ?? '';
  if (!Schema.is(IdSchema)(id)) return json(response, 404, { ok: false, error: 'This station is not available.' });
  let location = client.knownStationLocation(id);
  if (!location) {
    if (relay.now() - (relay.listedAt.get(client) ?? -Infinity) < stationListInterval) return json(response, 404, { ok: false, error: missingStation });
    relay.listedAt.set(client, relay.now());
    const found = await Effect.runPromise(Effect.either(client.stationLocation(id)));
    if (Either.isLeft(found)) return json(response, 404, { ok: false, error: found.left.message });
    location = found.right;
  }
  const controller = new AbortController();
  response.on('close', () => controller.abort());
  // Fifteen seconds to answer; the stream itself has no end.
  const timer = setTimeout(() => controller.abort(), 15_000);
  let upstream: IncomingMessage;
  try { upstream = await openStation(location, relay.allowed, controller.signal); }
  catch { return json(response, 502, { ok: false, error: 'The station did not answer.' }); }
  finally { clearTimeout(timer); }
  const status = upstream.statusCode ?? 0;
  const type = String(upstream.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (status < 200 || status > 299 || !(type.startsWith('audio/') || type === 'application/ogg')) {
    upstream.destroy();
    return json(response, 502, { ok: false, error: 'The station did not send audio this browser can play.' });
  }
  response.statusCode = 200;
  response.setHeader('content-type', type);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  if (request.method === 'HEAD') { upstream.destroy(); return response.end(); }
  upstream.on('error', () => response.destroy()).pipe(response);
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

export function navidromePreview({ env = process.env, client = createClient(env), connector = newClient, now = Date.now, stationAddress = publicAddress }: PreviewOptions = {}): Plugin {
  const password = env.SQUIGGLY_WEB_PASSWORD || undefined;
  const auth = password && password.length >= minimumPasswordLength ? createAuth(password, now) : null;
  const relay: StationRelay = { allowed: stationAddress, listedAt: new WeakMap(), now };
  const connections = createConnections(now);
  const configured = client && { client, serverName: hostName(client), pageConnection: false };
  // This browser's own connection, or else the environment's. A browser whose connection the host
  // has forgotten gets neither until it asks for the session again (which drops the cookie), so
  // its calls never land quietly on another account.
  const serverFor = (request: IncomingMessage): Server => {
    const own = connections.get(request);
    if (own) return { client: own.client, serverName: own.serverName, pageConnection: true };
    return connections.carries(request) ? null : configured || null;
  };
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
        if (pathname === '/session') return await handleSession(auth, connections, serverFor, configured || null, request, response);
        if (auth && !auth.session(request)) return json(response, 401, { ok: false, error: signInRequired });
        if (pathname === '/connect') return await handleConnect(connections, connector, request, response);
        if (pathname === '/disconnect') {
          if (request.method !== 'POST') return json(response, 405, { ok: false, error: 'Use POST.' });
          if (!jsonRequest(request) || !sameOrigin(request)) return json(response, 403, { ok: false, error: 'Cross-origin or non-JSON request refused.' });
          response.setHeader('set-cookie', connections.remove(request));
          return json(response, 200, { ok: true });
        }
        const client = serverFor(request)?.client;
        if (!client) return json(response, 503, { ok: false, error: notConnected });
        if (pathname === '/cover') {
          if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { ok: false, error: 'Use GET.' });
          return await sendCover(client, response, searchParams);
        }
        if (pathname === '/stream') {
          if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { ok: false, error: 'Use GET.' });
          return await sendStream(client, request, response, searchParams);
        }
        if (pathname === '/station') {
          if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { ok: false, error: 'Use GET.' });
          return await sendStation(client, request, response, searchParams, relay);
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
