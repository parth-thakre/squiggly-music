// Native Electron integration test. Uses a private profile, a generated WAV, and
// the null audio sink. It never accesses a real music library or audio device.
const { app, dialog } = require('electron');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
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
const deadline = setTimeout(() => { console.error('Desktop smoke test timed out.'); app.exit(1); }, 15000);
app.on('will-quit', () => { clearTimeout(deadline); rmSync(temporary, { recursive: true, force: true }); });

const fixture = join(temporary, 'fixture.wav');
const dataSize = 48000 * 2 * 10;
const wav = Buffer.alloc(44 + dataSize);
wav.write('RIFF'); wav.writeUInt32LE(36 + dataSize, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
writeFileSync(fixture, wav);
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });

app.on('browser-window-created', (_event, window) => {
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer exited:', details.reason); app.exit(1);
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
        const invalid = await bridge.command({type:'volume',percent:101});
        if (invalid.ok) throw new Error('Invalid IPC command accepted');
        const opened = await bridge.openFiles();
        if (!opened.ok) throw new Error(opened.error);
        const playing = await until(s => s.player.playing && s.player.audio.decoderRate === 48000);
        const paused = await bridge.command({type:'pause'});
        if (!paused.ok) throw new Error(paused.error);
        await until(s => !s.player.playing);
        const measured = await until(s => s.diagnostics.processes.length > 0);
        return { engine: playing.player.engine, decoderRate: playing.player.audio.decoderRate,
          outputBackend: playing.player.audio.outputBackend, queue: playing.player.queue.length,
          startupMs: measured.diagnostics.startupMs, processCount: measured.diagnostics.processes.length,
          nodeIsolated: true, invalidCommandRejected: !invalid.ok };
      })()`);
      assert.equal(result.outputBackend, 'null');
      assert.equal(result.queue, 1);
      console.log('Desktop integration passed:', JSON.stringify(result));
      clearTimeout(deadline); app.quit();
    } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
  });
});
import(pathToFileURL(join(__dirname, '../out/main/index.js')).href).catch(error => { console.error(error); app.exit(1); });
