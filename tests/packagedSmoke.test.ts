import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// scripts/packaged-smoke.mjs against a stand-in for a packaged app: a Node script that prints the
// DevTools line, lists one page, and answers Runtime.evaluate the way SQUIGGLY_FAKE_PAGE says.
// Whatever the page does, the smoke test has to finish, stop the app, and delete its profile.
const fakeApp = `#!${process.execPath}
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const behaviour = process.env.SQUIGGLY_FAKE_PAGE;
setTimeout(() => process.exit(3), 30000);
const frame = text => {
  const body = Buffer.from(text);
  const head = body.length < 126 ? [0x81, body.length] : [0x81, 126, body.length >> 8, body.length & 255];
  return Buffer.concat([Buffer.from(head), body]);
};
const server = createServer((request, response) => {
  const port = server.address().port;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/page/1' }]));
});
server.on('upgrade', (request, socket) => {
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  socket.once('data', () => {
    if (behaviour === 'close') socket.destroy();
    else if (behaviour === 'error') socket.write(frame(JSON.stringify({ id: 1, error: { code: -32000, message: 'Cannot find context with specified id' } })));
    else if (behaviour === 'ready') socket.write(frame(JSON.stringify({ id: 1, result: { result: { type: 'object', value: {
      bridge: true, node: false, engine: 'ready', error: null, mode: 'notify', version: '9.9.9' } } } })));
    // 'silent': the request never gets an answer.
  });
});
server.listen(0, '127.0.0.1', () => process.stderr.write('DevTools listening on ws://127.0.0.1:' + server.address().port + '/devtools/browser/fake\\n'));
`;

let directory: string | undefined;
let smoke: ChildProcess | undefined;
afterEach(async () => {
  if (smoke && smoke.exitCode === null && smoke.signalCode === null) smoke.kill('SIGKILL');
  smoke = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function run(behaviour: string) {
  directory = await mkdtemp(join(tmpdir(), 'squiggly-smoke-test-'));
  const app = join(directory, 'fake-app');
  await writeFile(app, fakeApp);
  await chmod(app, 0o755);
  const profiles = join(directory, 'profiles');
  await mkdir(profiles);
  const started = Date.now();
  const child = spawn(process.execPath, [resolve('scripts/packaged-smoke.mjs'), app, '--timeout', '2'], {
    env: { ...process.env, TMPDIR: profiles, SQUIGGLY_FAKE_PAGE: behaviour }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  smoke = child;
  let output = '';
  child.stdout!.on('data', data => { output += data; });
  child.stderr!.on('data', data => { output += data; });
  const code = await new Promise<number | null>(done => child.once('exit', done));
  return { code, output, seconds: (Date.now() - started) / 1000, profilesLeft: await readdir(profiles) };
}

// The stand-in starts through its #! line, which Windows can't run.
describe.skipIf(process.platform === 'win32')('packaged smoke test', () => {
  it('passes when the page reports a ready engine and the package\'s update mode', async () => {
    const result = await run('ready');
    expect(result.output).toContain('Packaged app started: version 9.9.9, audio engine ready, update mode notify.');
    expect(result.code).toBe(0);
    expect(result.profilesLeft).toEqual([]);
  }, 20_000);

  for (const [behaviour, what, reason] of [
    ['close', 'the page\'s socket closes before it answers (the renderer crashed)', 'The DevTools socket closed before the page answered'],
    ['silent', 'the page never answers (a stalled snapshot)', 'The page didn\'t answer in time'],
    ['error', 'DevTools answers with an error (the page reloaded)', 'Cannot find context with specified id'],
  ]) {
    it(`fails by its deadline and cleans up when ${what}`, async () => {
      const result = await run(behaviour);
      expect(result.output).toContain('Packaged smoke test failed: The preload bridge never appeared.');
      expect(result.output).toContain(reason);
      expect(result.code).toBe(1);
      expect(result.seconds).toBeLessThan(12);
      expect(result.profilesLeft).toEqual([]);
    }, 20_000);
  }
});
