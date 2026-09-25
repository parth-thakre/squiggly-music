import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { ConfigFolder, configDirectory } from './config';

// Connects the config folder (keybindings.json and themes/) to the windows: two IPC handlers,
// and a push on the squiggly:config channel whenever what the files contain changes.
export function startConfigFolder(deps: { assertSender(event: IpcMainInvokeEvent): void; windows(): WebContents[] }) {
  const dir = configDirectory();
  const config = new ConfigFolder(dir);
  // Handlers exist before the window loads; their answers wait for the first read.
  const ready = (async () => {
    try { await config.start(); } catch (error) { console.error('Config folder unavailable:', error instanceof Error ? error.message : String(error)); }
    config.subscribe(files => { for (const target of deps.windows()) if (!target.isDestroyed()) target.send('squiggly:config', files); });
  })();
  const handle = (channel: string, run: () => unknown) => ipcMain.handle(`squiggly:${channel}`, async event => {
    deps.assertSender(event);
    await ready;
    return run();
  });
  handle('config:read', () => config.read());
  handle('config:open-dir', async () => { const error = await shell.openPath(dir); return error ? { ok: false, error } : { ok: true, value: undefined }; });
  return { dir, close: () => config.close() };
}
