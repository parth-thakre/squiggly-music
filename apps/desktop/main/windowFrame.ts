import type { BrowserWindow } from 'electron';

// Since Electron 41.3 a frameless, resizable window on Windows keeps a strip of its own frame
// outside the page on the left, right, and bottom edges, for resize targets
// (electron/electron#51679). Windows paints it in the frame's caption colour, so giving that the
// room's ground makes it part of the room. Windows 10 has no caption colour: the call fails and
// the light or dark frame from nativeTheme stays.

const DWMWA_CAPTION_COLOR = 35;
type SetAttribute = (hwnd: bigint, attribute: number, value: Uint32Array, size: number) => number;
let setAttribute: Promise<SetAttribute | null> | undefined;

const load = () => setAttribute ??= import('koffi').then(({ default: koffi }) => koffi.load('dwmapi.dll')
  .func('long __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32_t attribute, _In_ uint32_t *value, uint32_t size)') as SetAttribute)
  .catch(() => null);

// #rrggbb to a COLORREF (0x00bbggrr).
const colorref = (hex: string) => parseInt(hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3), 16);

// True when Windows took the colour.
export async function paintFrame(window: BrowserWindow, ground: string) {
  if (process.platform !== 'win32' || window.isDestroyed()) return false;
  const call = await load();
  if (!call || window.isDestroyed()) return false;
  const hwnd = window.getNativeWindowHandle().readBigInt64LE(0);
  return call(hwnd, DWMWA_CAPTION_COLOR, Uint32Array.of(colorref(ground)), 4) === 0;
}

// The mini player's frame on Windows: its strip takes the caption colour, as the main window's
// does, and the line Windows 11 draws around a window its border colour; both the room's ground.
// Windows' answer to each (0 for taken, an HRESULT otherwise), for a diagnostics build to report.
// Both were taken while the mini player had no frame at all (frame: false), and its strip stayed
// light: that strip was Electron's own, which is why it now keeps a hidden title bar instead.
const DWMWA_BORDER_COLOR = 34;
export async function paintEdges(window: BrowserWindow, ground: string) {
  if (process.platform !== 'win32' || window.isDestroyed()) return null;
  const call = await load();
  if (!call || window.isDestroyed()) return null;
  const hwnd = window.getNativeWindowHandle().readBigInt64LE(0);
  const colour = Uint32Array.of(colorref(ground));
  return { caption: call(hwnd, DWMWA_CAPTION_COLOR, colour, 4), border: call(hwnd, DWMWA_BORDER_COLOR, colour, 4) };
}
