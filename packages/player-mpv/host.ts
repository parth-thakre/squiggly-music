import { emptyAudio, emptyPlayer } from '../core/contracts';
import { NativePlayer } from './native';
import type { HostMessage, HostRequest } from './protocol';

// A standalone Node process keeps Chromium and its native libraries out of this
// address space. Do not move this binding into Electron's main or utility process.
let native: NativePlayer | null = null;
let player = emptyPlayer();
let clientApiVersion: string | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let exiting = false;
let snapshotInFlight = false;
let latestSnapshot: Extract<HostMessage, { type: 'snapshot' }> | null = null;
function exit(code: number) {
  clearInterval(timer); native?.close(); native = null; process.exit(code);
}
function flushSnapshot() {
  if (snapshotInFlight || !latestSnapshot) return;
  const message = latestSnapshot; latestSnapshot = null;
  snapshotInFlight = true;
  sendMessage(message, () => {
    snapshotInFlight = false;
    if (latestSnapshot) flushSnapshot();
    else if (exiting) exit(1);
  });
}
function sendMessage(message: HostMessage, sent?: () => void) {
  if (!process.connected || !process.send) { exit(1); return; }
  try {
    // Wait for the callback even when send returns true. A false return also
    // means the channel is backed up, not that this message should be retried.
    process.send(message, error => {
      if (error) { latestSnapshot = null; exit(1); return; }
      sent?.();
    });
  } catch { latestSnapshot = null; exit(1); }
}
const port = {
  postMessage: (message: HostMessage) => {
    if (message.type === 'snapshot') { latestSnapshot = message; flushSnapshot(); }
    else sendMessage(message); // Replies never compete for the latest-snapshot slot.
  },
  on: (_event: 'message', callback: (event: { data: HostRequest }) => void) => process.on('message', data => callback({ data: data as HostRequest })),
};
function resetTrack() {
  player = { ...player, currentIndex: -1, playing: false, position: 0, duration: 0,
    audio: { ...emptyAudio(), requestedDevice: player.audio.requestedDevice,
      replayGain: player.audio.replayGain, filters: player.audio.filters },
  };
}
function failEngine(message: string) {
  clearInterval(timer); native?.close(); native = null;
  resetTrack(); player.engine = 'crashed'; player.error = message;
  exiting = true;
  // Give the final snapshot a chance to flush, but still exit if IPC is blocked.
  setTimeout(() => exit(1), 1000).unref();
  publish();
}
let deviceTicks = 0;
let sampledAt = performance.now();
let cpu = process.cpuUsage();
const publish = () => {
  const now = performance.now(); const delta = process.cpuUsage(cpu); cpu = process.cpuUsage();
  const elapsed = now - sampledAt; sampledAt = now;
  port.postMessage({ type: 'snapshot', player: { ...player }, clientApiVersion, resources: {
    cpuPercent: elapsed > 0 ? (delta.user + delta.system) / (elapsed * 10) : 0,
    memoryMB: process.memoryUsage.rss() / 1024 / 1024,
  } });
};
try {
  native = new NativePlayer(process.env.SQUIGGLY_LIBMPV_PATH);
  clientApiVersion = native.clientApiVersion;
  player.engine = 'ready';
  player.devices = native.devices();
} catch (error) {
  player.engine = 'unavailable';
  player.error = error instanceof Error ? error.message : 'Audio engine unavailable.';
}
publish();

port.on('message', ({ data: { id, action } }: { data: HostRequest }) => {
  try {
    if (!native) throw new Error(player.error ?? 'Audio engine unavailable.');
    player.error = null;
    switch (action.type) {
      case 'queue': {
        if (!action.tracks.length) throw new Error('Choose at least one track.');
        native.command('stop');
        native.command('playlist-clear');
        resetTrack();
        // One native playlist lets libmpv prepare the next track without a JS EOF handoff.
        for (const [index, item] of action.tracks.entries()) {
          native.command('loadfile', item.location, index === 0 ? 'replace' : 'append');
        }
        player.queue = action.tracks.map(item => item.track);
        native.set('pause', 'no');
        break;
      }
      case 'play':
        if (!player.queue.length) throw new Error('Add music to the queue first.');
        if (native.property('idle-active') === 'yes') native.set('playlist-pos', '0');
        native.set('pause', 'no'); break;
      case 'pause': native.set('pause', 'yes'); break;
      case 'stop': native.command('stop', 'keep-playlist'); break;
      case 'seek': native.command('seek', String(action.seconds), 'absolute+exact'); break;
      case 'volume': native.set('volume', String(action.percent)); break;
      case 'device': native.set('audio-device', action.id); break;
      case 'next': native.command('playlist-next', 'weak'); break;
      case 'previous': native.command('playlist-prev', 'weak'); break;
      case 'select': {
        const index = player.queue.findIndex(track => track.id === action.id);
        if (index < 0) throw new Error('Track is no longer in the queue.');
        native.set('playlist-pos', String(index)); native.set('pause', 'no'); break;
      }
      case 'restart': throw new Error('Restart must be handled by the desktop process.');
    }
    port.postMessage({ type: 'reply', id, error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Player command failed.';
    player.error = message;
    port.postMessage({ type: 'reply', id, error: message });
  }
  publish();
});

// A bounded four-Hz snapshot. Progress interpolation belongs in the seek control.
timer = setInterval(() => {
  if (!native) return;
  try {
    const events = native.drainEvents();
    if (events.shutdown) { failEngine('The libmpv core shut down. Restart the audio engine.'); return; }
    if (events.error) player.error = events.error;
    player = {
      ...player,
      playing: native.property('pause') === 'no' && native.property('idle-active') === 'no',
      position: native.number('time-pos') ?? 0,
      duration: native.number('duration') ?? 0,
      volume: native.number('volume') ?? 100,
      currentIndex: native.number('playlist-pos') ?? -1,
      audio: native.audio(),
    };
    if (++deviceTicks % 20 === 0) player.devices = native.devices();
    publish();
  } catch {
    failEngine('Audio engine polling failed. Restart the audio engine.');
  }
}, 250);
process.on('SIGTERM', () => exit(exiting ? 1 : 0));
process.on('disconnect', () => exit(exiting ? 1 : 0));
