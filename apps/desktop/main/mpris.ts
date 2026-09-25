import type { PlayerSnapshot } from '../../../packages/core/contracts';

export interface MediaControls {
  command(type: 'play' | 'pause' | 'next' | 'previous' | 'stop'): void;
  seek(seconds: number): void;
  volume(percent: number): void;
  raise(): void;
  quit(): void;
}
export interface MediaSession { update(player: PlayerSnapshot, artUrl: string | null): void }

// Linux MPRIS over the session bus. Audio plays in mpv, not Chromium, so Chromium's own
// MediaSession/MPRIS integration never sees it. Shells show these controls and route media
// keys here. Without a session bus (headless, some sandboxes) this returns null and playback
// is unaffected. Metadata carries only display text and a local file:// cover, never server URLs.
export async function startMpris(controls: MediaControls, onError: () => void): Promise<MediaSession | null> {
  let Player: typeof import('@jellybrick/mpris-service').default;
  try { ({ default: Player } = await import('@jellybrick/mpris-service')); } catch { return null; }
  let service: InstanceType<typeof Player>;
  try {
    service = new Player({
      name: 'squiggly', identity: 'Squiggly Music', desktopEntry: 'squiggly-music',
      supportedInterfaces: ['player'], supportedUriSchemes: [], supportedMimeTypes: [],
    });
  } catch { onError(); return null; }
  let failed = false;
  service.on('error', () => { if (!failed) { failed = true; onError(); } });

  // Position is interpolated between 4 Hz snapshots; clients poll it rather than receive signals.
  let current: { key: string; trackId: string; position: number; at: number; duration: number; playing: boolean } | null = null;
  let tracks = 0;
  let metadataKey = '';
  const position = () => !current ? 0
    : Math.min(current.position + (current.playing ? (performance.now() - current.at) / 1000 : 0), current.duration || Infinity);
  service.getPosition = () => Math.round(position() * 1e6);

  service.on('play', () => controls.command('play'));
  service.on('pause', () => controls.command('pause'));
  service.on('playpause', () => controls.command(current?.playing ? 'pause' : 'play'));
  service.on('stop', () => controls.command('stop'));
  service.on('next', () => controls.command('next'));
  service.on('previous', () => controls.command('previous'));
  service.on('raise', () => controls.raise());
  service.on('quit', () => controls.quit());
  // Seek is relative, in microseconds. Past the end means Next, per the specification.
  service.on('seek', offset => {
    if (!current || !Number.isFinite(offset)) return;
    const target = position() + offset / 1e6;
    if (current.duration > 0 && target >= current.duration) controls.command('next');
    else controls.seek(Math.max(0, target));
  });
  // SetPosition must name the current track and stay within it; otherwise it is ignored.
  service.on('position', ({ trackId, position: target }) => {
    if (!current || trackId !== current.trackId || !Number.isFinite(target) || target < 0 || (current.duration > 0 && target / 1e6 > current.duration)) return;
    controls.seek(target / 1e6);
  });

  // Volume is attenuation only, as in the app: MPRIS 1.0 maps to unity (100%).
  service.on('volume', volume => { if (Number.isFinite(volume)) controls.volume(Math.round(Math.min(1, Math.max(0, volume)) * 100)); });

  // Properties change only when their values do, to keep PropertiesChanged traffic low.
  const assign = <K extends 'playbackStatus' | 'volume' | 'canPlay' | 'canPause' | 'canSeek' | 'canGoNext' | 'canGoPrevious'>(key: K, value: (typeof service)[K]) => {
    if (service[key] !== value) service[key] = value;
  };
  return {
    update(player, artUrl) {
      if (failed) return;
      const track = player.engine === 'ready' ? player.queue[player.currentIndex] : undefined;
      const now = performance.now();
      const duration = player.duration > 0 ? player.duration : track?.duration ?? 0;
      if (!track) current = null;
      else {
        // The queue entry, so moving the current song is not a new track; the index for older snapshots.
        const key = `${player.entryIds[player.currentIndex] ?? player.currentIndex}\n${track.id}`;
        if (current?.key !== key) {
          // Opaque per-entry object paths; server IDs are not valid D-Bus paths and are not needed.
          current = { key, trackId: service.objectPath(`track/${++tracks}`), position: player.position, at: now, duration, playing: player.playing };
        } else {
          const expected = position();
          current = { ...current, position: player.position, at: now, duration, playing: player.playing };
          if (Math.abs(player.position - expected) > 1.5) service.seeked(Math.round(player.position * 1e6));
        }
      }
      const metadata = track && current ? {
        'mpris:trackid': current.trackId, 'xesam:title': track.title, 'xesam:artist': [track.artist], 'xesam:album': track.album,
        ...(duration > 0 ? { 'mpris:length': Math.round(duration * 1e6) } : {}),
        ...(artUrl ? { 'mpris:artUrl': artUrl } : {}),
      } : {};
      const nextKey = JSON.stringify(metadata);
      if (nextKey !== metadataKey) { metadataKey = nextKey; service.metadata = metadata; }
      assign('volume', player.volume / 100);
      assign('playbackStatus', !track ? 'Stopped' : player.playing ? 'Playing' : 'Paused');
      assign('canPlay', player.engine === 'ready' && player.queue.length > 0);
      assign('canPause', Boolean(track));
      assign('canSeek', Boolean(track) && duration > 0);
      assign('canGoNext', Boolean(track) && player.currentIndex < player.queue.length - 1);
      assign('canGoPrevious', Boolean(track) && player.currentIndex > 0);
    },
  };
}
