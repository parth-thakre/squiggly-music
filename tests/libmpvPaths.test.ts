import { afterEach, describe, expect, it, vi } from 'vitest';
import { libmpvCandidates, libmpvMissing } from '../packages/player-mpv/libraries';

afterEach(() => { vi.doUnmock('koffi'); vi.unstubAllGlobals(); vi.resetModules(); });

describe('where libmpv is looked for', () => {
  it('tries Homebrew and MacPorts on macOS, after the loader\'s own search', () => {
    expect(libmpvCandidates('darwin')).toEqual(['libmpv.2.dylib', '/opt/homebrew/lib/libmpv.2.dylib', '/usr/local/lib/libmpv.2.dylib', '/opt/local/lib/libmpv.2.dylib']);
  });
  it('keeps the other platforms as they were', () => {
    expect(libmpvCandidates('linux')).toEqual(['libmpv.so.2', 'libmpv.so.1']);
    expect(libmpvCandidates('win32')).toEqual(['mpv-2.dll', 'libmpv-2.dll']);
  });
  it('tries only an explicit path, and never falls back to a system copy', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) expect(libmpvCandidates(platform, '/x/libmpv.dylib')).toEqual(['/x/libmpv.dylib']);
  });
});

describe('what the deck says when libmpv is missing', () => {
  it('names brew install mpv on macOS', () => {
    expect(libmpvMissing('darwin')).toContain('brew install mpv');
    expect(libmpvMissing('darwin')).toContain('sudo port install mpv +libmpv');
  });
  it('blames the setting, not Homebrew, when an explicit path failed on macOS', () => {
    expect(libmpvMissing('darwin', '/nope')).toContain('SQUIGGLY_LIBMPV_PATH');
    expect(libmpvMissing('darwin', '/nope')).not.toContain('brew');
  });
  it('keeps the Windows and Linux message, with or without an explicit path', () => {
    const before = 'libmpv could not be loaded. Install the libmpv runtime or set SQUIGGLY_LIBMPV_PATH, then restart the audio engine.';
    for (const platform of ['linux', 'win32'] as const) {
      expect(libmpvMissing(platform)).toBe(before);
      expect(libmpvMissing(platform, '/x/libmpv-2.dll')).toBe(before);
    }
  });
  it('is plain text, with no exclamation marks or markup', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(libmpvMissing(platform)).not.toMatch(/[!`]/);
      expect(libmpvMissing(platform, '/x')).not.toMatch(/[!`]/);
    }
  });
  it('comes out of the real player on a Mac with no library', async () => {
    const tried: string[] = [];
    vi.doMock('koffi', () => ({ default: { struct: vi.fn(), decode: vi.fn(), load: (path: string) => { tried.push(path); throw new Error('image not found'); } } }));
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    const { NativePlayer } = await import('../packages/player-mpv/native');
    expect(() => new NativePlayer()).toThrow(/brew install mpv/);
    expect(tried).toEqual(libmpvCandidates('darwin'));
  });
});
