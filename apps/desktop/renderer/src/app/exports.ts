import type { Result, Track } from '../../../../../packages/core/contracts';
import { buildM3u, m3uEntry, m3uFileName } from '../../../../../packages/core/m3u';

// Playlist files and the clipboard, on every platform.

// Saves songs as an extended M3U (packages/core/m3u.ts) named `<name>.m3u8`. The desktop asks
// where through its save dialog, and writes local files with their paths. The browser build and
// Android download the file. Returns the error to show, or null (cancelling is not an error).
export async function exportM3u(name: string, tracks: readonly Track[]): Promise<string | null> {
  const title = name.trim().slice(0, 256) || 'Playlist';
  const entries = tracks.map(m3uEntry);
  if (window.squiggly) {
    const result = await window.squiggly.saveM3u(title, entries);
    return result.ok ? null : result.error;
  }
  download(m3uFileName(title), buildM3u(entries, title), 'audio/x-mpegurl');
  return null;
}

function download(fileName: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url; link.download = fileName; link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Long enough for the download to start.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// The desktop window's own clipboard API needs a permission the app doesn't grant, so the text
// goes through the main process, as extensions' ctx.clipboard does.
export async function copyText(text: string): Promise<Result> {
  try {
    if (window.squiggly?.extensions) return await window.squiggly.extensions.writeClipboard(text);
    await navigator.clipboard.writeText(text);
    return { ok: true, value: undefined };
  } catch { return { ok: false, error: 'The link could not be copied. Select it and copy it yourself.' }; }
}
