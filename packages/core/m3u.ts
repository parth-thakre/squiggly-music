import type { M3uEntry, Track } from './contracts';

// Extended M3U playlist files (.m3u8, UTF-8): `#EXTM3U`, then per song `#EXTINF:<seconds>,<artist> - <title>`
// and its path. The path is the file's path as the server reports it, or a local file's own path.
// Stream addresses never go in: they carry the account's credentials. Songs without a path are
// written as `<artist>/<album>/<title>.<suffix>`, and a comment at the top says so.
// Shared by the desktop main process (which fills in local paths) and the renderer.

// The songs of a playlist or queue, as the renderer knows them. Local files have no path here;
// the desktop's main process fills it in (see DesktopBridge.saveM3u).
export const m3uEntry = (track: Track): M3uEntry => ({
  id: track.id, local: track.source === 'local', title: track.title, artist: track.artist, album: track.album,
  duration: track.duration, path: track.source === 'navidrome' ? track.path || null : null, suffix: track.sourceFormat,
});

// Line breaks would end the line early and start a new entry, so every control character goes.
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, ' ').trim();
// One part of a relative path: no separators, and nothing Windows refuses in a file name.
const segment = (text: string, fallback: string) => oneLine(text).replace(/[/\\]/g, '-').replace(/[<>:"|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '') || fallback;
// A path keeps its spacing; only line breaks and other control characters go. A path line that
// starts with # would be read as a comment.
const pathLine = (path: string) => { const line = path.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim(); return line.startsWith('#') ? `./${line}` : line; };

export const NO_PATH_NOTE = '# Some songs had no path from the server. They are written as artist/album/title.suffix, relative to the music folder.';

export function relativePath(entry: Pick<M3uEntry, 'artist' | 'album' | 'title' | 'suffix'>): string {
  const suffix = entry.suffix ? oneLine(entry.suffix).replace(/[^a-z0-9]/gi, '').toLowerCase() : '';
  return [segment(entry.artist, 'Unknown artist'), segment(entry.album, 'Unknown album'), segment(entry.title, 'Untitled') + (suffix ? `.${suffix}` : '')].join('/');
}

export function buildM3u(entries: readonly M3uEntry[], name?: string): string {
  let guessed = false;
  const body = entries.flatMap(entry => {
    // -1 is the format's "length unknown".
    const seconds = entry.duration !== null && Number.isFinite(entry.duration) && entry.duration >= 0 ? Math.round(entry.duration) : -1;
    const artist = oneLine(entry.artist), title = oneLine(entry.title) || 'Untitled';
    const known = entry.path ? pathLine(entry.path) : '';
    if (!known) guessed = true;
    return [`#EXTINF:${seconds},${artist ? `${artist} - ${title}` : title}`, known || pathLine(relativePath(entry))];
  });
  const title = name && oneLine(name);
  return ['#EXTM3U', ...(title ? [`#PLAYLIST:${title}`] : []), ...(guessed ? [NO_PATH_NOTE] : []), ...body].join('\n') + '\n';
}

// `<name>.m3u8`, with the characters file systems refuse replaced.
export function m3uFileName(name: string): string {
  const base = oneLine(name).replace(/[/\\<>:"|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  return `${base || 'Playlist'}.m3u8`;
}
