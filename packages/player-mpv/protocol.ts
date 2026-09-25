import type { PlayerCommand, PlayerSnapshot, Track } from '../core/contracts';

// Private transport. Stream URLs and local paths never enter renderer snapshots.
export interface PlayableTrack { track: Track; location: string }
export type QueueEdit =
  | { type: 'queue-add'; tracks: PlayableTrack[]; where: 'next' | 'end' }
  | { type: 'queue-move'; from: number; to: number }
  | { type: 'queue-remove'; indexes: number[] }
  | { type: 'queue-clear' };
export type HostRequest = {
  id: number;
  action:
    // paused and startPosition restore a saved queue without starting playback.
    | { type: 'queue'; tracks: PlayableTrack[]; startIndex?: number; startPosition?: number; paused?: boolean }
    // Plays one queue entry, refused unless entryId still names the entry at that index.
    | { type: 'queue-jump'; index: number; entryId: string }
    | { type: 'clear-session' } | { type: 'exclusive'; on: boolean } | QueueEdit | PlayerCommand;
};
export type HostMessage =
  | { type: 'snapshot'; player: PlayerSnapshot; clientApiVersion: string | null; resources: { cpuPercent: number; memoryMB: number } }
  | { type: 'reply'; id: number; error: string | null };
