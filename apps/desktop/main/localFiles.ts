import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { parseFile, selectCover } from 'music-metadata';
import type { Track } from '../../../packages/core/contracts';

// Files opened from this computer. Their title, artist, album, length, and format come from the
// file's own tags (music-metadata reads them without decoding any audio); the file name stands in
// for a missing title. The cover is the picture embedded in the file, or else a cover image in
// the same folder. Covers are read again when asked for rather than kept in memory: only where
// each one is gets remembered, under an opaque id that the squiggly-art protocol serves.
const FOLDER_IMAGE = /^(cover|folder|front|album|albumart)\.(jpe?g|png|webp)$/i;
const IMAGE_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
// The files Open files offers, and the only ones a drop onto the window opens.
export const AUDIO_EXTENSIONS = ['flac', 'wav', 'aiff', 'aif', 'alac', 'm4a', 'mp3', 'ogg', 'opus', 'aac', 'dsf', 'dff'] as const;
const AUDIO = new Set<string>(AUDIO_EXTENSIONS);
// Covers for up to twice a full queue; the oldest are forgotten first.
const COVERS = 2000;

type CoverSource = { kind: 'embedded' | 'file'; path: string };
const covers = new Map<string, CoverSource>();
const idsBySource = new Map<string, string>();

export const isLocalCover = (id: string) => id.startsWith('local-');

function coverId(source: CoverSource) {
  const key = `${source.kind}:${source.path}`;
  const known = idsBySource.get(key);
  if (known) return known;
  const id = `local-${randomUUID()}`;
  covers.set(id, source); idsBySource.set(key, id);
  while (covers.size > COVERS) {
    const [oldest, old] = covers.entries().next().value!;
    covers.delete(oldest); idsBySource.delete(`${old.kind}:${old.path}`);
  }
  return id;
}

// Folder images are looked up once per folder while reading a batch of files.
async function folderImage(directory: string, seen: Map<string, Promise<string | null>>) {
  let found = seen.get(directory);
  if (!found) {
    found = readdir(directory).then(names => {
      const name = names.filter(name => FOLDER_IMAGE.test(name)).sort()[0];
      return name ? join(directory, name) : null;
    }, () => null);
    seen.set(directory, found);
  }
  return found;
}

async function readOne(path: string, folders: Map<string, Promise<string | null>>): Promise<Track> {
  const extension = extname(path).slice(1).toLowerCase();
  const track: Track = {
    id: randomUUID(), title: basename(path, extname(path)), artist: 'Unknown artist', album: '', source: 'local',
    duration: null, sourceFormat: extension || null, sourceSampleRate: null, sourceBitDepth: null,
  };
  let embedded = false;
  try {
    const { common, format } = await parseFile(path);
    embedded = Boolean(common.picture?.length);
    track.title = common.title?.trim() || track.title;
    track.artist = common.artist?.trim() || common.albumartist?.trim() || track.artist;
    track.album = common.album?.trim() || '';
    track.duration = format.duration && Number.isFinite(format.duration) ? format.duration : null;
    // An .m4a holds either ALAC or AAC; the codec says which.
    if (extension === 'm4a' && format.codec) track.sourceFormat = format.codec.split(' ')[0].toLowerCase();
    track.sourceSampleRate = format.sampleRate ?? null;
    track.sourceBitDepth = format.bitsPerSample ?? null;
    if (common.track.no) track.trackNumber = common.track.no;
    if (common.year) track.year = common.year;
  } catch { /* Unreadable tags: the file name and extension stand. */ }
  const image = embedded ? null : await folderImage(dirname(path), folders);
  if (embedded) track.coverArt = coverId({ kind: 'embedded', path });
  else if (image) track.coverArt = coverId({ kind: 'file', path: image });
  return track;
}

// Paths dropped on the window, checked before anything is read: absolute, an audio extension,
// and a regular file. Folders are left out (this module reads files; it doesn't walk folders),
// as is anything else, and counted as skipped. Order is kept.
export async function checkAudioPaths(paths: readonly string[]): Promise<{ files: string[]; skipped: number }> {
  const ok = await Promise.all(paths.map(async path => {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || !AUDIO.has(extname(path).slice(1).toLowerCase())) return false;
    try { return (await stat(path)).isFile(); } catch { return false; }
  }));
  const files = paths.filter((_, i) => ok[i]);
  return { files, skipped: paths.length - files.length };
}

// Reads a batch of files a few at a time, keeping their order.
export async function readLocalTracks(paths: readonly string[]): Promise<Track[]> {
  const folders = new Map<string, Promise<string | null>>();
  const tracks: Track[] = new Array(paths.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, paths.length) }, async () => {
    while (next < paths.length) { const i = next++; tracks[i] = await readOne(paths[i], folders); }
  }));
  return tracks;
}

// The cover behind a local id: the embedded front cover (or first picture), or the folder image.
export async function readLocalCover(id: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const source = covers.get(id);
  if (!source) return null;
  try {
    if (source.kind === 'file') {
      const contentType = IMAGE_TYPES[extname(source.path).toLowerCase()];
      return contentType ? { bytes: await readFile(source.path), contentType } : null;
    }
    const picture = selectCover((await parseFile(source.path)).common.picture);
    return picture ? { bytes: Buffer.from(picture.data), contentType: picture.format.includes('/') ? picture.format : `image/${picture.format}` } : null;
  } catch { return null; }
}
