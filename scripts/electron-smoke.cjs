// Native Electron integration test. Uses a private profile, a generated WAV, and
// the null audio sink. It never accesses a real music library or audio device.
const { app, dialog } = require('electron');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

const temporary = mkdtempSync(join(tmpdir(), 'squiggly-desktop-test-'));
app.setPath('userData', join(temporary, 'profile'));
app.disableHardwareAcceleration();
process.env.SQUIGGLY_TEST_NULL_AUDIO = '1';
process.env.SQUIGGLY_SMOKE_TEST = '1';
delete process.env.ELECTRON_RENDERER_URL;
const deadline = setTimeout(() => { console.error('Desktop smoke test timed out.'); finish(1); }, 15000);
function finish(code) {
  clearTimeout(deadline);
  try { rmSync(temporary, { recursive: true, force: true }); }
  finally {
    if (code !== 0) { app.exit(code); return; }
    // Success goes through quit so main's before-quit terminates the audio host; bound it in case that stalls.
    setTimeout(() => { console.error('Desktop smoke test did not quit.'); app.exit(1); }, 10000);
    app.quit();
  }
}

const fixture = join(temporary, 'fixture.wav');
const dataSize = 48000 * 2 * 10;
const wav = Buffer.alloc(44 + dataSize);
wav.write('RIFF'); wav.writeUInt32LE(36 + dataSize, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
writeFileSync(fixture, wav);
// A second file, dropped on the window rather than chosen, and where the queue's M3U is saved.
const dropped = join(temporary, 'dropped.wav');
writeFileSync(dropped, wav);
const playlist = join(temporary, 'queue.m3u8');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: playlist });

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer exited:', details.reason); finish(1);
  });
  window.webContents.once('did-finish-load', async () => {
    try {
      const prefs = window.webContents.getLastWebPreferences();
      assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
      const result = await window.webContents.executeJavaScript(`(async () => {
        const bridge = window.squiggly;
        if (!bridge) throw new Error('Preload bridge missing');
        if (typeof require !== 'undefined' || typeof process !== 'undefined') throw new Error('Node leaked into renderer');
        const until = async predicate => {
          const current = await bridge.snapshot();
          if (predicate(current)) return current;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { unsubscribe(); reject(new Error('Snapshot condition timed out')); }, 5000);
            const unsubscribe = bridge.subscribe(next => { if (predicate(next)) { clearTimeout(timer); unsubscribe(); resolve(next); } });
          });
        };
        const ready = await until(s => s.player.engine !== 'starting');
        if (ready.player.engine !== 'ready') throw new Error(ready.player.error);
        // Keep on this device: an empty list at first, and refusals for what isn't there.
        const kept = await bridge.kept.state();
        if (!Array.isArray(kept.containers) || kept.containers.length || typeof kept.dir !== 'string') throw new Error('Unexpected kept state');
        const forgot = await bridge.kept.forget('album', 'not-kept');
        if (forgot.ok) throw new Error('Forgot a record that was never kept');
        const badKeep = await bridge.kept.keep({ kind: 'artist', id: 'x', name: 'x', artist: null, coverArt: null, tracks: [] });
        if (badKeep.ok) throw new Error('Invalid keep request accepted');
        const invalid = await bridge.command({type:'volume',percent:101});
        if (invalid.ok) throw new Error('Invalid IPC command accepted');
        // A File the page made has no path on disk: the preload finds none, and nothing opens.
        const made = await bridge.openDropped([new File(['x'], 'a.flac')], 'queue');
        if (made.ok || !/Nothing dropped could be played/.test(made.error)) throw new Error('A File made by the page opened: ' + JSON.stringify(made));
        if ('filePath' in bridge || 'openPaths' in bridge) throw new Error('Paths are offered to the page');
        const opened = await bridge.openFiles();
        if (!opened.ok) throw new Error(opened.error);
        const playing = await until(s => s.player.playing && s.player.audio.decoderRate === 48000);
        const paused = await bridge.command({type:'pause'});
        if (!paused.ok) throw new Error(paused.error);
        await until(s => !s.player.playing);
        const measured = await until(s => s.diagnostics.processes.length > 0);
        // A file dropped on the window joins the queue, and the queue's M3U names both files by
        // their own paths, which only the main process knows.
        const drop = await bridge.openPaths([${JSON.stringify(dropped)}], 'queue');
        if (!drop.ok) throw new Error(drop.error);
        const both = await until(s => s.player.queue.length === 2);
        const saved = await bridge.saveM3u('Smoke', both.player.queue.map(t => ({ id: t.id, local: true, title: t.title, artist: t.artist, album: t.album, duration: t.duration, path: null, suffix: t.sourceFormat })));
        if (!saved.ok) throw new Error(saved.error);
        return { engine: playing.player.engine, decoderRate: playing.player.audio.decoderRate,
          outputBackend: playing.player.audio.outputBackend, queue: playing.player.queue.length,
          startupMs: measured.diagnostics.startupMs, processCount: measured.diagnostics.processes.length,
          nodeIsolated: true, invalidCommandRejected: !invalid.ok, madeFileRefused: !made.ok };
      })()`);
      assert.equal(result.outputBackend, 'null');
      assert.equal(result.queue, 1);
      const lines = readFileSync(playlist, 'utf8').split('\n');
      assert.ok(lines.includes(fixture), 'The chosen file is in the M3U by its path');
      assert.ok(lines.includes(dropped), 'The dropped file is in the M3U by its path');
      console.log('Desktop integration passed:', JSON.stringify(result));
      finish(0);
    } catch (error) { console.error(error); finish(1); }
  });
});
import(pathToFileURL(join(__dirname, '../out/main/index.js')).href).catch(error => { console.error(error); finish(1); });
