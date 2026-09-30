import { randomBytes } from 'node:crypto';
import { emptyAudio, emptyPlayer, listedDevice, type RepeatMode } from '../core/contracts';
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
  else if (seeks && !hostSeek && player.repeat === 'one' && player.position < 2) newPlay();
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
// Repeat is mpv's own looping, so the queue wraps (loop-playlist) or a song starts again
// (loop-file) without waiting on a snapshot. playlist-next and playlist-prev still move between
// entries under loop-file, so Next skips a repeating song. Neither option touches the signal.
function applyRepeat(mode: RepeatMode) {
  if (!native) return;
  const previous = player.repeat;
  try {
    native.set('loop-file', mode === 'one' ? 'inf' : 'no');
    native.set('loop-playlist', mode === 'all' ? 'inf' : 'no');
    player.repeat = mode;
  } catch {
    try {
      native.set('loop-file', previous === 'one' ? 'inf' : 'no');
      native.set('loop-playlist', previous === 'all' ? 'inf' : 'no');
    } catch { /* The error below is the one to act on. */ }
    throw new Error('The audio engine could not change the repeat mode.');
  }
}
// The output. chosenDevice is the one picked in Settings (main keeps it saved and passes it in).
// mpv's audio-device is that one, or the system default while `fallback` says why not: 'missing'
// (not listed: unplugged), which switches back once it's listed again, or 'failed' (listed, but its
// output wouldn't open), which stays on the default until it's chosen again or reconnects.
let chosenDevice = 'auto';
let fallback: 'missing' | 'failed' | null = null;
// After a switch to the system default, the song whose output failed plays again once, where it was.
let retryOnDefault = false;
let retriedEntry: string | undefined;
// A song played again starts at its position through mpv's start option, which applies to every
// file loaded after it, so it goes back to 'none' once that song (this entry) plays or is left.
let resumeStart: string | null = null;
// The host's own news about the output. It goes out as player.error, the one message the player
// shows, so like an error it goes with the next command; news that's only news goes after `polls`.
let notice: { text: string; polls: number } | null = null;
function showNotice(text: string, polls = Infinity) { notice = { text, polls }; player.error = text; }
function clearNotice() {
  if (notice && player.error === notice.text) player.error = null;
  notice = null;
}
function clearStart() {
  if (!resumeStart || !native) return;
  resumeStart = null; native.set('start', 'none');
}
function useDefault(why: 'missing' | 'failed') {
  const switching = !fallback;
  fallback = why;
  if (!switching || !native) return;
  // Setting audio-device reopens the output of a song that's playing, at its position (checked
  // with mpv 0.41), so no ao-reload.
  native.set('audio-device', 'auto');
  retryOnDefault = true;
  showNotice(`Your output device ${why === 'missing' ? 'was disconnected' : 'could not be opened'}. Playing through the system default.`);
}
// After each device list: fall back while the chosen output is gone, and go back when it returns.
function followDevices() {
  if (!native || chosenDevice === 'auto') return;
  const device = player.devices.find(d => d.name === chosenDevice);
  if (!device) useDefault('missing');
  else if (fallback === 'missing') {
    native.set('audio-device', chosenDevice); fallback = null;
    showNotice(`Switched back to ${device.description}.`, 20);
  }
}
// The index of mpv's playlist entry with this id, or null.
function entryIndex(id: number | null) {
  if (id === null || !native) return null;
  const count = native.number('playlist-count') ?? 0;
  for (let index = 0; index < count; index++) if (native.number(`playlist/${index}/id`) === id) return index;
  return null;
}
// A song ended because its output wouldn't open (on Windows, an unplugged device fails this way,
// and so does every song after it). The chosen output gives way to the system default, and the
// song plays again once from where it was: `before` is the last poll's index and position.
// True when it's playing again.
function recoverOutput(failed: { entry: number | null }, before: { index: number; position: number }) {
  if (!native) return false;
  if (chosenDevice !== 'auto') {
    player.devices = native.devices();
    useDefault(listedDevice(chosenDevice, player.devices) ? 'failed' : 'missing');
  }
  if (!retryOnDefault || reloadPlaylistAfterStop) return false;
  const index = entryIndex(failed.entry) ?? before.index;
  const item = playableQueue[index];
  // At most once per song, so an output that fails on the default as well can't loop.
  if (!item || item.entry === retriedEntry) return false;
  retryOnDefault = false; retriedEntry = item.entry;
  const seconds = index === before.index ? before.position : 0;
  if (seconds > 0) { native.set('start', String(seconds)); resumeStart = item.entry; } else clearStart();
  // mpv has already moved on, or is about to. playlist-play-index restarts even the entry it
  // still holds, where setting playlist-pos to it would be ignored; older mpv lacks it.
  try { native.command('playlist-play-index', String(index)); } catch { native.set('playlist-pos', String(index)); }
  // The same play when it's the song that was playing; its start-file is still to come.
  if (playEntry !== item.entry) { playEntry = item.entry; newPlay(); }
  startPending = true; hostSeek = 4;
  return true;
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
  // rather than an output that can't open, until it's plugged in (followDevices).
  const device = process.env.SQUIGGLY_AUDIO_DEVICE;
  if (device && device !== 'auto') {
    chosenDevice = device;
    if (listedDevice(device, player.devices)) native.set('audio-device', device); else fallback = 'missing';
  }
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
    player.error = null; notice = null;
    if (['queue', 'queue-jump', 'clear-session', 'stop', 'seek', 'next', 'previous'].includes(action.type)) { pendingSeek = null; clearStart(); }
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
        native.command('seek', String(action.seconds), 'absolute+exact'); hostSeek = 4; break;
      }
      case 'volume': native.set('volume', String(action.percent)); break;
      case 'device':
        // Listed afresh, so an output plugged in since the last poll counts and an unplugged one doesn't.
        player.devices = native.devices();
        if (!listedDevice(action.id, player.devices)) throw new Error('That output device is not connected. Choose another in Settings.');
        native.set('audio-device', action.id);
        chosenDevice = action.id; fallback = null; retryOnDefault = false; break;
      case 'next': native.command('playlist-next', 'weak'); break;
      case 'previous': native.command('playlist-prev', 'weak'); break;
      case 'queue-jump': {
        // By entry, not song id: in [A, B, A] the second A is a different entry from the first.
        if (playableQueue[action.index]?.entry !== action.entryId) throw new Error('The queue changed before that song could play. Try again.');
        if (reloadPlaylistAfterStop) loadPlayableQueue();
        // The entry playing starts over, a new play. (Newer mpv ignores playlist-pos set to its
        // current value; older mpv reloads the file.)
        else if (native.number('playlist-pos') === action.index) {
          native.command('seek', '0', 'absolute+exact'); hostSeek = 4; newPlay();
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
    // A song played again from its position has started, or mpv has left it (it failed too), a
    // poll or more after asking.
    if (resumeStart && (playableQueue[native.number('playlist-pos') ?? -1]?.entry !== resumeStart || native.number('time-pos') !== null)) clearStart();
    if (events.error) player.error = events.error;
    if (events.outputFailed && recoverOutput(events.outputFailed, { index: player.currentIndex, position: player.position })) {
      // Those start-files were songs that failed on the old output, not new plays.
      events.starts = 0; player.error = notice?.text ?? null;
    }
    player = {
      ...player,
      playing: native.property('pause') === 'no' && native.property('idle-active') === 'no',
      position: native.number('time-pos') ?? 0,
      duration: native.number('duration') ?? 0,
      volume: native.number('volume') ?? 100,
      currentIndex: native.number('playlist-pos') ?? -1,
      audio: native.audio(),
    };
    followPlay(events);
    if (notice && --notice.polls <= 0) clearNotice();
    if (hostSeek) hostSeek--;
    restoreSeek();
    if (++deviceTicks % 20 === 0) { player.devices = native.devices(); followDevices(); }
    publish();
  } catch {
    failEngine('Audio engine polling failed. Restart the audio engine.');
  }
}, 250);
process.on('SIGTERM', () => exit(exiting ? 1 : 0));
process.on('disconnect', () => exit(exiting ? 1 : 0));
