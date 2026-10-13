import type { PlayerCommand, PlayerSnapshot, Track } from '../core/contracts';

// Private transport. Stream URLs and local paths never enter renderer snapshots.
// kept: the location is a kept song's file on this computer, not the stream (only the signal-path
// line uses it: PlayerSnapshot.fromDevice). kbps: the stream is an MP3 of at most that many kbps,
// not the original (PlayerSnapshot.streamKbps).
export interface PlayableTrack { track: Track; location: string; kept?: true; kbps?: number }
export type QueueEdit =
  // A number inserts before the entry at that index (a song dropped onto the queue).
  | { type: 'queue-add'; tracks: PlayableTrack[]; where: 'next' | 'end' | number }
  | { type: 'queue-move'; from: number; to: number }
  | { type: 'queue-remove'; indexes: number[] }
  | { type: 'queue-clear' };
export type HostRequest = {
  id: number;
  action:
    // startPosition restores a saved queue, playing once it's there unless `paused`. With shuffle
    // on, the songs after startIndex are put in random order unless `ordered` (radio, a saved queue).
    | { type: 'queue'; tracks: PlayableTrack[]; startIndex?: number; startPosition?: number; paused?: boolean; ordered?: boolean }
    // Plays one queue entry, refused unless entryId still names the entry at that index.
    | { type: 'queue-jump'; index: number; entryId: string }
    // New locations for queued songs, by entry id, after Settings › Streaming quality changed. Each
    // keeps its id and place; the song playing keeps its stream, and one gone since is skipped.
    | { type: 'queue-relocate'; entries: { entryId: string; item: PlayableTrack }[] }
    | { type: 'clear-session' } | { type: 'exclusive'; on: boolean } | QueueEdit | PlayerCommand;
};
export type HostMessage =
  | { type: 'snapshot'; player: PlayerSnapshot; clientApiVersion: string | null; resources: { cpuPercent: number; memoryMB: number } }
  | { type: 'reply'; id: number; error: string | null };
