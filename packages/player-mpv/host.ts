import { randomBytes } from 'node:crypto';
import { emptyAudio, emptyPlayer, listedDevice, type RepeatMode } from '../core/contracts';
import { preceding, RESTART_AFTER, shuffleOrder } from '../core/playOrder';
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
// A restored queue opens its entry at the saved position (`opening`): mpv's start option has it read
// the stream from there, one range request, rather than from 0:00 and then seek. A stream that
// can't be opened at an offset (a server without range requests) starts at 0:00 instead, and then
// the entry seeks once it's seekable. Changing the track or position cancels either.
// `resume` plays once the position is reached: the queue loads paused so its first moments never play.
// `sent`: the seek command went to mpv, which hasn't carried it out yet.
let pendingSeek: { id: string; entry?: string; seconds: number; polls: number; resume: boolean; opening?: boolean; sent?: boolean } | null = null;
// mpv's start option, which opens a file at a position. Two things use it: a resume (above), and a
// song played again after its output failed (recoverOutput). It applies to every file mpv loads
// while it's set (the next song too, and a prefetched one), so it's only ever set for one entry,
// `startFor`, through setStart, and goes back to none once that entry has started or been left
// (followStart). Whichever sets it last owns it; neither clears it while the other's entry opens.
let startFor: { entry: string; seconds: number } | null = null;
// Checks a resume that's opening every 50 ms, not only at the four-Hz poll, so it plays as soon as it can.
let openingTimer: ReturnType<typeof setInterval> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let exiting = false;
let snapshotInFlight = false;
let latestSnapshot: Extract<HostMessage, { type: 'snapshot' }> | null = null;
function exit(code: number) {
  clearInterval(timer); clearInterval(openingTimer); native?.close(); native = null; process.exit(code);
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
  player = { ...player, currentIndex: -1, playing: false, position: 0, duration: 0, stationTitle: null, fromDevice: false,
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
// The output. chosenDevice is the one picked in Settings (main keeps it saved and passes it in).
// mpv's audio-device is that one, or the system default while `fallback` says why not: 'missing'
// (not listed: unplugged), which switches back once it's listed again, or 'failed' (listed, but its
// output wouldn't open), which stays on the default until it's chosen again or reconnects.
let chosenDevice = 'auto';
let fallback: 'missing' | 'failed' | null = null;
// After a switch to the system default, the song whose output failed plays again once, where it was.
let retryOnDefault = false;
let retriedEntry: string | undefined;
// The host's own news about the output. It goes out as player.error, the one message the player
// shows, so like an error it goes with the next command; news that's only news goes after `polls`.
let notice: { text: string; polls: number } | null = null;
function showNotice(text: string, polls = Infinity) { notice = { text, polls }; player.error = text; }
function clearNotice() {
  if (notice && player.error === notice.text) player.error = null;
  notice = null;
}
// The entry mpv has selected (playlist-pos): the one it's opening or playing.
const selectedEntry = () => native ? playableQueue[native.number('playlist-pos') ?? -1]?.entry : undefined;
// Whether mpv has started this entry: its file is the one open (playlist-playing-pos, or
// playlist-pos on an mpv without it), at a position, with the seek to its start position done.
function opened(entry: string) {
  if (!native) return false;
  const playing = native.number('playlist-playing-pos') ?? native.number('playlist-pos') ?? -1;
  return playableQueue[playing]?.entry === entry && native.property('seeking') === 'no' && native.number('time-pos') !== null;
}
// Opens `entry` at `seconds` (see startFor). True when mpv took it; if not, it's back to none, so
// the entry opens at 0:00 rather than at a position set for another.
function setStart(entry: string, seconds: number) {
  if (!native) return false;
  if (startFor?.entry === entry && startFor.seconds === seconds) return true;
  try { native.set('start', String(seconds)); startFor = { entry, seconds }; return true; }
  catch { clearStart(); return false; }
}
// Sets mpv's start option back to none, so nothing loaded later opens at that position.
function clearStart() {
  if (!native || !startFor) return;
  try { native.set('start', 'none'); startFor = null; } catch { /* Tried again at the next poll. */ }
}
// Each poll, after mpv's events (an entry whose output failed is played again, not left): the
// start option goes back to none once its entry has started, or mpv has left it by itself (it
// failed to open, or the position was past its end). The entry mpv went to may have opened at that
// position, so it goes back to its start; a resume's entry is checkOpening's to follow.
function followStart() {
  const owner = startFor;
  if (!native || !owner) return;
  if (selectedEntry() === owner.entry) { if (opened(owner.entry)) clearStart(); return; }
  clearStart();
  if (pendingSeek?.entry !== owner.entry) fromTop();
}
// The entry mpv moved on to, from its start. `resume`: a resume was waiting on the entry it left,
// and this one plays once it's at its start.
function fromTop(resume = false) {
  if (!native) return;
  const index = native.number('playlist-pos') ?? -1;
  const item = playableQueue[index];
  if (item && !isStationAt(index)) pendingSeek = { id: item.track.id, entry: item.entry, seconds: 0, polls: 0, resume };
  else { pendingSeek = null; if (resume) native.set('pause', 'no'); }
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
  // A resume still on its way to this song goes on with it: from the saved position, and paused
  // until it's there. One waiting on another song has nothing left to wait on.
  const seek = pendingSeek?.entry === item.entry ? pendingSeek : null;
  if (pendingSeek && !seek) {
    const other = pendingSeek; pendingSeek = null; stopOpeningChecks();
    if (other.resume) native.set('pause', 'no');
  }
  const seconds = seek ? seek.seconds : index === before.index ? before.position : 0;
  // The start option is this song's alone; whatever else it was set for is gone.
  const opening = seconds > 0 && setStart(item.entry, seconds);
  if (!opening) clearStart();
  if (seek) {
    pendingSeek = { ...seek, opening, sent: false, polls: 0 };
    if (opening) watchOpening(); else stopOpeningChecks();
  }
  // mpv has already moved on, or is about to. playlist-play-index restarts even the entry it
  // still holds, where setting playlist-pos to it would be ignored; older mpv lacks it.
  try { native.command('playlist-play-index', String(index)); } catch { native.set('playlist-pos', String(index)); }
  // The same play when it's the song that was playing; its start-file is still to come.
  if (playEntry !== item.entry) { playEntry = item.entry; newPlay(); }
  startPending = true; hostSeek = 4;
  return true;
}
function stopOpeningChecks() { clearInterval(openingTimer); openingTimer = undefined; }
function watchOpening() {
  stopOpeningChecks();
  openingTimer = setInterval(() => { try { checkOpening(false); } catch { /* The next poll reports it. */ } }, 50);
}
// A resume opening its entry at the saved position. mpv starts the entry while paused: once it
// has, `seeking` is no, the output is open, and the audio from the position is decoded, ready.
// `polled`: from the four-Hz poll, which has seen mpv's events. Only it acts on mpv having moved
// on, since an entry whose output failed is played again (recoverOutput) rather than left.
function checkOpening(polled: boolean) {
  const seek = pendingSeek;
  if (!native || !seek?.opening || !seek.entry) { stopOpeningChecks(); return; }
  if (selectedEntry() !== seek.entry) {
    // mpv moved on by itself (the entry failed to open, or the position was past its end), and the
    // entry it went to may have opened at the saved position too. That one starts from the top.
    if (polled) { if (startFor?.entry === seek.entry) clearStart(); stopOpeningChecks(); fromTop(seek.resume); }
    return;
  }
  if (!opened(seek.entry)) return;
  if (startFor?.entry === seek.entry) clearStart();
  stopOpeningChecks();
  // The start seek's event may reach the next poll after this: it's the host's own.
  hostSeek = 4;
  if (Math.abs((native.number('time-pos') ?? 0) - seek.seconds) <= 1) {
    pendingSeek = null;
    if (seek.resume) native.set('pause', 'no');
    return;
  }
  // The stream opened at 0:00, so it seeks the usual way (restoreSeek), still paused.
  seek.opening = false; seek.polls = 0;
}
function restoreSeek(seeks: number) {
  const seek = pendingSeek;
  if (!native || !seek || seek.opening) return;
  // mpv carries out a seek on its next pass, after writing out the audio it had buffered, so
  // unpausing with the seek would still play a moment of 0:00. Play once mpv reports the seek
  // (it drops that audio first), or after a second if it never does.
  if (seek.sent) {
    if (!seeks && ++seek.polls <= 4) return;
    pendingSeek = null;
    if (seek.resume) native.set('pause', 'no');
    return;
  }
  // About ten seconds of polls; slow servers may not have opened the stream yet.
  if (++seek.polls > 40) {
    pendingSeek = null;
    if (seek.seconds > 0) player.error = 'Could not restore the saved position. The song starts from the beginning.';
    if (seek.resume) native.set('pause', 'no');
    return;
  }
  if (player.queue[player.currentIndex]?.id !== seek.id || native.property('seekable') !== 'yes') return;
  // Back to the top (fromTop) of an entry that opened there anyway: nothing to seek.
  if (seek.seconds === 0 && (native.number('time-pos') ?? Infinity) < 1) {
    pendingSeek = null;
    if (seek.resume) native.set('pause', 'no');
    return;
  }
  try { native.command('seek', String(seek.seconds), 'absolute+exact'); hostSeek = 4; }
  catch { /* Not seekable yet. Retry on the next poll. */ return; }
  if (seek.resume) { seek.sent = true; seek.polls = 0; } else pendingSeek = null;
}

// `at`, with nothing playing: the entry to start. mpv then opens only that one, not the first entry
// on the way to it. Without it, the first entry loads (replace), as after a legacy stop.
function loadPlayableQueue(at?: number) {
  if (!native) return;
  for (const [index, item] of playableQueue.entries()) {
    native.command('loadfile', item.location, index === 0 && at === undefined ? 'replace' : 'append');
  }
  if (at !== undefined) native.set('playlist-pos', String(at));
  reloadPlaylistAfterStop = false;
}
function failEngine(message: string) {
  clearInterval(timer); stopOpeningChecks();
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
  // Commands that load something else, or move within the song: each cancels a resume in progress
  // and the start option, and a refused seek, skip, or jump puts them back.
  const moving = ['queue', 'queue-jump', 'clear-session', 'stop', 'seek', 'next', 'previous'].includes(action.type);
  const dropped = moving ? pendingSeek : null;
  const droppedStart = moving ? startFor : null;
  try {
    if (!native) throw new Error(player.error ?? 'Audio engine unavailable.');
    player.error = null; notice = null;
    // A resume waiting on its position: a new queue sets its own pause state, stop and clear stay
    // stopped, and a seek, skip, or jump plays from where it goes. Whatever loads next opens at its
    // start: the start option goes back to none, whichever set it (a resume, or a song played again).
    if (moving) { pendingSeek = null; stopOpeningChecks(); clearStart(); }
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
        const seconds = action.startPosition ?? 0;
        // A station is live: no position to go back to. (Shuffling keeps the chosen song at `start`.)
        const restore = Number.isFinite(seconds) && seconds > 0 && action.tracks[start].track.source !== 'station';
        // Pause before loading so a restored queue never plays its first moments, even one that
        // plays: it starts once it's at the position, not from 0:00 with a re-buffer to the position.
        if (action.paused || restore) native.set('pause', 'yes');
        // Retain locations only inside the isolated host so old mpv versions can
        // rebuild the native playlist after their argument-less stop command.
        // With shuffle on, a new list plays from the chosen song with the rest in random order, as
        // in the browser and on Android. Radio and a restored queue keep their order (ordered).
        const order = player.shuffle && !action.ordered ? shuffleOrder(action.tracks.length, start) : null;
        playableQueue = (order ? order.map(index => action.tracks[index]) : action.tracks).map(toEntry);
        // Opens the chosen entry at the saved position (see pendingSeek). If mpv refuses the
        // option, the entry opens at 0:00 and seeks instead.
        const opening = restore && setStart(playableQueue[start].entry, seconds);
        loadPlayableQueue(start);
        publishQueue();
        if (restore) {
          pendingSeek = { id: playableQueue[start].track.id, entry: playableQueue[start].entry, seconds, polls: 0, resume: !action.paused, opening };
          if (opening) watchOpening();
        } else if (!action.paused) native.set('pause', 'no');
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
        // Waiting on a restored position, play starts once the seek lands rather than from 0:00.
        if (pendingSeek) pendingSeek.resume = true;
        else native.set('pause', 'no');
        break;
      case 'pause': native.set('pause', 'yes'); if (pendingSeek) pendingSeek.resume = false; break;
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
        if (isStationAt(action.queueIndex)) { if (dropped?.resume) native.set('pause', 'no'); break; }
        native.command('seek', String(action.seconds), 'absolute+exact'); hostSeek = 4;
        // Still paused from the resume: play once mpv has made this seek, as restoreSeek does.
        if (dropped?.resume) pendingSeek = { id: action.trackId, entry: playableQueue[action.queueIndex]?.entry, seconds: action.seconds, polls: 0, resume: true, sent: true };
        break;
      }
      case 'volume': native.set('volume', String(action.percent)); break;
      case 'device':
        // Listed afresh, so an output plugged in since the last poll counts and an unplugged one doesn't.
        player.devices = native.devices();
        if (!listedDevice(action.id, player.devices)) throw new Error('That output device is not connected. Choose another in Settings.');
        native.set('audio-device', action.id);
        chosenDevice = action.id; fallback = null; retryOnDefault = false; break;
      // Another song drops mpv's buffered audio with the old file, so unpausing at once is safe.
      case 'next': native.command('playlist-next', 'weak'); if (dropped?.resume) native.set('pause', 'no'); break;
      case 'previous': {
        // Past RESTART_AFTER, or on the first song with nothing before it, the song starts again (a
        // seek, not a new play). Every desktop Previous comes here: the deck, media keys, the tray,
        // and the system's media controls. A station has no start: it moves back.
        const index = native.number('playlist-pos') ?? -1;
        const restart = index >= 0 && !isStationAt(index)
          && ((native.number('time-pos') ?? 0) > RESTART_AFTER || preceding(index, playableQueue.length, player.repeat) < 0);
        if (restart) { native.command('seek', '0', 'absolute+exact'); hostSeek = 4; } else native.command('playlist-prev', 'weak');
        if (dropped?.resume) native.set('pause', 'no');
        break;
      }
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
    // A refused seek, skip, or jump changed nothing, so the saved position still applies, and so
    // does the start option for the entry it was set for. (mpv refuses a seek before the entry has
    // opened.) An entry that read the start option while it was cleared opens at 0:00: a resume
    // then seeks (checkOpening).
    if (['queue-jump', 'seek', 'next', 'previous'].includes(action.type)) {
      if (droppedStart && !startFor && selectedEntry() === droppedStart.entry) setStart(droppedStart.entry, droppedStart.seconds);
      if (dropped && !pendingSeek) { pendingSeek = dropped; if (dropped.opening) watchOpening(); }
    }
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
    if (events.outputFailed && recoverOutput(events.outputFailed, { index: player.currentIndex, position: player.position })) {
      // Those start-files were songs that failed on the old output, not new plays.
      events.starts = 0; player.error = notice?.text ?? null;
    }
    // The start option's entry has started, or mpv has left it (see startFor).
    followStart();
    // Opening at the saved position, or found it opened at 0:00 and now seeking (restoreSeek).
    checkOpening(true);
    // A resume waiting on its position shows as starting at the saved position: playing and
    // buffering, so the play button doesn't flash to paused and the position doesn't flash 0:00.
    const resuming = pendingSeek?.resume ? pendingSeek.seconds : null;
    const audio = native.audio();
    const playing = resuming !== null || native.property('pause') === 'no' && native.property('idle-active') === 'no';
    player = {
      ...player,
      playing,
      position: resuming ?? native.number('time-pos') ?? 0,
      duration: native.number('duration') ?? 0,
      volume: native.number('volume') ?? 100,
      currentIndex: native.number('playlist-pos') ?? -1,
      // Playing but not heard yet, so the deck shows it starting: mpv's core-idle stays yes while
      // the stream opens and fills and the output opens, after a seek, and while it waits on the
      // network (paused-for-cache). Paused, nothing is on its way.
      audio: { ...audio, buffering: playing && (resuming !== null || audio.buffering || native.property('core-idle') === 'yes') },
    };
    player.stationTitle = isStationAt(player.currentIndex) ? announced(native.property('metadata/by-key/icy-title')) : null;
    // A kept song says it plays from this computer only when mpv really opened its file.
    const entry = playableQueue[player.currentIndex];
    player.fromDevice = entry?.kept === true && native.property('path') === entry.location;
    followLoop();
    // The start seek of an entry opening at the saved position is the host's own too.
    followPlay(pendingSeek?.opening ? { ...events, seeks: 0 } : events);
    if (notice && --notice.polls <= 0) clearNotice();
    if (hostSeek) hostSeek--;
    restoreSeek(events.seeks);
    if (++deviceTicks % 20 === 0) { player.devices = native.devices(); followDevices(); }
    publish();
  } catch {
    failEngine('Audio engine polling failed. Restart the audio engine.');
  }
}, 250);
process.on('SIGTERM', () => exit(exiting ? 1 : 0));
process.on('disconnect', () => exit(exiting ? 1 : 0));
