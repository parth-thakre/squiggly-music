import type { RadioStation, RepeatMode, Track } from './contracts';

// Internet radio stations as queue entries. A station is a live stream, not a song: no duration,
// album, or cover, no position to seek to, never reported as played or saved in the server's
// queue, and no radio can start from it.
export const isStation = (track: Track | null | undefined) => track?.source === 'station';

// A station's track id is its server id with this in front. Servers number stations apart from
// songs (Airsonic gives both a first one of 1), and the desktop's main process knows every track
// it has handed out by id alone, so a station under its bare id could be taken for a song.
const STATION_PREFIX = 'station:';
// The longest server id a station can have and still make a track id within IdSchema's 256.
export const STATION_ID_MAX = 256 - STATION_PREFIX.length;

export function stationTrack(station: RadioStation): Track {
  return {
    id: `${STATION_PREFIX}${station.id}`, title: station.name, artist: '', album: '', duration: null, source: 'station',
    sourceFormat: null, sourceSampleRate: null, sourceBitDepth: null,
    albumId: null, artistId: null, coverArt: null,
  };
}
// The server's id for a station track, to look up its stream.
export const stationIdOf = (track: Track) => track.id.startsWith(STATION_PREFIX) ? track.id.slice(STATION_PREFIX.length) : track.id;

// Repeat one means nothing for a live stream (it has no end to start again from), so it is off
// while a station plays. Repeat all still wraps the queue.
export const repeatFor = (mode: RepeatMode, track: Track | null | undefined): RepeatMode => mode === 'one' && isStation(track) ? 'off' : mode;
