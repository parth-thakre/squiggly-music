import { afterEach, describe, expect, it, vi } from 'vitest';

// updates.ts asks Electron whether the app is packaged and reads the platform and environment
// from process.
const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.unstubAllEnvs(); vi.doUnmock('electron'); vi.doUnmock('electron-updater'); vi.resetModules();
});

async function modeOn(os: NodeJS.Platform, { packaged = true, env = {} as Record<string, string> } = {}) {
  Object.defineProperty(process, 'platform', { value: os, configurable: true });
  for (const name of ['PORTABLE_EXECUTABLE_DIR', 'FLATPAK_ID', 'APPIMAGE']) vi.stubEnv(name, '');
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  // A fresh module each time, so each call sees its own mocked app.
  vi.resetModules();
  vi.doMock('electron', () => ({ app: { isPackaged: packaged, getVersion: () => '0.2.0' } }));
  vi.doMock('electron-updater', () => ({ default: { autoUpdater: {} } }));
  const { updateMode } = await import('../apps/desktop/main/updates');
  return updateMode();
}

describe('how each build updates', () => {
  it('installs itself only in the installed Windows app', async () => {
    expect(await modeOn('win32')).toBe('install');
    expect(await modeOn('win32', { env: { PORTABLE_EXECUTABLE_DIR: 'C:\\Temp' } })).toBe('notify');
  });
  it('tells RPM, deb, and AppImage users a version is out and leaves the install to them', async () => {
    expect(await modeOn('linux')).toBe('notify');
    expect(await modeOn('linux', { env: { APPIMAGE: '/home/me/Squiggly-Music-0.2.0-x86_64.AppImage' } })).toBe('notify');
  });
  // Squirrel.Mac, which electron-updater installs through, refuses an app that isn't code signed.
  it('only notifies on macOS, where the build is unsigned', async () => expect(await modeOn('darwin')).toBe('notify'));
  it('does nothing in development builds, or in a Flatpak that its store updates', async () => {
    expect(await modeOn('linux', { packaged: false })).toBe('off');
    expect(await modeOn('darwin', { packaged: false })).toBe('off');
    expect(await modeOn('win32', { packaged: false })).toBe('off');
    expect(await modeOn('linux', { env: { FLATPAK_ID: 'dev.squiggly.music' } })).toBe('off');
  });
});
