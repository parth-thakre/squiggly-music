import type { KeepKind, KeptDetail, KeptJob, KeptState, Track } from './contracts';

// Songs kept on this device: the index's shape, its bounds, and the pure helpers the desktop's
// main process, the Android page, and the renderer share. No Node, no effect. The Android side
// (Kept.kt) repeats these constants and cites this file.
export const KEPT_VERSION = 1;
export const KEPT_LIMITS = {
  songs: 20_000, containers: 2_000, tracksPerContainer: 5_000, covers: 5_000,
  trackJsonBytes: 16 * 1024, nameChars: 256,
  readBytes: 32 * 1024 * 1024, writeBudgetBytes: 24 * 1024 * 1024,
  coverSize: 600, coversPerJob: 200, headroomBytes: 256 * 1024 * 1024,
  // Room counted for a cover not kept yet, before its size is known.
  coverEstimate: 150 * 1024,
  // Per song in the index, besides its Track JSON: the file name, size, and date.
  entryOverhead: 200,
} as const;
export const MB = 1024 * 1024;
export const DEFAULT_KEPT_LIMIT_MB = 4096;
export const KEPT_LIMIT_MB = { min: 64, max: 1_048_576 } as const;
// The only names ever read from the folder or deleted from it: a song (s-) or a cover (c-), the
// first 32 hex digits of a SHA-256 of its id, and a suffix. Only the writer makes names.
export const KEPT_FILE = /^[sc]-[0-9a-f]{32}\.[a-z0-9]{1,8}$/;

export interface KeptSong { track: Track; file: string; bytes: number; keptAt: number }
export type CoverType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/avif' | 'image/bmp';
export interface KeptCover { file: string; bytes: number; type: CoverType; keptAt: number }
export interface KeptContainerRecord { kind: KeepKind; id: string; name: string; artist: string | null; coverArt: string | null; trackIds: string[]; keptAt: number }
// Refcounts and completeness are never stored: a song or cover is kept while some container
// refers to it, and a container is complete when every one of its songs is in `songs`.
export interface KeptIndex {
  version: 1;
  // keyOf(server, username): kept songs belong to one account.
  account: string | null;
  songs: Record<string, KeptSong>;
  containers: KeptContainerRecord[];
  covers: Record<string, KeptCover>;
}
export const emptyIndex = (account: string | null = null): KeptIndex => ({ version: 1, account, songs: {}, containers: [], covers: {} });

// Plain messages, written here so every host says the same thing.
export const KEPT_MESSAGES = {
  away: 'Your server is out of reach. Keeping needs it.',
  notLoaded: 'Some of these songs are no longer loaded. Open the page again and try once more.',
  tooMany: 'Squiggly keeps up to 20,000 songs on a device. Forget something kept first.',
  tooManyContainers: 'Squiggly keeps up to 2,000 records, playlists, and mixes on a device. Forget something kept first.',
  indexFull: 'The list of kept songs is full. Forget something kept first.',
  noDisk: (device: 'computer' | 'phone') => `There isn't enough free space on this ${device} to keep these songs.`,
  notKept: 'None of these songs are kept on this device. They play again when your server is back.',
  broken: 'The list of kept songs couldn\'t be read, so they were cleared.',
  diskFull: (done: number, total: number) => `The disk filled up after ${done} of ${total} songs. Free some space and keep again.`,
  limitReached: (limitMb: number, done: number, total: number) => `The kept songs reached the ${limitMb.toLocaleString('en-US')} MB limit after ${done} of ${total} songs.`,
  stoppedAnswering: (done: number, total: number) => `The server stopped answering after ${done} of ${total} songs. Keep again to fetch the rest.`,
  failed: (count: number) => count === 1 ? 'One song couldn\'t be kept.' : `${count.toLocaleString('en-US')} songs couldn't be kept.`,
  unknown: 'That isn\'t kept on this device.',
} as const;

// The account kept songs belong to. The scheme is left out, so a server reached over HTTP after
// HTTPS (or the other way) is the same account and nothing kept is lost.
export function keyOf(baseUrl: string, username: string) {
  const url = new URL(baseUrl);
  return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}\n${username}`;
}

// A Track as the index keeps it: stars and ratings go stale and belong to the server.
export function keptTrack(track: Track): Track {
  const { starred: _starred, userRating: _rating, ...rest } = track;
  return rest;
}
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

const suffixes: Record<string, string> = {
  'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg', 'application/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff', 'audio/x-dsf': 'dsf', 'audio/x-dff': 'dff', 'audio/x-ape': 'ape', 'audio/x-wavpack': 'wv',
};
// The file's suffix: the server's own for the song when it is a plain one, else from the type the
// stream came with, else 'audio'. mpv and ExoPlayer read the contents, not the name.
export function suffixFor(sourceFormat: string | null | undefined, contentType: string | null | undefined) {
  const format = sourceFormat?.toLowerCase() ?? '';
  if (/^[a-z0-9]{1,8}$/.test(format)) return format;
  return suffixes[contentType?.split(';')[0].trim().toLowerCase() ?? ''] ?? 'audio';
}
const coverExts: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp' };
export const coverExt = (type: string) => coverExts[type] ?? null;
export const isCoverType = (type: string): type is CoverType => type in coverExts;

// 1024-based, as the limit is. Whole MB below 1,024 MB, then GB with one decimal.
export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / MB;
  if (mb < 1) return 'under 1 MB';
  if (mb < 1024) return `${Math.round(mb).toLocaleString('en-US')} MB`;
  return `${(mb / 1024).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
}
export const formatLimit = (limitMb: number) => `${limitMb.toLocaleString('en-US')} MB`;
export function limitMessage(songs: number, needed: number, free: number, limitMb: number) {
  return `Keeping ${songs === 1 ? 'this song' : `these ${songs.toLocaleString('en-US')} songs`} needs about ${formatBytes(needed)}, and ${formatBytes(Math.max(0, free))} of the ${formatLimit(limitMb)} limit is free. Raise the limit in Settings, or forget something kept first.`;
}
export const clampLimitMb = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
  ? Math.min(KEPT_LIMIT_MB.max, Math.max(KEPT_LIMIT_MB.min, Math.round(value))) : DEFAULT_KEPT_LIMIT_MB;

// What a Keep control shows for one record, playlist, or mix. `detail` is the container as last
// read, and `current` the songs the page shows now: when they differ, the kept copy is stale.
export type KeepStatus = 'none' | 'waiting' | 'keeping' | 'paused' | 'stopped' | 'kept' | 'incomplete' | 'stale';
export interface KeepView { status: KeepStatus; done: number; total: number; error: string | null; job: KeptJob | null }
export function keepStatus(state: KeptState | null, detail: KeptDetail | null, kind: KeepKind, id: string, current?: readonly string[]): KeepView {
  const job = state?.jobs.find(j => j.kind === kind && j.id === id) ?? null;
  const container = state?.containers.find(c => c.kind === kind && c.id === id) ?? null;
  if (job) return { status: job.state, done: job.done, total: job.total, error: job.error, job };
  if (!container) return { status: 'none', done: 0, total: 0, error: null, job: null };
  const base = { done: container.present, total: container.total, error: null, job: null };
  if (current && detail && detail.container.kind === kind && detail.container.id === id
    && (current.length !== detail.trackIds.length || current.some((trackId, i) => trackId !== detail.trackIds[i]))) return { ...base, status: 'stale' };
  return { ...base, status: container.present < container.total ? 'incomplete' : 'kept' };
}

// While the server is away only kept songs play. The list keeps its order; it starts at the first
// kept song at or after the chosen one, or else at the last kept one before it. Null: none kept.
export function keptOnly<T>(items: readonly T[], start: number, playable: (item: T) => boolean): { items: T[]; start: number } | null {
  const kept: T[] = [];
  let at = -1, before = -1;
  items.forEach((item, i) => {
    if (!playable(item)) return;
    if (i >= start && at < 0) at = kept.length;
    if (i < start) before = kept.length;
    kept.push(item);
  });
  if (!kept.length) return null;
  return { items: kept, start: at >= 0 ? at : Math.max(0, before) };
}
