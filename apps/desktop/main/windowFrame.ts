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

// The mini player on Windows has no system frame at all (thickFrame: false, main/index.ts): a
// frameless window that keeps one gets a strip of it along three edges since Electron 41.3, and
// on the ThinkPad it stayed light whatever colour the caption and border were given
// (electron/electron#51679, #51540). Without the frame, Windows 11 doesn't round the corners on its
// own, so they're asked for; the window resizes from its own edge handles (Mini.tsx).
const DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2;
export async function roundCorners(window: BrowserWindow) {
  if (process.platform !== 'win32' || window.isDestroyed()) return null;
  const call = await load();
  if (!call || window.isDestroyed()) return null;
  return call(window.getNativeWindowHandle().readBigInt64LE(0), DWMWA_WINDOW_CORNER_PREFERENCE, Uint32Array.of(DWMWCP_ROUND), 4);
}

// The window's rectangle as Windows has it, in screen pixels, for a diagnostics build to set
// beside Electron's bounds: equal means no strip of frame outside the page.
type Rect = { left: number; top: number; right: number; bottom: number };
let getRect: Promise<((hwnd: bigint, rect: Rect) => boolean) | null> | undefined;
export async function windowRect(window: BrowserWindow): Promise<Rect | null> {
  if (process.platform !== 'win32' || window.isDestroyed()) return null;
  const call = await (getRect ??= import('koffi').then(({ default: koffi }) => {
    koffi.struct('SquigglyRect', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
    return koffi.load('user32.dll').func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ SquigglyRect *rect)') as unknown as (hwnd: bigint, rect: Rect) => boolean;
  }).catch(() => null));
  if (!call || window.isDestroyed()) return null;
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  return call(window.getNativeWindowHandle().readBigInt64LE(0), rect) ? rect : null;
}
