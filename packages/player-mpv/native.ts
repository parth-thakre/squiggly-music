import koffi from 'koffi';
import type { AudioDevice, AudioPath } from '../core/contracts';

// All FFI calls run in the dedicated player process. No audio samples enter JS.
// Uses libmpv's public client API, not an mpv executable or a browser audio element.
const MpvEvent = koffi.struct('squiggly_mpv_event', {
  event_id: 'int', error: 'int', reply_userdata: 'uint64_t', data: 'void *',
});
const EndFile = koffi.struct('squiggly_mpv_end_file', {
  // This prefix is also safe on client API 1.107, before playlist fields existed.
  reason: 'int', error: 'int',
});

export class NativePlayer {
  readonly clientApiVersion: string | null;
  readonly supportsStopKeepPlaylist: boolean;
  private library;
  private handle: unknown;
  private create;
  private initialize;
  private option;
  private setProperty;
  private getProperty;
  private free;
  private commandNative;
  private waitEvent;
  private destroy;

  constructor(libraryPath?: string) {
    const candidates = libraryPath ? [libraryPath] : process.platform === 'win32'
      ? ['mpv-2.dll', 'libmpv-2.dll'] : process.platform === 'darwin'
        ? ['libmpv.2.dylib', '/opt/homebrew/lib/libmpv.2.dylib', '/usr/local/lib/libmpv.2.dylib']
        : ['libmpv.so.2', 'libmpv.so.1'];
    let library: ReturnType<typeof koffi.load> | undefined;
    for (const candidate of candidates) {
      try { library = koffi.load(candidate); break; } catch { /* Try the next platform path. */ }
    }
    if (!library) throw new Error('libmpv could not be loaded. Install the libmpv runtime or set SQUIGGLY_LIBMPV_PATH, then restart the audio engine.');
    this.library = library;
    this.clientApiVersion = null;
    this.supportsStopKeepPlaylist = false;
    try {
      const version = BigInt(library.func('unsigned long mpv_client_api_version(void)')());
      const major = version >> 16n;
      const minor = version & 0xffffn;
      this.clientApiVersion = `${major}.${minor}`;
      // The stop keep-playlist flag was added with client API 1.108 (mpv 0.33).
      this.supportsStopKeepPlaylist = major > 1n || (major === 1n && minor >= 108n);
    } catch { /* Unknown runtimes use the compatible legacy stop path. */ }
    this.create = library.func('void *mpv_create(void)');
    this.initialize = library.func('int mpv_initialize(void *ctx)');
    this.option = library.func('int mpv_set_option_string(void *ctx, const char *name, const char *value)');
    this.setProperty = library.func('int mpv_set_property_string(void *ctx, const char *name, const char *value)');
    this.getProperty = library.func('void *mpv_get_property_string(void *ctx, const char *name)');
    this.free = library.func('void mpv_free(void *data)');
    this.commandNative = library.func('int mpv_command(void *ctx, const char **args)');
    this.waitEvent = library.func('void *mpv_wait_event(void *ctx, double timeout)');
    this.destroy = library.func('void mpv_terminate_destroy(void *ctx)');
    this.handle = this.create();
    if (!this.handle) throw new Error('libmpv could not create a player.');
    try {
      // Ignore user mpv configuration so no hidden DSP or scripts change the path.
      const options: Record<string, string> = {
        config: 'no', 'load-scripts': 'no', terminal: 'no', video: 'no',
        idle: 'yes', 'keep-open': 'no', 'gapless-audio': 'yes',
        replaygain: 'no', volume: '100', 'volume-max': '100',
        'audio-display': 'no',
      };
      for (const [name, value] of Object.entries(options)) {
        if (this.option(this.handle, name, value) < 0) throw new Error(`libmpv rejected required option: ${name}`);
      }
      // Only the smoke test may request a null output. Never used as an app fallback.
      if (process.env.SQUIGGLY_TEST_NULL_AUDIO === '1') {
        this.option(this.handle, 'ao', 'null');
        // The null output otherwise simulates a large device buffer. Keep its
        // timing deterministic enough for transport tests, not hardware claims.
        this.option(this.handle, 'ao-null-buffer', '0.01');
      }
      if (this.initialize(this.handle) < 0) throw new Error('libmpv initialization failed. Check audio-device availability.');
    } catch (error) { this.close(); throw error; }
  }

  property(name: string): string | null {
    const pointer = this.getProperty(this.handle, name);
    if (!pointer) return null;
    try { return koffi.decode(pointer, 'char', -1) as string; }
    finally { this.free(pointer); }
  }
  number(name: string): number | null {
    const value = this.property(name);
    if (value === null || value.trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  set(name: string, value: string) {
    if (this.setProperty(this.handle, name, value) < 0) throw new Error(`Audio engine rejected ${name}.`);
  }
  command(...args: string[]) {
    if (this.commandNative(this.handle, [...args, null]) < 0) throw new Error(`Audio engine rejected ${args[0]}.`);
  }
  drainEvents(): { error: string | null; shutdown: boolean } {
    let error: string | null = null;
    // Limit work per tick even if a backend floods its event queue.
    for (let i = 0; i < 100; i++) {
      const pointer = this.waitEvent(this.handle, 0);
      if (!pointer) break;
      const event = koffi.decode(pointer, MpvEvent) as { event_id: number; data: unknown };
      if (event.event_id === 0) break;
      if (event.event_id === 1) return { error, shutdown: true };
      if (event.event_id === 7 && event.data) {
        const end = koffi.decode(event.data, EndFile) as { reason: number; error: number };
        if (end.reason === 4) error = `Playback failed in libmpv (code ${end.error}). Check the file, server connection, and output device.`;
      }
    }
    return { error, shutdown: false };
  }
  devices(): AudioDevice[] {
    const count = Math.min(this.number('audio-device-list/count') ?? 0, 128);
    const devices: AudioDevice[] = [];
    for (let i = 0; i < count; i++) {
      const name = this.property(`audio-device-list/${i}/name`);
      if (name) devices.push({ name, description: this.property(`audio-device-list/${i}/description`) ?? name });
    }
    return devices;
  }
  audio(): AudioPath {
    return {
      codec: this.property('audio-codec-name'),
      decoderRate: this.number('audio-params/samplerate'),
      decoderFormat: this.property('audio-params/format'),
      decoderChannels: this.property('audio-params/hr-channels'),
      outputRate: this.number('audio-out-params/samplerate'),
      outputFormat: this.property('audio-out-params/format'),
      outputChannels: this.property('audio-out-params/hr-channels'),
      outputBackend: this.property('current-ao'),
      requestedDevice: this.property('audio-device') ?? 'auto',
      replayGain: this.property('options/replaygain'),
      filters: this.property('af'),
      bufferSeconds: this.number('demuxer-cache-duration'),
      streamBytesPerSecond: this.number('cache-speed'),
      buffering: this.property('paused-for-cache') === 'yes',
    };
  }
  close() {
    if (this.handle) { this.destroy(this.handle); this.handle = null; }
    // The dedicated process owns the library for its lifetime. Avoid dlclose while
    // native backend thread-local destructors may still reference library code.
    void this.library;
  }
}
