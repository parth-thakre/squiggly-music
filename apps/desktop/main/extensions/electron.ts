import { app, clipboard, ipcMain, protocol, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Result } from '../../../../packages/core/contracts';
import { errorText, EXTENSION_SCHEME, ExtensionManager } from './manager';

// Connects the extension manager to Electron: IPC for the window, and the squiggly-ext://
// scheme that serves each extension's compiled renderer module.

// Must be registered before ready, in the same call as the app's other schemes. Module scripts
// are fetched with CORS, so the scheme needs corsEnabled and the responses allow any origin.
export const extensionScheme = {
  scheme: EXTENSION_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
} as const;

// esbuild runs a native binary, which can't be spawned from inside app.asar. Packaged builds
// unpack it (electron-builder asarUnpack) and point esbuild at the unpacked copy.
function useUnpackedEsbuild() {
  if (!app.isPackaged || process.env.ESBUILD_BINARY_PATH) return;
  const binary = process.platform === 'win32' ? 'esbuild.exe' : join('bin', 'esbuild');
  const path = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', `${process.platform}-${process.arch}`, binary);
  if (existsSync(path)) process.env.ESBUILD_BINARY_PATH = path;
}

const text = (value: unknown, limit = 256) => typeof value === 'string' && value.length > 0 && value.length <= limit ? value : null;
const invalid: Result = { ok: false, error: 'Invalid request.' };

export function startExtensions(deps: { configDir: string; assertSender(event: IpcMainInvokeEvent): void; windows(): WebContents[] }) {
  useUnpackedEsbuild();
  const manager = new ExtensionManager({ configDir: deps.configDir, trash: path => shell.trashItem(path) });
  // Handlers exist before the window loads; their answers wait for the first compile.
  const ready = (async () => {
    manager.subscribe(list => { for (const target of deps.windows()) if (!target.isDestroyed()) target.send('squiggly:extensions', list); });
    try { await manager.start(); } catch (error) { console.error('Extensions unavailable:', errorText(error)); }
  })();

  const handle = (channel: string, run: (value: unknown) => unknown) => ipcMain.handle(`squiggly:extensions:${channel}`, async (event, value) => {
    deps.assertSender(event);
    await ready;
    return run(value);
  });
  handle('list', () => manager.list());
  handle('open-dir', async () => { const error = await shell.openPath(manager.extensionsDir); return error ? { ok: false, error } : { ok: true, value: undefined }; });
  handle('remove', value => text(value) ? manager.remove(value as string) : invalid);
  handle('set-enabled', value => Array.isArray(value) && text(value[0]) && typeof value[1] === 'boolean' ? manager.setEnabled(value[0], value[1]) : invalid);
  handle('reload', () => manager.reload());
  // The window's own navigator.clipboard needs a permission the app doesn't grant.
  handle('clipboard', value => {
    if (typeof value !== 'string' || value.length > 1_000_000) return { ok: false, error: 'Invalid text.' };
    clipboard.writeText(value);
    return { ok: true, value: undefined };
  });

  // Serves the current renderer module of an enabled extension. Old URLs stop resolving on reload.
  protocol.handle(EXTENSION_SCHEME, async request => {
    await ready;
    const code = request.method === 'GET' ? manager.rendererModule(request.url) : null;
    const headers = { 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
    return code === null ? new Response(null, { status: 404, headers }) : new Response(code, { headers: { ...headers, 'content-type': 'text/javascript; charset=utf-8' } });
  });

  return { close: () => manager.close() };
}
