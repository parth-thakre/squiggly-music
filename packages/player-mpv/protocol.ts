import type { PlayerCommand, PlayerSnapshot, Track } from '../core/contracts';

// Private transport. Stream URLs and local paths never enter renderer snapshots.
export interface PlayableTrack { track: Track; location: string }
export type HostRequest = {
  id: number;
  action: { type: 'queue'; tracks: PlayableTrack[] } | PlayerCommand;
};
export type HostMessage =
  | { type: 'snapshot'; player: PlayerSnapshot; resources: { cpuPercent: number; memoryMB: number } }
  | { type: 'reply'; id: number; error: string | null };
