// Starts a packaged desktop build and checks that it comes up: the window loads, the preload
// bridge is there without Node, the audio engine reports ready, and the update mode is the one
// the package should have. It needs a display (a session, or xvfb-run), and it uses a private
// profile, the null audio output, and no session bus, so it never touches your music or settings.
//
//   node scripts/packaged-smoke.mjs <executable> [--update-mode notify|install|off] [--mount] [--timeout <seconds>] [-- <app arguments>]
//
// The executable is what the package launches: "/opt/Squiggly Music/squiggly-music" for the deb
// or RPM, squashfs-root/AppRun for an extracted AppImage, or the AppImage itself. An AppImage
// runs with APPIMAGE_EXTRACT_AND_RUN, so it needs no FUSE; --mount runs it the usual way instead,
// which needs libfuse2. libmpv comes from the system, or from LD_LIBRARY_PATH or
// SQUIGGLY_LIBMPV_PATH when you set them. The app gets 60 seconds (or --timeout) to open its
// DevTools port, and as long again to come up; after that the test fails, whatever the page is
// doing. On a machine without a display:
//
//   xvfb-run -a -s "-screen 0 1280x800x24" node scripts/packaged-smoke.mjs squashfs-root/AppRun
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Everything after -- goes to the app (for example --no-sandbox when this runs as root in a container).
const separator = process.argv.indexOf('--', 2);
const appArguments = separator === -1 ? [] : process.argv.slice(separator + 1);
const args = process.argv.slice(2, separator === -1 ? undefined : separator);
const withValue = ['--update-mode', '--timeout'];
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const executable = args.find((arg, index) => !arg.startsWith('--') && !withValue.includes(args[index - 1]));
const timeout = Number(option('--timeout') ?? 60) * 1000;
if (!executable || !(timeout > 0)) throw new Error('Usage: node scripts/packaged-smoke.mjs <executable> [--update-mode notify|install|off] [--mount] [--timeout <seconds>] [-- <app arguments>]');
const expectedMode = option('--update-mode') ?? 'notify';

const profile = mkdtempSync(join(tmpdir(), 'squiggly-packaged-smoke-'));
mkdirSync(join(profile, 'tmp'));
// TMPDIR inside the profile: the AppImage runtime extracts there, and stopping the app below
// stops the runtime before it can delete its copy.
const env = {
  ...process.env, TMPDIR: join(profile, 'tmp'),
  XDG_CONFIG_HOME: join(profile, 'config'), XDG_CACHE_HOME: join(profile, 'cache'), XDG_DATA_HOME: join(profile, 'data'),
  SQUIGGLY_TEST_NULL_AUDIO: '1', SQUIGGLY_AUDIO_EXCLUSIVE: '0', DBUS_SESSION_BUS_ADDRESS: 'disabled:', APPIMAGE_EXTRACT_AND_RUN: '1',
};
// A package must start on its own: no developer overrides for the audio host's Node.
delete env.SQUIGGLY_NODE_PATH; delete env.ELECTRON_RENDERER_URL;
if (args.includes('--mount')) delete env.APPIMAGE_EXTRACT_AND_RUN;
const child = spawn(executable, ['--remote-debugging-port=0', ...appArguments], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
const port = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', code => reject(new Error(`The app exited with ${code} before it was ready.\n${stderr.slice(-2000)}`)));
  child.stderr.on('data', data => {
    stderr += data;
    const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
    if (match) resolve(Number(match[1]));
  });
});
const exited = new Promise(resolve => child.once('exit', resolve));
const signal = name => { try { process.kill(-child.pid, name); } catch { /* already gone */ } };

// One Runtime.evaluate in the page. It settles by the deadline whatever happens: an answer, an
// error from DevTools (the page reloaded), the socket closing (the renderer crashed), or nothing
// at all (a snapshot that never comes). The socket is closed on every path.
function evaluate(url, expression, deadline) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try { socket.close(); } catch { /* already closed */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('The page didn\'t answer in time.')), Math.max(0, deadline - Date.now()));
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { returnByValue: true, awaitPromise: true, expression } }));
    socket.onerror = () => finish(new Error('The DevTools socket failed.'));
    socket.onclose = () => finish(new Error('The DevTools socket closed before the page answered.'));
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return finish(new Error('DevTools sent something that isn\'t JSON.')); }
      if (message.id !== 1) return;
      if (message.error) finish(new Error(`DevTools refused the request: ${message.error.message}`));
      else if (message.result?.exceptionDetails) finish(new Error(message.result.exceptionDetails.exception?.description ?? 'The page threw.'));
      else if (!message.result?.result) finish(new Error('DevTools answered without a result.'));
      else finish(null, message.result.result.value);
    };
  });
}

let failure = null;
try {
  const devtools = await Promise.race([port, new Promise((_, reject) => setTimeout(() => reject(new Error(`No DevTools port after ${timeout / 1000} s.\n${stderr.slice(-2000)}`)), timeout))]);
  const deadline = Date.now() + timeout;
  let state = null;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`The app exited with ${child.exitCode ?? child.signalCode}.\n${stderr.slice(-2000)}`);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${devtools}/json`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })).json();
      const page = targets.find(target => target.type === 'page');
      if (page) {
        state = await evaluate(page.webSocketDebuggerUrl, `(async () => {
          const bridge = window.squiggly;
          if (!bridge) return { bridge: false };
          const snapshot = await bridge.snapshot();
          return { bridge: true, node: typeof process !== 'undefined' || typeof require !== 'undefined', engine: snapshot.player.engine,
            error: snapshot.player.error, mode: snapshot.update.mode, version: snapshot.update.current };
        })()`, deadline);
        if (state?.bridge && state.engine !== 'starting') break;
      }
    } catch (error) { lastError = error; /* the page may still be loading */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!state?.bridge) throw new Error(`The preload bridge never appeared.${lastError ? ` Last: ${lastError.message}` : ''}`);
  if (state.node) throw new Error('Node leaked into the renderer.');
  if (state.engine !== 'ready') throw new Error(`The audio engine is ${state.engine}: ${state.error}`);
  if (state.mode !== expectedMode) throw new Error(`The update mode is ${state.mode}, not ${expectedMode}.`);
  console.log(`Packaged app started: version ${state.version}, audio engine ready, update mode ${state.mode}.`);
} catch (error) {
  failure = error;
} finally {
  signal('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 8000))]);
  signal('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
}
if (failure) { console.error(`Packaged smoke test failed: ${failure.message}`); process.exit(1); }
console.log('Packaged smoke test passed.');
process.exit(0);
