import type { Schema } from 'effect';
import type { CommandSchema, ConnectionSchema } from './validation';

export type PlayerCommand = Schema.Schema.Type<typeof CommandSchema>;
export type Connection = Schema.Schema.Type<typeof ConnectionSchema>;

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number | null;
  source: 'local' | 'navidrome';
  sourceFormat: string | null;
  sourceSampleRate: number | null;
  sourceBitDepth: number | null;
}
export interface Album { id: string; name: string; artist: string; songCount: number }
export interface AudioDevice { name: string; description: string }
export interface AudioPath {
  codec: string | null;
  decoderRate: number | null;
  decoderFormat: string | null;
  decoderChannels: string | null;
  outputRate: number | null;
  outputFormat: string | null;
  outputChannels: string | null;
  outputBackend: string | null;
  requestedDevice: string;
  replayGain: string | null;
  filters: string | null;
  bufferSeconds: number | null;
  streamBytesPerSecond: number | null;
  buffering: boolean;
}
export interface PlayerSnapshot {
  engine: 'starting' | 'ready' | 'unavailable' | 'crashed';
  error: string | null;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  currentIndex: number;
  queue: Track[];
  devices: AudioDevice[];
  audio: AudioPath;
}
export interface OperationMetric { name: string; count: number; errors: number; cancelled?: number; p50Ms: number; p95Ms: number }
export interface ProcessMetric { name: string; cpuPercent: number; memoryMB: number }
export interface Diagnostics {
  uptimeSeconds: number;
  startupMs: number | null;
  ipcCommands: number;
  playerMessagesPerSecond: number;
  playerBytesPerSecond: number;
  pendingCommands: number;
  eventLoopDelayMs: number;
  processes: ProcessMetric[];
  operations: OperationMetric[];
}
export interface AppSnapshot {
  player: PlayerSnapshot;
  diagnostics: Diagnostics;
  server: { connected: boolean; name: string | null };
}
export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };
export interface DesktopBridge {
  snapshot(): Promise<AppSnapshot>;
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void;
  command(command: PlayerCommand): Promise<Result>;
  openFiles(): Promise<Result>;
  connect(connection: Connection): Promise<Result>;
  albums(offset: number): Promise<Result<Album[]>>;
  playAlbum(id: string): Promise<Result>;
  disconnect(): Promise<Result>;
  exportDiagnostics(): Promise<Result>;
}

export const emptyAudio = (): AudioPath => ({
  codec: null, decoderRate: null, decoderFormat: null, decoderChannels: null,
  outputRate: null, outputFormat: null, outputChannels: null, outputBackend: null,
  requestedDevice: 'auto', replayGain: null, filters: null, bufferSeconds: null,
  streamBytesPerSecond: null, buffering: false,
});
export const emptyPlayer = (): PlayerSnapshot => ({
  engine: 'starting', error: null, playing: false, position: 0, duration: 0,
  volume: 100, currentIndex: -1, queue: [], devices: [], audio: emptyAudio(),
});
export const emptyDiagnostics = (): Diagnostics => ({
  uptimeSeconds: 0, startupMs: null, ipcCommands: 0, playerMessagesPerSecond: 0,
  playerBytesPerSecond: 0, pendingCommands: 0, eventLoopDelayMs: 0, processes: [], operations: [],
});

declare global { interface Window { squiggly?: DesktopBridge } }
