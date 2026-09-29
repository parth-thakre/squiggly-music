import { randomBytes } from 'node:crypto';
import { emptyAudio, emptyPlayer, type RepeatMode } from '../core/contracts';
import { shuffleOrder } from '../core/playOrder';
import { NativePlayer } from './native';
import { clearPlayerSession } from './session';
import { editQueue, QUEUE_LIMIT, shuffleQueue } from './queue';
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
// Internet radio stations are live streams (packages/core/stations.ts): no position to seek to,
// and no end for repeat one to start again from.
const isStationAt = (index: number) => playableQueue[index]?.track.source === 'station';
// mpv's prefetch-playlist opens the next entry's stream while this one ends (native.ts). A
// station opened early would play from what it sent then, minutes behind, rather than joining
// live when its turn comes, so while a station is anywhere in the queue nothing is opened early.
// It's set before a station reaches mpv's playlist, since mpv may open the next entry at once.
let prefetch = true;
function followPrefetch(queue: readonly PlayableTrack[]) {
  const want = !queue.some(item => item.track.source === 'station');
  if (!native || want === prefetch) return;
  native.set('prefetch-playlist', want ? 'yes' : 'no'); prefetch = want;
}
// After an edit that may have taken the last station out. If mpv refuses, it stays off.
const relaxPrefetch = () => { try { followPrefetch(playableQueue); } catch { /* Off is safe. */ } };
// What the station says is on, from its ICY StreamTitle. Unknown stays null.
function announced(title: string | null) {
  const text = title?.replace(/\s+/g, ' ').trim().slice(0, 500);
  return text || null;
}
// The snapshot's queue and entry ids always come from the private list, in one place.
function publishQueue() {
  player.queue = playableQueue.map(item => item.track);
  player.entryIds = playableQueue.map(item => item.entry);
}
let reloadPlaylistAfterStop = false;
// PlayerSnapshot.playId: it changes whenever an entry starts from the top (another entry, the same
// entry loaded again under repeat all with one song, a repeat-one loop, a jump to the entry playing)
// and never on a seek. mpv's loop-file goes back to the start by seeking, so a loop shows only as
// a seek the host didn't ask for, landing near 0.
let plays = 0;
let playEntry: string | undefined;
// The entry last noticed hasn't reported its start-file yet; when it does, that's the same play.
let startPending = false;
// Polls left in which a seek is the host's own (its seek command, a restored position, a jump).
let hostSeek = 0;
const newPlay = () => { player.playId = `${entryPrefix}.p${(++plays).toString(36)}`; };
function followPlay({ starts, seeks }: { starts: number; seeks: number }) {
  const entry = playableQueue[player.currentIndex]?.entry;
  if (entry !== playEntry) {
    playEntry = entry; startPending = false;
    if (!entry) return;
    newPlay();
    if (starts) starts--; else startPending = true;
  } else if (!entry) return;
  if (starts && startPending) { starts--; startPending = false; }
  if (starts) newPlay();
  else if (seeks && !hostSeek && loopFile === 'inf' && player.position < 2) newPlay();
}
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
  // Whatever plays next starts a new play, even the same entry.
  playEntry = undefined; startPending = false;
  player = { ...player, currentIndex: -1, playing: false, position: 0, duration: 0, stationTitle: null,
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
// Repeat is mpv's own looping, so the queue wraps (loop-playlist) or a song starts again
// (loop-file) without waiting on a snapshot. playlist-next and playlist-prev still move between
// entries under loop-file, so Next skips a repeating song. Neither option touches the signal.
// loop-file is off while a station plays, whatever the mode (followLoop): looping a live stream
// would only dial it again forever when it drops. loopFile is its value as last set.
let loopFile = 'no';
const loopFor = (mode: RepeatMode) => mode === 'one' && !isStationAt(player.currentIndex) ? 'inf' : 'no';
function applyRepeat(mode: RepeatMode) {
  if (!native) return;
  const previous = player.repeat;
  try {
    native.set('loop-file', loopFor(mode)); loopFile = loopFor(mode);
    native.set('loop-playlist', mode === 'all' ? 'inf' : 'no');
    player.repeat = mode;
  } catch {
    try {
      native.set('loop-file', loopFor(previous)); loopFile = loopFor(previous);
      native.set('loop-playlist', previous === 'all' ? 'inf' : 'no');
    } catch { /* The error below is the one to act on. */ }
    throw new Error('The audio engine could not change the repeat mode.');
  }
}
// Each poll: loop-file follows the entry playing, off for a station and back on after it.
function followLoop() {
  const want = loopFor(player.repeat);
  if (!native || want === loopFile) return;
  try { native.set('loop-file', want); loopFile = want; } catch { /* Tried again on the next poll. */ }
}
function restoreSeek() {
  const seek = pendingSeek;
  if (!native || !seek) return;
  // About ten seconds of polls; slow servers may not have opened the stream yet.
  if (++seek.polls > 40) { pendingSeek = null; player.error = 'Could not restore the saved position. The song starts from the beginning.'; return; }
  if (player.queue[player.currentIndex]?.id !== seek.id || native.property('seekable') !== 'yes') return;
  try { native.command('seek', String(seek.seconds), 'absolute+exact'); pendingSeek = null; hostSeek = 4; }
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
  // The saved output device, while it's connected. An unplugged one leaves the system default
  // rather than an output that can't open.
  const device = process.env.SQUIGGLY_AUDIO_DEVICE;
  if (device && device !== 'auto' && player.devices.some(d => d.name === device)) native.set('audio-device', device);
  if (process.env.SQUIGGLY_AUDIO_EXCLUSIVE === '1') {
    try { applyExclusive(true); } catch (error) { exclusive = false; player.error = error instanceof Error ? error.message : exclusiveError; }
  }
  // The saved queue modes (main/index.ts keeps them). The queue starts empty, so nothing to shuffle yet.
  const repeat = process.env.SQUIGGLY_REPEAT;
  if (repeat === 'all' || repeat === 'one') {
    try { applyRepeat(repeat); } catch (error) { player.error = error instanceof Error ? error.message : null; }
  }
  player.shuffle = process.env.SQUIGGLY_SHUFFLE === '1';
} catch (error) {
  player.engine = 'unavailable';
  player.error = error instanceof Error ? error.message : 'Audio engine unavailable.';
}
publish();

port.on('message', ({ data: { id, action } }: { data: HostRequest }) => {
  try {
    if (!native) throw new Error(player.error ?? 'Audio engine unavailable.');
    player.error = null;
    if (['queue', 'queue-jump', 'clear-session', 'stop', 'seek', 'next', 'previous'].includes(action.type)) pendingSeek = null;
    switch (action.type) {
      case 'queue': {
        if (!action.tracks.length) throw new Error('Choose at least one track.');
        if (action.tracks.length > QUEUE_LIMIT) throw new Error(`The queue holds up to ${QUEUE_LIMIT.toLocaleString('en-US')} songs.`);
        const start = action.startIndex ?? 0;
        if (!Number.isInteger(start) || start < 0 || start >= action.tracks.length) throw new Error('Choose a track in the queue.');
        followPrefetch(action.tracks);
        native.command('stop');
        native.command('playlist-clear');
        resetTrack();
        // Pause before loading so a restored queue never plays its first moments.
        if (action.paused) native.set('pause', 'yes');
        // Retain locations only inside the isolated host so old mpv versions can
        // rebuild the native playlist after their argument-less stop command.
        // With shuffle on, a new list plays from the chosen song with the rest in random order, as
        // in the browser and on Android. Radio and a restored queue keep their order (ordered).
        const order = player.shuffle && !action.ordered ? shuffleOrder(action.tracks.length, start) : null;
        playableQueue = (order ? order.map(index => action.tracks[index]) : action.tracks).map(toEntry);
        loadPlayableQueue();
        // The first loadfile only queues a load; moving now starts at the chosen entry instead.
        if (start > 0) native.set('playlist-pos', String(start));
        publishQueue();
        if (!action.paused) native.set('pause', 'no');
        const seconds = action.startPosition ?? 0;
        if (Number.isFinite(seconds) && seconds > 0 && !isStationAt(start)) pendingSeek = { id: action.tracks[start].track.id, seconds, polls: 0 };
        break;
      }
      case 'queue-add': case 'queue-move': case 'queue-remove': case 'queue-clear':
        if (action.type === 'queue-add') followPrefetch([...playableQueue, ...action.tracks]);
        try { editQueue(native, playableQueue, !reloadPlaylistAfterStop, action.type === 'queue-add' ? { ...action, tracks: action.tracks.map(toEntry) } : action); }
        finally {
          publishQueue(); relaxPrefetch();
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
        publishQueue(); resetTrack(); relaxPrefetch();
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
        // A station is live: there is no position to seek to, so the seek does nothing.
        if (isStationAt(action.queueIndex)) break;
        native.command('seek', String(action.seconds), 'absolute+exact'); hostSeek = 4; break;
      }
      case 'volume': native.set('volume', String(action.percent)); break;
      case 'device': native.set('audio-device', action.id); break;
      case 'next': native.command('playlist-next', 'weak'); break;
      case 'previous': native.command('playlist-prev', 'weak'); break;
      case 'queue-jump': {
        // By entry, not song id: in [A, B, A] the second A is a different entry from the first.
        if (playableQueue[action.index]?.entry !== action.entryId) throw new Error('The queue changed before that song could play. Try again.');
        if (reloadPlaylistAfterStop) loadPlayableQueue();
        // The entry playing starts over, a new play. (Newer mpv ignores playlist-pos set to its
        // current value; older mpv reloads the file.)
        else if (native.number('playlist-pos') === action.index) {
          // A station has no start to go back to; it plays on.
          if (!isStationAt(action.index)) { native.command('seek', '0', 'absolute+exact'); hostSeek = 4; newPlay(); }
          native.set('pause', 'no'); break;
        }
        native.set('playlist-pos', String(action.index)); native.set('pause', 'no'); break;
      }
      case 'repeat': applyRepeat(action.mode); break;
      case 'shuffle':
        // Turning shuffle on reorders what's left once. Turning it off leaves the queue as it is:
        // the order from before isn't kept, since edits made while shuffled (adds, moves, removes)
        // would leave no clear order to go back to. The same holds in the browser and on Android.
        if (action.on && !player.shuffle) {
          try { shuffleQueue(native, playableQueue, !reloadPlaylistAfterStop); }
          finally {
            publishQueue();
            player.currentIndex = reloadPlaylistAfterStop ? -1 : native.number('playlist-pos') ?? -1;
          }
        }
        player.shuffle = action.on; break;
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
    player.stationTitle = isStationAt(player.currentIndex) ? announced(native.property('metadata/by-key/icy-title')) : null;
    followLoop();
    followPlay(events);
    if (hostSeek) hostSeek--;
    restoreSeek();
    if (++deviceTicks % 20 === 0) player.devices = native.devices();
    publish();
  } catch {
    failEngine('Audio engine polling failed. Restart the audio engine.');
  }
}, 250);
process.on('SIGTERM', () => exit(exiting ? 1 : 0));
process.on('disconnect', () => exit(exiting ? 1 : 0));
