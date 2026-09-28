import type { SystemMediaState } from '../../../../../packages/core/contracts';

// The operating system's media controls for the desktop app on Windows and macOS: the Windows
// media flyout, media keys, and anything else that talks to Windows' media sessions, and macOS
// Now Playing. Audio plays in mpv, which Chromium can't see, and Chromium only publishes a media
// session while a page plays audio itself. So the main window plays a looping clip of digital
// silence that follows mpv's play and pause, and sends the session's buttons to mpv. The main
// process sends the song and its state (SystemMediaState) whether or not the window is visible,
// and stops sending one when exclusive output needs the device to itself. With nothing loaded it
// sends the song saved on the server (index -1), paused, and Play resumes that queue. Linux has
// MPRIS in the main process instead, so there the main process never asks a window to host this.
export function startSystemMedia() {
  const bridge = window.squiggly;
  if (!bridge?.media.hosted || !('mediaSession' in navigator)) return;
  const session = navigator.mediaSession;
  const clip = new Audio();
  clip.loop = true;
  let silence: string | null = null;
  let current: SystemMediaState | null = null;
  let art: { coverArt: string; url: string | null } | null = null;

  const command = (type: 'play' | 'pause' | 'stop' | 'next' | 'previous') => void bridge.command({ type });
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => command('play')], ['pause', () => command('pause')], ['stop', () => command('stop')],
    ['nexttrack', () => command('next')], ['previoustrack', () => command('previous')],
    ['seekto', details => seek(details.seekTime)],
    ['seekbackward', details => seek(position() - (details.seekOffset ?? 10))],
    ['seekforward', details => seek(position() + (details.seekOffset ?? 10))],
  ];
  for (const [action, handler] of handlers) { try { session.setActionHandler(action, handler); } catch { /* unsupported action */ } }

  let clock = { position: 0, at: 0 };
  const position = () => !current ? 0 : Math.min(clock.position + (current.playing ? (performance.now() - clock.at) / 1000 : 0), current.duration || Infinity);
  function seek(seconds: number | undefined) {
    if (!current || current.index < 0 || seconds === undefined || !Number.isFinite(seconds)) return;
    const { index, trackId, entryId, duration } = current;
    void bridge!.command({ type: 'seek', seconds: Math.max(0, Math.min(seconds, duration || seconds)), queueIndex: index, trackId, entryId });
  }

  function metadata(state: SystemMediaState) {
    const artwork = art?.coverArt === state.coverArt && art.url ? [{ src: art.url, sizes: '512x512' }] : [];
    session.metadata = new MediaMetadata({ title: state.title, artist: state.artist, album: state.album, artwork });
  }
  // Chromium only takes http, data, and blob artwork, so the cover is fetched into a blob.
  async function fetchArt(coverArt: string) {
    art = { coverArt, url: null };
    const url = await fetch(bridge!.library.coverUrl(coverArt, 512))
      .then(response => response.ok ? response.blob() : null).then(blob => blob && URL.createObjectURL(blob), () => null);
    if (art.coverArt !== coverArt) { if (url) URL.revokeObjectURL(url); return; }
    art.url = url;
    if (current?.coverArt === coverArt) metadata(current);
  }

  function end() {
    current = null;
    clip.pause(); clip.removeAttribute('src'); clip.load();
    session.metadata = null; session.playbackState = 'none';
  }
  function apply(next: SystemMediaState | null) {
    if (!next) { end(); return; }
    const before = current;
    current = next;
    clock = { position: next.position, at: performance.now() };
    if (next.coverArt !== art?.coverArt) {
      if (art?.url) URL.revokeObjectURL(art.url);
      art = null;
      if (next.coverArt) void fetchArt(next.coverArt);
    }
    if (!before || before.entryId !== next.entryId || before.title !== next.title || before.artist !== next.artist
      || before.album !== next.album || before.coverArt !== next.coverArt) metadata(next);
    if (next.duration > 0) {
      try { session.setPositionState({ duration: next.duration, position: Math.min(next.position, next.duration), playbackRate: 1 }); }
      catch { /* Rejected while the numbers are settling; the next change sends them again. */ }
    }
    session.playbackState = next.playing ? 'playing' : 'paused';
    // The session begins with the clip's first play and then stays, paused or not, until end().
    // A paused song still needs that first play, so it starts and stops at once.
    if (!clip.src) {
      silence ??= silentClip();
      clip.src = silence;
      void clip.play().then(() => { if (!current?.playing) clip.pause(); }, () => undefined);
    } else if (next.playing && clip.paused) void clip.play().catch(() => undefined);
    else if (!next.playing && !clip.paused) clip.pause();
  }
  bridge.media.subscribe(apply);
}

// Ten seconds of 8 kHz, 8-bit mono silence as a WAV. Chromium treats media shorter than five
// seconds as a sound effect with no controls.
function silentClip() {
  const rate = 8000, samples = rate * 10;
  const bytes = new Uint8Array(44 + samples).fill(128);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, 'data'); view.setUint32(40, samples, true);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}
