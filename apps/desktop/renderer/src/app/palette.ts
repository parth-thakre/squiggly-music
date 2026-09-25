// accent: marks and large type (3:1 against ground). accentText: normal-weight text such as
// the current lyric line (4.5:1 against ground and against the selected-row tint).
export interface Palette { ground: string; ink: string; soft: string; accent: string; accentText?: string }

// Lines and selected rows are ink laid over the ground at this opacity (App's --line).
export const LINE_ALPHA = .16;
// The minimums every palette meets. Text is checked on the bare ground and on a selected row.
export const TEXT_CONTRAST = 4.5;
export const MARK_CONTRAST = 3;

export const neutral: Palette = { ground: '#d8d7d1', ink: '#1a1a18', soft: '#46453f', accent: '#1a1a18', accentText: '#1a1a18' };

// Derives a flat window palette from cover art: the sleeve's dominant color becomes the
// ground, a readable tint of the same hue becomes ink, and its most saturated distinct
// color becomes the accent. Contrast is enforced, not assumed.
type Hsl = [number, number, number];

function rgbToHsl(r: number, g: number, b: number): Hsl {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToHex([h, s, l]: Hsl) {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
const hslOf = (hex: string) => { const n = parseInt(hex.slice(1), 16); return rgbToHsl(n >> 16, (n >> 8) & 255, n & 255); };
function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * r + .7152 * g + .0722 * b;
}
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + .05) / (y + .05);
}
// What the browser paints for `over` at `alpha` on top of `under` (sRGB compositing).
export function blend(under: string, over: string, alpha: number) {
  const a = parseInt(under.slice(1), 16), b = parseInt(over.slice(1), 16);
  return `#${[16, 8, 0].map(shift => Math.round(((a >> shift) & 255) * (1 - alpha) + ((b >> shift) & 255) * alpha).toString(16).padStart(2, '0')).join('')}`;
}
// The background of a selected or hovered row.
export const selectedTint = (palette: Pick<Palette, 'ground' | 'ink'>) => blend(palette.ground, palette.ink, LINE_ALPHA);
// Walk lightness away from the grounds until the color reaches the required contrast on every one.
function readable([h, s, l]: Hsl, grounds: string[], minimum: number, dark: boolean): string {
  for (let step = 0; step < 60; step++) {
    const hex = hslToHex([h, s, l]);
    if (grounds.every(ground => contrast(hex, ground) >= minimum)) return hex;
    l = dark ? Math.min(1, l + .02) : Math.max(0, l - .02);
  }
  return dark ? '#ffffff' : '#000000';
}

export function paletteFromPixels(data: Uint8ClampedArray): Palette {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const key = (data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | data[i + 2] >> 4;
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count++; bucket.r += data[i]; bucket.g += data[i + 1]; bucket.b += data[i + 2];
    buckets.set(key, bucket);
  }
  const total = data.length / 4;
  const colors = [...buckets.values()].map(b => ({ share: b.count / total, hsl: rgbToHsl(b.r / b.count, b.g / b.count, b.b / b.count) }))
    .sort((a, b) => b.share - a.share);
  const [h, s, l] = colors[0]?.hsl ?? [0, 0, .5];
  const dark = l < .55;
  // Keep the sleeve's character but calm it enough to read long lists on.
  const ground = hslToHex([h, Math.min(s, dark ? .45 : .5), dark ? Math.min(Math.max(l, .1), .2) : Math.max(Math.min(l, .86), .74)]);
  const ink = readable([h, Math.min(s, .35), dark ? .9 : .12], [ground], 11, dark);
  // Soft text sits on selected rows too, and a selected row is darker (or lighter) than the ground.
  const tint = selectedTint({ ground, ink });
  const soft = readable([h, Math.min(s, .25), dark ? .68 : .36], [ground, tint], TEXT_CONTRAST + .3, dark);
  // Accent: group vivid pixels by hue (a turban or a sign spans many shades) and take the
  // strongest hue family.
  const bins = Array.from({ length: 18 }, () => ({ weight: 0, count: 0, x: 0, y: 0, s: 0, l: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    const [ph, ps, pl] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (ps < .3 || pl < .18 || pl > .82) continue;
    const bin = bins[Math.floor(ph / 20) % 18];
    bin.count++; bin.weight += ps; bin.s += ps; bin.l += pl;
    bin.x += Math.cos(ph * Math.PI / 180); bin.y += Math.sin(ph * Math.PI / 180);
  }
  const hueGap = (a: number) => Math.min(Math.abs(a - h), 360 - Math.abs(a - h));
  // A clearly different hue wins when the sleeve has one; otherwise the strongest same-hue
  // family still works because readable() pushes it away from the ground in lightness.
  const candidates = bins.filter(b => b.count / total > .015).map(b => ({ ...b, hue: (Math.atan2(b.y, b.x) * 180 / Math.PI + 360) % 360 }))
    .sort((a, b) => b.weight - a.weight);
  const vivid = candidates.find(b => s < .15 || hueGap(b.hue) > 30) ?? candidates[0];
  const hue: Hsl | null = vivid ? [vivid.hue, Math.max(vivid.s / vivid.count, .55), vivid.l / vivid.count] : null;
  const accent = hue ? readable(hue, [ground, tint], MARK_CONTRAST + .2, dark) : ink;
  // The same hue, pushed further when needed, for normal-weight text such as the current lyric line.
  const accentText = hue ? readable([hue[0], hue[1], hslOf(accent)[2]], [ground, tint], TEXT_CONTRAST + .1, dark) : ink;
  return { ground, ink, soft, accent, accentText };
}

export async function paletteFromImage(url: string): Promise<Palette> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 48;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(image, 0, 0, 48, 48);
  return paletteFromPixels(context.getImageData(0, 0, 48, 48).data);
}
