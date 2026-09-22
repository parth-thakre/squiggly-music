import { emptyPlayer } from '../core/contracts';
import { NativePlayer } from './native';
import type { HostMessage, HostRequest } from './protocol';

// A standalone Node process keeps Chromium and its native libraries out of this
// address space. Do not move this binding into Electron's main or utility process.
const port = {
  postMessage: (message: HostMessage) => process.send?.(message),
  on: (_event: 'message', callback: (event: { data: HostRequest }) => void) => process.on('message', data => callback({ data: data as HostRequest })),
};
let native: NativePlayer | null = null;
let player = emptyPlayer();
let deviceTicks = 0;
let sampledAt = performance.now();
let cpu = process.cpuUsage();
const publish = () => {
  const now = performance.now(); const delta = process.cpuUsage(cpu); cpu = process.cpuUsage();
  const elapsed = now - sampledAt; sampledAt = now;
  port.postMessage({ type: 'snapshot', player, resources: {
    cpuPercent: elapsed > 0 ? (delta.user + delta.system) / (elapsed * 10) : 0,
    memoryMB: process.memoryUsage.rss() / 1024 / 1024,
  } });
};
try {
  native = new NativePlayer(process.env.SQUIGGLY_LIBMPV_PATH);
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
      case 'stop': native.command('stop'); break;
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
const timer = setInterval(() => {
  if (!native) return;
  try {
    const error = native.drainEvents();
    if (error) player.error = error;
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
    player.engine = 'crashed'; player.playing = false;
    player.error = 'Audio engine polling failed. Restart the audio engine.';
    clearInterval(timer); publish();
  }
}, 250);
process.on('SIGTERM', () => { clearInterval(timer); native?.close(); process.exit(0); });
process.on('disconnect', () => { clearInterval(timer); native?.close(); process.exit(0); });
