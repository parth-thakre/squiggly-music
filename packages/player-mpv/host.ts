import { randomBytes } from 'node:crypto';
import { emptyAudio, emptyPlayer } from '../core/contracts';
import { NativePlayer } from './native';
import { clearPlayerSession } from './session';
import { editQueue, QUEUE_LIMIT } from './queue';
import type { HostMessage, HostRequest, PlayableTrack } from './protocol';

// A standalone Node process keeps Chromium and its native libraries out of this
// address space. Do not move this binding into Electron's main or utility process.
let native: NativePlayer | null = null;
let player = emptyPlayer();
let clientApiVersion: string | null = null;
// Each queue entry carries an id, unique within the queue and kept through moves, so two
// copies of one song stay distinguishable. The random prefix keeps ids from an earlier host
// process from matching entries in this one.
interface Entry extends PlayableTrack { entry: string }
const entryPrefix = randomBytes(3).toString('hex');
let entrySequence = 0;
const toEntry = (item: PlayableTrack): Entry => ({ ...item, entry: `${entryPrefix}.${(++entrySequence).toString(36)}` });
let playableQueue: Entry[] = [];
// The snapshot's queue and entry ids always come from the private list, in one place.
function publishQueue() {
  player.queue = playableQueue.map(item => item.track);
  player.entryIds = playableQueue.map(item => item.entry);
}
let reloadPlaylistAfterStop = false;
// The exclusive-output option last accepted by mpv. Requested, not verified.
let exclusive = false;
// A restored queue seeks once its entry is loaded and seekable. Changing the track or position cancels it.
let pendingSeek: { id: string; seconds: number; polls: number } | null = null;
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
      replayGain: player.audio.replayGain, filters: player.audio.filters, exclusiveRequested: player.audio.exclusiveRequested },
  };
}
const exclusiveError = 'The audio output rejected exclusive mode. Output stays shared with the system mixer.';
// Exclusive access is an AO open-time flag, so a loaded file needs its output reopened.
// Windows WASAPI and macOS CoreAudio honor it. On Linux, mpv's ALSA and PulseAudio outputs
// ignore it and PipeWire support depends on the mpv build, so it may change nothing there.
// Acceptance by mpv does not prove the OS granted exclusive access; snapshots report the request only.
function applyExclusive(on: boolean) {
  if (!native) return;
  try {
    native.set('audio-exclusive', on ? 'yes' : 'no');
    if (native.property('idle-active') === 'no') native.command('ao-reload');
    exclusive = on;
  } catch {
    try {
      native.set('audio-exclusive', exclusive ? 'yes' : 'no');
      if (native.property('idle-active') === 'no') native.command('ao-reload');
    } catch { /* The original error below is the actionable one. */ }
    throw new Error(on ? exclusiveError : 'The audio output could not leave exclusive mode. Restart the audio engine.');
  }
}
function restoreSeek() {
  const seek = pendingSeek;
  if (!native || !seek) return;
  // About ten seconds of polls; slow servers may not have opened the stream yet.
  if (++seek.polls > 40) { pendingSeek = null; player.error = 'Could not restore the saved position. The song starts from the beginning.'; return; }
  if (player.queue[player.currentIndex]?.id !== seek.id || native.property('seekable') !== 'yes') return;
  try { native.command('seek', String(seek.seconds), 'absolute+exact'); pendingSeek = null; }
  catch { /* Not seekable yet. Retry on the next poll. */ }
}

function loadPlayableQueue() {
  if (!native) return;
  for (const [index, item] of playableQueue.entries()) {
    native.command('loadfile', item.location, index === 0 ? 'replace' : 'append');
  }
  reloadPlaylistAfterStop = false;
}
function failEngine(message: string) {
  clearInterval(timer);
  resetTrack(); player.engine = 'crashed'; player.error = message;
  exiting = true;
  // Publish before mpv_terminate_destroy: native teardown may block indefinitely.
  publish();
  // Main also enforces a process deadline after receiving the crash snapshot.
  setTimeout(() => exit(1), 1000).unref();
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
  if (process.env.SQUIGGLY_AUDIO_EXCLUSIVE === '1') {
    try { applyExclusive(true); } catch (error) { exclusive = false; player.error = error instanceof Error ? error.message : exclusiveError; }
  }
} catch (error) {
  player.engine = 'unavailable';
  player.error = error instanceof Error ? error.message : 'Audio engine unavailable.';
}
publish();

port.on('message', ({ data: { id, action } }: { data: HostRequest }) => {
  try {
    if (!native) throw new Error(player.error ?? 'Audio engine unavailable.');
    player.error = null;
    if (['queue', 'queue-jump', 'clear-session', 'stop', 'seek', 'next', 'previous', 'select'].includes(action.type)) pendingSeek = null;
    switch (action.type) {
      case 'queue': {
        if (!action.tracks.length) throw new Error('Choose at least one track.');
        if (action.tracks.length > QUEUE_LIMIT) throw new Error(`The queue holds up to ${QUEUE_LIMIT.toLocaleString('en-US')} songs.`);
        const start = action.startIndex ?? 0;
        if (!Number.isInteger(start) || start < 0 || start >= action.tracks.length) throw new Error('Choose a track in the queue.');
        native.command('stop');
        native.command('playlist-clear');
        resetTrack();
        // Pause before loading so a restored queue never plays its first moments.
        if (action.paused) native.set('pause', 'yes');
        // Retain locations only inside the isolated host so old mpv versions can
        // rebuild the native playlist after their argument-less stop command.
        playableQueue = action.tracks.map(toEntry);
        loadPlayableQueue();
        // The first loadfile only queues a load; moving now starts at the chosen entry instead.
        if (start > 0) native.set('playlist-pos', String(start));
        publishQueue();
        if (!action.paused) native.set('pause', 'no');
        const seconds = action.startPosition ?? 0;
        if (Number.isFinite(seconds) && seconds > 0) pendingSeek = { id: action.tracks[start].track.id, seconds, polls: 0 };
        break;
      }
      case 'queue-add': case 'queue-move': case 'queue-remove': case 'queue-clear':
        try { editQueue(native, playableQueue, !reloadPlaylistAfterStop, action.type === 'queue-add' ? { ...action, tracks: action.tracks.map(toEntry) } : action); }
        finally {
          publishQueue();
          player.currentIndex = reloadPlaylistAfterStop ? -1 : native.number('playlist-pos') ?? -1;
        }
        break;
      case 'exclusive': applyExclusive(action.on); break;
      case 'clear-session':
        // Discard both mpv's playlist and the private fallback copy used by
        // older clients after stop, while retaining engine-level settings.
        playableQueue = [];
        reloadPlaylistAfterStop = false;
        clearPlayerSession(native, player);
        publishQueue(); resetTrack();
        break;
      case 'play':
        if (!player.queue.length) throw new Error('Add music to the queue first.');
        if (reloadPlaylistAfterStop) loadPlayableQueue();
        if (native.property('idle-active') === 'yes') native.set('playlist-pos', '0');
        native.set('pause', 'no'); break;
      case 'pause': native.set('pause', 'yes'); break;
      case 'stop':
        if (native.supportsStopKeepPlaylist) native.command('stop', 'keep-playlist');
        else { native.command('stop'); reloadPlaylistAfterStop = true; }
        resetTrack(); break;
      case 'seek': {
        const nativeIndex = native.number('playlist-pos') ?? -1;
        if (nativeIndex !== action.queueIndex || player.queue[action.queueIndex]?.id !== action.trackId
          || (action.entryId !== undefined && playableQueue[action.queueIndex]?.entry !== action.entryId)) {
          throw new Error('The track changed before the seek completed. Try again.');
        }
        native.command('seek', String(action.seconds), 'absolute+exact'); break;
      }
      case 'volume': native.set('volume', String(action.percent)); break;
      case 'device': native.set('audio-device', action.id); break;
      case 'next': native.command('playlist-next', 'weak'); break;
      case 'previous': native.command('playlist-prev', 'weak'); break;
      case 'queue-jump': {
        // By entry, not song id: in [A, B, A] the second A is a different entry from the first.
        if (playableQueue[action.index]?.entry !== action.entryId) throw new Error('The queue changed before that song could play. Try again.');
        if (reloadPlaylistAfterStop) loadPlayableQueue();
        native.set('playlist-pos', String(action.index)); native.set('pause', 'no'); break;
      }
      // Legacy selection by song id (first match). Queue clicks use queue-jump.
      case 'select': {
        const index = player.queue.findIndex(track => track.id === action.id);
        if (index < 0) throw new Error('Track is no longer in the queue.');
        if (reloadPlaylistAfterStop) loadPlayableQueue();
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
    restoreSeek();
    if (++deviceTicks % 20 === 0) player.devices = native.devices();
    publish();
  } catch {
    failEngine('Audio engine polling failed. Restart the audio engine.');
  }
}, 250);
process.on('SIGTERM', () => exit(exiting ? 1 : 0));
process.on('disconnect', () => exit(exiting ? 1 : 0));
