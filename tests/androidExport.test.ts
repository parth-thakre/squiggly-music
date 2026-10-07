import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { M3uEntry, Track } from '../packages/core/contracts';
import { buildM3u } from '../packages/core/m3u';

// Export as M3U in the Android app. Its WebView ignores downloads, so the page hands the file to
// the native side, which asks where to save it (SquigglyPlugin.kt's saveFile).
const saveFile = vi.fn<(options: { name: string; mimeType: string; text: string }) => Promise<{ saved: boolean }>>();
vi.mock('../apps/android/web/plugin', () => ({
  Squiggly: {
    saveFile: (options: { name: string; mimeType: string; text: string }) => saveFile(options),
    addListener: async () => ({ remove: async () => undefined }),
    loadAccount: async () => ({ canRemember: false, account: null }),
  },
}));
const { androidBridge } = await import('../apps/android/web/bridge');
const { exportM3u } = await import('../apps/desktop/renderer/src/app/exports');

const track = (extra: Partial<Track> = {}): Track => ({
  id: 's1', title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', duration: 562, source: 'navidrome', sourceFormat: 'flac',
  sourceSampleRate: 44100, sourceBitDepth: 16, path: 'Miles Davis/Kind of Blue/01 - So What.flac', ...extra,
});
const entry: M3uEntry = { id: 's1', local: false, title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', duration: 562, path: 'Miles Davis/Kind of Blue/01 - So What.flac', suffix: 'flac' };

beforeEach(() => { saveFile.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('saving a playlist file on Android', () => {
  it('sends the file to the document picker, named after the playlist', async () => {
    saveFile.mockResolvedValue({ saved: true });
    expect(await androidBridge.saveM3u('Road Mix', [entry])).toEqual({ ok: true, value: undefined });
    expect(saveFile).toHaveBeenCalledWith({ name: 'Road Mix.m3u8', mimeType: 'audio/x-mpegurl', text: buildM3u([entry], 'Road Mix') });
  });

  it('treats cancelling as no error, and shows why the native side refused', async () => {
    saveFile.mockResolvedValue({ saved: false });
    expect(await androidBridge.saveM3u('Road Mix', [entry])).toEqual({ ok: true, value: undefined });
    saveFile.mockRejectedValue(new Error('Could not save the playlist file. Check that there is room for it.'));
    expect(await androidBridge.saveM3u('Road Mix', [entry])).toEqual({ ok: false, error: 'Could not save the playlist file. Check that there is room for it.' });
  });

  it('checks what it is given before anything reaches the native side', async () => {
    const invalid: [string, unknown][] = [['', [entry]], ['Road Mix', [{ ...entry, duration: -1 }]], ['Road Mix', [{ ...entry, path: 'x'.repeat(4097) }]], ['Road Mix', 'nope']];
    for (const [name, entries] of invalid) {
      expect(await androidBridge.saveM3u(name, entries as M3uEntry[])).toEqual({ ok: false, error: 'Invalid playlist file.' });
    }
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('is what Export as M3U uses in the app, rather than a download the WebView would drop', async () => {
    saveFile.mockResolvedValue({ saved: true });
    vi.stubGlobal('window', { squigglyAndroid: androidBridge });
    expect(await exportM3u('  Road Mix  ', [track()])).toBeNull();
    expect(saveFile).toHaveBeenCalledWith({ name: 'Road Mix.m3u8', mimeType: 'audio/x-mpegurl', text: buildM3u([entry], 'Road Mix') });
    saveFile.mockRejectedValue(new Error('This phone has nowhere to save files.'));
    expect(await exportM3u('Road Mix', [track()])).toBe('This phone has nowhere to save files.');
  });
});
