// accent: marks and large type (3:1 against ground and deck). accentText: normal-weight text
// (4.5:1 against ground, deck, and selected-row tint).
// deck: the left deck surface (darker in dark rooms, deeper in light rooms; may take the sleeve's
// second colour). neutralAccent: true when the sleeve has no vivid colour, so the page's play disc
// takes the ink instead of a muted grey.
// line: a fixed theme may set its own rule and selected-row colour; otherwise it is ink over ground.
export interface Palette {
  ground: string;
  deck?: string;
  ink: string;
  soft: string;
  accent: string;
  accentText?: string;
  line?: string;
  neutralAccent?: boolean;
  scheme?: 'dark' | 'light';
}

// Lines and selected rows are ink laid over the ground at this opacity.
export const LINE_ALPHA = .16;
// The minimums every palette meets. Text is checked on ground, deck, and selected rows.
export const TEXT_CONTRAST = 4.5;
export const MARK_CONTRAST = 3;

// Before any sleeve: a warm charcoal room with a deeper deck rail.
export const neutral: Palette = {
  ground: '#34322e', deck: '#22201d', ink: '#f2f0ea', soft: '#c7c3b9',
  accent: '#f2f0ea', accentText: '#f2f0ea', neutralAccent: true, scheme: 'dark',
};

type Hsl = [number, number, number];
type Oklch = [number, number, number];

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

// OKLab / OKLCH conversions (Björn Ottosson) for perceptually even rooms and two-colour decks.
const srgbToLinear = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (c: number) => c <= 0.0031308 ? 12.92 * c : 1.055 * (Math.max(0, c) ** (1 / 2.4)) - 0.055;

function rgbToOklch(r: number, g: number, b: number): Oklch {
  const lr = srgbToLinear(r / 255), lg = srgbToLinear(g / 255), lb = srgbToLinear(b / 255);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bv = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.hypot(a, bv);
  const H = C < 1e-6 ? 0 : (Math.atan2(bv, a) * 180 / Math.PI + 360) % 360;
  return [L, C, H];
}

function oklchToLinearRgb(L: number, C: number, H: number): [number, number, number] {
  const rad = H * Math.PI / 180;
  const a = C * Math.cos(rad), b = C * Math.sin(rad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function oklchToHex([L, C, H]: Oklch): string {
  const lc = Math.max(0, Math.min(1, L));
  let lo = 0, hi = Math.max(0, C);
  const inGamut = (c: number) => {
    const [r, g, b] = oklchToLinearRgb(lc, c, H);
    return r >= -1e-4 && r <= 1.0001 && g >= -1e-4 && g <= 1.0001 && b >= -1e-4 && b <= 1.0001;
  };
  let best = hi;
  if (!inGamut(hi)) {
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(mid)) lo = mid; else hi = mid;
    }
    best = lo;
  }
  const [lr, lg, lb] = oklchToLinearRgb(lc, best, H);
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(linearToSrgb(Math.max(0, Math.min(1, v))) * 255)));
  return `#${[byte(lr), byte(lg), byte(lb)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

const oklchOf = (hex: string): Oklch => {
  const n = parseInt(hex.slice(1), 16);
  return rgbToOklch(n >> 16, (n >> 8) & 255, n & 255);
};

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

// Walk lightness away from the grounds in OKLCH until the colour meets the contrast minimum on all of them.
function readableOklch([L, C, H]: Oklch, grounds: string[], minimum: number, dark: boolean): string {
  let l = L;
  for (let step = 0; step < 80; step++) {
    const hex = oklchToHex([l, C, H]);
    if (grounds.every(ground => contrast(hex, ground) >= minimum)) return hex;
    l = dark ? Math.min(1, l + 0.015) : Math.max(0, l - 0.015);
  }
  return dark ? '#ffffff' : '#000000';
}

function readable([h, s, l]: Hsl, grounds: string[], minimum: number, dark: boolean): string {
  for (let step = 0; step < 60; step++) {
    const hex = hslToHex([h, s, l]);
    if (grounds.every(ground => contrast(hex, ground) >= minimum)) return hex;
    l = dark ? Math.min(1, l + .02) : Math.max(0, l - .02);
  }
  return dark ? '#ffffff' : '#000000';
}

const angleGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

// The hue of the sleeve's most vivid family of colours when the largest patch is a dark shadow
// far from it: a yellow sleeve with a purple-black shadow gets a warm yellow room, not a purple one.
function groundHue(data: Uint8ClampedArray, h: number, s: number, total: number): Oklch | null {
  if (s < .06) return null;
  const bins = Array.from({ length: 18 }, () => ({ weight: 0, count: 0, x: 0, y: 0, ox: 0, oy: 0, C: 0, L: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    const [ph, ps, pl] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (ps < .3 || pl < .18 || pl > .82) continue;
    const [oL, oC, oH] = rgbToOklch(data[i], data[i + 1], data[i + 2]);
    const bin = bins[Math.floor(ph / 20) % 18];
    bin.count++; bin.weight += ps; bin.x += Math.cos(ph * Math.PI / 180); bin.y += Math.sin(ph * Math.PI / 180);
    bin.ox += Math.cos(oH * Math.PI / 180); bin.oy += Math.sin(oH * Math.PI / 180);
    bin.C += oC; bin.L += oL;
  }
  const top = bins.filter(b => b.count / total > .2).sort((a, b) => b.weight - a.weight)[0];
  if (!top) return null;
  const hue = (Math.atan2(top.y, top.x) * 180 / Math.PI + 360) % 360;
  if (angleGap(hue, h) <= 90) return null;
  const oH = (Math.atan2(top.oy, top.ox) * 180 / Math.PI + 360) % 360;
  return [top.L / top.count, top.C / top.count, oH];
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
  const colors = [...buckets.values()].map(b => {
    const r = b.r / b.count, g = b.g / b.count, bl = b.b / b.count;
    return { share: b.count / total, hsl: rgbToHsl(r, g, bl), oklch: rgbToOklch(r, g, bl) };
  }).sort((a, b) => b.share - a.share);

  const [h0, s0, l0] = colors[0]?.hsl ?? [0, 0, .5];
  const [L0, C0, H0] = colors[0]?.oklch ?? [0.335, 0, 65];
  const dark = l0 < .58;

  // Resolve the room's ground hue & chroma in OKLCH.
  const vividGround = groundHue(data, h0, s0, total);
  const gH = vividGround ? vividGround[2] : H0;
  const gRawC = vividGround ? vividGround[1] : C0;
  const isNeutralGround = !vividGround && (s0 < .06 || C0 < 0.022);

  // Dark rooms sit near 0.335 lightness with real colour (higher for yellow/cyan so they don't go
  // muddy, lower for near-black sleeves). Light sleeves open into a tinted light room near 0.875.
  let groundL: number;
  let groundC: number;
  if (dark) {
    if (isNeutralGround) {
      groundL = L0 < 0.24 ? 0.235 : 0.335;
      groundC = 0;
    } else {
      const warmYellow = angleGap(gH, 90) < 22;
      const brightCyan = angleGap(gH, 220) < 22;
      groundL = warmYellow ? 0.42 : brightCyan ? 0.38 : 0.335;
      groundC = Math.min(0.115, Math.max(0.068, gRawC * 0.72));
    }
  } else {
    groundL = isNeutralGround ? 0.895 : 0.875;
    groundC = isNeutralGround ? 0 : Math.min(0.072, Math.max(0.045, gRawC * 0.65));
  }

  // Vivid hue families for accent and secondary deck colour.
  const bins = Array.from({ length: 18 }, () => ({ weight: 0, count: 0, x: 0, y: 0, ox: 0, oy: 0, C: 0, L: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    const [ph, ps, pl] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (ps < .3 || pl < .18 || pl > .82) continue;
    const [oL, oC, oH] = rgbToOklch(data[i], data[i + 1], data[i + 2]);
    const bin = bins[Math.floor(ph / 20) % 18];
    bin.count++; bin.weight += ps;
    bin.x += Math.cos(ph * Math.PI / 180); bin.y += Math.sin(ph * Math.PI / 180);
    bin.ox += Math.cos(oH * Math.PI / 180); bin.oy += Math.sin(oH * Math.PI / 180);
    bin.C += oC; bin.L += oL;
  }
  const candidates = bins.filter(b => b.count / total > .015).map(b => ({
    share: b.count / total,
    weight: b.weight,
    hslHue: (Math.atan2(b.y, b.x) * 180 / Math.PI + 360) % 360,
    oklch: [b.L / b.count, b.C / b.count, (Math.atan2(b.oy, b.ox) * 180 / Math.PI + 360) % 360] as Oklch,
  })).sort((a, b) => b.weight - a.weight);

  // Two-colour deck: darker in dark rooms, deeper in light rooms; takes a real second hue when the
  // sleeve offers one (at least 4% share and 28° from the ground hue).
  const secondary = !isNeutralGround ? candidates.find(b => b.share > 0.04 && angleGap(b.oklch[2], gH) > 28) : undefined;
  const deckH = secondary ? secondary.oklch[2] : gH;
  const deckL = dark ? Math.max(0.14, groundL - 0.095) : Math.max(0.76, groundL - 0.070);
  const deckC = isNeutralGround ? 0
    : dark ? Math.min(0.095, secondary ? Math.max(0.045, secondary.oklch[1] * 0.48) : groundC * 0.82)
      : Math.min(0.11, secondary ? Math.max(0.06, secondary.oklch[1] * 0.55) : groundC * 1.45);

  const ground = oklchToHex([groundL, groundC, gH]);
  const deck = oklchToHex([deckL, deckC, deckH]);

  const ink = readableOklch([dark ? 0.96 : 0.16, isNeutralGround ? 0.008 : 0.018, gH], [ground, deck], 9.5, dark);
  const groundTint = selectedTint({ ground, ink });
  const deckTint = blend(deck, ink, LINE_ALPHA);
  const surfaces = [ground, deck, groundTint, deckTint];
  const soft = readableOklch([dark ? 0.80 : 0.40, isNeutralGround ? 0.014 : 0.038, gH], surfaces, TEXT_CONTRAST + .3, dark);

  // Accent: distinct vivid hue when available, otherwise strongest vivid family.
  const vivid = candidates.find(b => s0 < .15 || angleGap(b.hslHue, h0) > 30) ?? candidates[0];
  let accent: string;
  let accentText: string;
  let neutralAccent = false;
  if (vivid) {
    const [vL, vC, vH] = vivid.oklch;
    const targetC = Math.min(0.175, Math.max(vC, 0.105));
    const startL = dark ? Math.max(vL, 0.72) : Math.min(vL, 0.52);
    accent = readableOklch([startL, targetC, vH], surfaces, MARK_CONTRAST + .2, dark);
    const accentOklch = oklchOf(accent);
    accentText = readableOklch([accentOklch[0], targetC, vH], surfaces, TEXT_CONTRAST + .15, dark);
    neutralAccent = accentOklch[1] < 0.04;
  } else {
    accent = ink;
    accentText = ink;
    neutralAccent = true;
  }

  return { ground, deck, ink, soft, accent, accentText, neutralAccent, scheme: dark ? 'dark' : 'light' };
}

// For fixed theme colours: the colour itself when it already reads at `minimum` on every
// ground, otherwise the same hue walked away from the grounds until it does.
export function ensureContrast(color: string, grounds: string[], minimum: number): string {
  if (grounds.every(ground => contrast(color, ground) >= minimum)) return color;
  const dark = contrast('#ffffff', grounds[0]) > contrast('#000000', grounds[0]);
  return readable(hslOf(color), grounds, minimum, dark);
}

// A server with no picture of an artist hands out a stock one: a pale grey figure on flat pale
// grey. Told apart from a photograph (a black-and-white one too) by having no colour and only two
// tones, and from a black-and-white logo by those two tones being light and close together.
export function isStandIn(pixels: Uint8ClampedArray | readonly number[]): boolean {
  const tones = new Map<number, number>();
  let count = 0, grey = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    count++;
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 14) grey++;
    const tone = Math.floor((r * 299 + g * 587 + b * 114) / 24000);
    tones.set(tone, (tones.get(tone) ?? 0) + 1);
  }
  if (!count || grey / count < .97) return false;
  const [[tone, first], [other, second] = [-1, 0]] = [...tones].sort((a, b) => b[1] - a[1]);
  if ((first + second) / count < .85) return false;
  return tone >= 5 && (second === 0 || (other >= 5 && Math.abs(tone - other) <= 2));
}
// Reads a picture the page has already loaded (with crossOrigin set), so nothing is fetched for it.
export function standInOf(image: HTMLImageElement): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return false;
  try {
    context.drawImage(image, 0, 0, 32, 32);
    return isStandIn(context.getImageData(0, 0, 32, 32).data);
  } catch { return false; }
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

// Any CSS colour as #rrggbb, which is what the window's buttons and frame take. A canvas normalises it.
export function asHex(color: string) {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return color;
  context.fillStyle = '#000'; context.fillStyle = color;
  return context.fillStyle;
}
