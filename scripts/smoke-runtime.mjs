// Packaged runtime smoke test. Starts the packaged audio host the way the app does: the
// bundled Node runtime forks resources/app.asar.unpacked/out/main/player.js with the
// unpacked Koffi packages and the packaged or system libmpv. It then checks that the
// engine reports ready with a libmpv client API version, decodes a generated WAV through
// mpv's null audio output, and exits cleanly when disconnected. First it runs the unpacked
// esbuild binary that the extension loader uses, and checks its version.
//
//   node scripts/smoke-runtime.mjs dist/win-unpacked          # Windows: bundled libmpv-2.dll
//   node scripts/smoke-runtime.mjs "/opt/Squiggly Music"      # installed RPM: system libmpv
//
// Options:
//   --expect-system-libmpv  fail if the package bundles libmpv (the Linux RPM must not)
//   --no-decode             only check that the engine starts
//   --sample <file>[=<codec>]
//                           also decode this file, and check mpv's audio-codec-name when
//                           given (for example --sample test.flac=flac). Repeatable.
//
// On Linux, the Windows package can be tested under Wine with the bundled node.exe:
//   wine dist/win-unpacked/resources/runtime/node.exe scripts/smoke-runtime.mjs dist/win-unpacked
import { fork, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const samples = args.flatMap((arg, index) => (arg === '--sample' ? [args[index + 1]] : []));
const appDir = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--sample');
if (!appDir) throw new Error('Usage: node scripts/smoke-runtime.mjs <unpacked or installed app dir> [--expect-system-libmpv] [--no-decode]');
const decode = !args.includes('--no-decode');
const windows = process.platform === 'win32';

const resources = join(resolve(appDir), 'resources');
const runtime = join(resources, 'runtime');
const node = join(runtime, windows ? 'node.exe' : 'node');
// Packages built with asar unpack the host next to app.asar. Older packages used resources/app.
const host = [join(resources, 'app.asar.unpacked', 'out', 'main', 'player.js'), join(resources, 'app', 'out', 'main', 'player.js')]
  .find(path => existsSync(path)) ?? join(resources, 'app.asar.unpacked', 'out', 'main', 'player.js');
const bundledLibmpv = join(runtime, 'libmpv-2.dll');
for (const path of [node, host]) if (!existsSync(path)) throw new Error(`Missing ${path}`);
if (windows && !existsSync(bundledLibmpv)) throw new Error(`Missing ${bundledLibmpv}`);
if (args.includes('--expect-system-libmpv') && existsSync(bundledLibmpv)) throw new Error('The package bundles libmpv but should use the system library.');

const nodeVersion = execFileSync(node, ['--version']).toString().trim();
console.log(`Bundled runtime: ${node} (${nodeVersion})`);

// The extension loader runs this binary (apps/desktop/main/extensions/electron.ts).
const esbuildDir = join(resources, 'app.asar.unpacked', 'node_modules', '@esbuild', `${process.platform}-${process.arch}`);
const esbuild = join(esbuildDir, windows ? 'esbuild.exe' : join('bin', 'esbuild'));
if (!existsSync(esbuild)) throw new Error(`Missing ${esbuild}`);
const esbuildVersion = execFileSync(esbuild, ['--version']).toString().trim();
const expectedEsbuild = JSON.parse(readFileSync(join(esbuildDir, 'package.json'), 'utf8')).version;
if (esbuildVersion !== expectedEsbuild) throw new Error(`${esbuild} reports ${esbuildVersion}, but its package is ${expectedEsbuild}.`);
console.log(`esbuild: ${esbuild} (${esbuildVersion})`);

// Mirror the app's launch environment. Drop developer overrides so the test cannot
// pass by loading a library or runtime from outside the package.
const env = { ...process.env, SQUIGGLY_TEST_NULL_AUDIO: '1', SQUIGGLY_AUDIO_EXCLUSIVE: '0' };
delete env.SQUIGGLY_LIBMPV_PATH; delete env.SQUIGGLY_NODE_PATH; delete env.NODE_OPTIONS; delete env.NODE_PATH;
if (existsSync(bundledLibmpv)) env.SQUIGGLY_LIBMPV_PATH = bundledLibmpv;

const fixtures = mkdtempSync(join(tmpdir(), 'squiggly-smoke-'));
const snapshots = [];
const replies = new Map();
let clientApiVersion = null;
let stderr = '';
const child = fork(host, [], { execPath: node, execArgv: [], env, cwd: fixtures, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
child.on('message', message => {
  if (message.type === 'snapshot') { snapshots.push(message.player); clientApiVersion = message.clientApiVersion; }
  else if (message.type === 'reply') replies.set(message.id, message.error);
});
const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));

async function until(label, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${label}. Last snapshot: ${JSON.stringify(snapshots.at(-1) ?? null)}`);
}

function wav(seconds) {
  const rate = 48000; const bytes = rate * seconds * 2;
  const data = Buffer.alloc(44 + bytes);
  data.write('RIFF', 0); data.writeUInt32LE(36 + bytes, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(bytes, 40);
  for (let i = 0; i < bytes / 2; i++) data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 2000), 44 + i * 2);
  const path = join(fixtures, 'smoke.wav');
  writeFileSync(path, data);
  return path;
}

let nextId = 1;
async function request(action) {
  const id = nextId++;
  child.send({ id, action });
  await until(`the ${action.type} reply`, () => replies.has(id));
  if (replies.get(id) !== null) throw new Error(`${action.type} failed: ${replies.get(id)}`);
}

// Queues one file, waits until libmpv reports decoded playback of it, then stops.
async function play(file, { rate, codec }) {
  const from = snapshots.length;
  const name = file.split(/[\\/]/).at(-1);
  await request({ type: 'queue', tracks: [{ location: file, track: {
    id: `smoke-${name}`, title: name, artist: 'Squiggly', album: '', duration: 4, source: 'local',
    sourceFormat: name.split('.').at(-1), sourceSampleRate: null, sourceBitDepth: null,
  } }] });
  const playing = await until(`decoded playback of ${name}`, () => snapshots.slice(from).findLast(snapshot => snapshot.playing
    && snapshot.position > 0 && snapshot.audio?.decoderRate && (!rate || snapshot.audio.decoderRate === rate)
    && (!codec || snapshot.audio.codec === codec)));
  if (playing.audio.outputBackend !== 'null') throw new Error(`Expected the null audio output, got ${playing.audio.outputBackend}`);
  console.log(`Decoded ${name} through libmpv: ${playing.audio.codec ?? 'unknown codec'}, ${playing.audio.decoderRate} Hz, ${playing.audio.decoderFormat ?? 'unknown format'}, position ${playing.position.toFixed(2)} s`);
  await request({ type: 'stop' });
}

let failure = null;
try {
  const first = await until('the first engine snapshot', () => snapshots.find(snapshot => snapshot.engine !== 'starting' && snapshot.engine !== undefined));
  if (first.engine !== 'ready') throw new Error(`Engine is ${first.engine}: ${first.error}`);
  if (!clientApiVersion) throw new Error('The engine is ready but reported no libmpv client API version.');
  console.log(`Engine ready with libmpv client API ${clientApiVersion}. Output devices: ${first.devices?.length ?? 0}`);

  if (decode) {
    await play(wav(4), { rate: 48000, codec: 'pcm_s16le' });
    for (const sample of samples) {
      const [file, codec] = sample.split('=');
      await play(resolve(file), { codec });
    }
  }

  // The host exits with 0 when its parent disconnects without an engine failure.
  child.disconnect();
  const { code, signal } = await Promise.race([exited, new Promise(resolveTimeout => setTimeout(() => resolveTimeout({ code: 'timeout' }), 10000))]);
  if (code !== 0) throw new Error(`Audio host exited with ${code ?? signal} after disconnect.`);
  console.log('Audio host exited cleanly.');
} catch (error) {
  failure = error;
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  rmSync(fixtures, { recursive: true, force: true });
}
if (failure) {
  console.error(`Smoke test failed: ${failure.message}`);
  if (!stderr) console.error('The audio host wrote nothing to stderr.');
  process.exit(1);
}
console.log('Packaged audio runtime smoke test passed.');
