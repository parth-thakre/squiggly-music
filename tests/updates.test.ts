import { afterEach, describe, expect, it, vi } from 'vitest';

// updates.ts asks Electron whether the app is packaged and reads the platform from process.
async function modeOn(platform: NodeJS.Platform, { packaged = true, portable = false } = {}) {
  vi.resetModules();
  vi.doMock('electron', () => ({ app: { isPackaged: packaged, getVersion: () => '0.2.0' } }));
  vi.doMock('electron-updater', () => ({ default: { autoUpdater: {} } }));
  vi.stubGlobal('process', { ...process, platform, env: { ...process.env, ...(portable ? { PORTABLE_EXECUTABLE_DIR: 'C:\\x' } : { PORTABLE_EXECUTABLE_DIR: undefined }) } });
  const { updateMode } = await import('../apps/desktop/main/updates');
  return updateMode();
}

afterEach(() => { vi.doUnmock('electron'); vi.doUnmock('electron-updater'); vi.unstubAllGlobals(); vi.resetModules(); });

describe('how each build updates', () => {
  it('installs on an installed Windows app', async () => expect(await modeOn('win32')).toBe('install'));
  it('only notifies from the portable exe', async () => expect(await modeOn('win32', { portable: true })).toBe('notify'));
  it('only notifies on Linux', async () => expect(await modeOn('linux')).toBe('notify'));
  // Squirrel.Mac, which electron-updater installs through, refuses an app that isn't code signed.
  it('only notifies on macOS, where the build is unsigned', async () => expect(await modeOn('darwin')).toBe('notify'));
  it('does nothing in development', async () => expect(await modeOn('darwin', { packaged: false })).toBe('off'));
});
