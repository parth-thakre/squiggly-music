// Where the audio host looks for libmpv, and what it says when it isn't there. Kept apart from
// native.ts, which loads Koffi, so the lists can be tested on any platform.

// An explicit path (SQUIGGLY_LIBMPV_PATH, or the one the packaged Windows build passes) is the only
// candidate. On macOS libmpv comes from Homebrew (/opt/homebrew on Apple silicon, /usr/local on
// Intel) or MacPorts (`sudo port install mpv +libmpv`), and only those absolute paths are tried:
// for a bare name dyld also searches the current directory, and the app isn't hardened, so a
// libmpv.2.dylib left wherever the app was started from would load.
export function libmpvCandidates(platform: NodeJS.Platform, explicit?: string): string[] {
  if (explicit) return [explicit];
  if (platform === 'win32') return ['mpv-2.dll', 'libmpv-2.dll'];
  if (platform === 'darwin') {
    return ['/opt/homebrew/lib/libmpv.2.dylib', '/usr/local/lib/libmpv.2.dylib', '/opt/local/lib/libmpv.2.dylib'];
  }
  return ['libmpv.so.2', 'libmpv.so.1'];
}

// Shown in the deck, so it says what to do, in plain words, with no markup. Windows and Linux keep
// their message: the packaged Windows app passes its bundled DLL as an explicit path, so naming the
// setting there would point at something the user never set. On macOS nothing sets it but the user.
export function libmpvMissing(platform: NodeJS.Platform, explicit?: string): string {
  if (platform === 'darwin') {
    return explicit
      ? 'libmpv could not be loaded from the path in SQUIGGLY_LIBMPV_PATH. Check that the file is there and is a libmpv library, then restart the audio engine.'
      : 'libmpv was not found. Install it with brew install mpv (or, with MacPorts, sudo port install mpv +libmpv), then restart the audio engine.';
  }
  return 'libmpv could not be loaded. Install the libmpv runtime or set SQUIGGLY_LIBMPV_PATH, then restart the audio engine.';
}
