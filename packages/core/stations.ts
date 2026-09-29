import type { RadioStation, RepeatMode, Track } from './contracts';

// Internet radio stations as queue entries. A station is a live stream, not a song: no duration,
// album, or cover, no position to seek to, never reported as played or saved in the server's
// queue, and no radio can start from it.
export const isStation = (track: Track | null | undefined) => track?.source === 'station';

export function stationTrack(station: RadioStation): Track {
  return {
    id: station.id, title: station.name, artist: '', album: '', duration: null, source: 'station',
    sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null,
    albumId: null, artistId: null, coverArt: null,
  };
}

// Repeat one means nothing for a live stream (it has no end to start again from), so it is off
// while a station plays. Repeat all still wraps the queue.
export const repeatFor = (mode: RepeatMode, track: Track | null | undefined): RepeatMode => mode === 'one' && isStation(track) ? 'off' : mode;
