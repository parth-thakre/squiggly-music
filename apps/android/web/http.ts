import { Squiggly } from './plugin';

// A fetch for the connector that runs natively. The page is served from https://localhost, and
// a WebView fetch from there would need the server's CORS headers and couldn't reach a server on
// plain HTTP at all (mixed content), which is how most home servers are set up. Natively,
// neither applies. It supports what SubsonicClient and the LRCLIB client use: GET and POST,
// string or URLSearchParams bodies, abort signals, and redirect: 'error'.

// Responses are capped natively as well as by the connector, which counts the bytes it reads.
const MAX_BYTES = 9 * 1024 * 1024;
let requests = 0;

export const nativeFetch: typeof fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const { signal } = init;
  if (signal?.aborted) throw abortError();
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
  let body: string | undefined;
  if (init.body instanceof URLSearchParams) {
    body = init.body.toString();
    headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8';
  } else if (typeof init.body === 'string') body = init.body;
  else if (init.body != null) throw new TypeError('This fetch sends text bodies only.');

  const id = ++requests;
  const sent = Squiggly.http({ id, url, method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}), timeoutMs: 15000, maxBytes: MAX_BYTES });
  let stop: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    stop = () => { void Squiggly.cancelHttp({ id }); reject(abortError()); };
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    const response = await Promise.race([sent, aborted]);
    // Redirects are never followed (the connector asks for redirect: 'error'); a 3xx arrives as itself.
    return new Response(nullBody(response.status) ? null : response.body, { status: response.status, headers: response.headers });
  } catch (error) {
    // Native failures carry the address, which carries credentials. Say nothing specific.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new TypeError('Network request failed.');
  } finally {
    if (stop) signal?.removeEventListener('abort', stop);
  }
};

const nullBody = (status: number) => status === 204 || status === 205 || status === 304;
const abortError = () => new DOMException('The request was aborted.', 'AbortError');
