import { blend, contrast, ensureContrast, LINE_ALPHA, MARK_CONTRAST, TEXT_CONTRAST } from '../palette';

// A theme is JSON tokens. Every field is optional; what's missing comes from the Cover theme.
//
//   {
//     "colors": { "ground": "#e2e5e9", "ink": "#111418", "soft": "#474e58",
//                 "accent": "#c4251a", "accentText": "#961b12", "line": "#c5c9cf" },
//                 // or "cover": colours keep coming from the playing record's sleeve
//     "type": { "display": "Young Serif", "body": "Familjen Grotesk", "size": 15, "scale": 1 },
//     "density": "comfortable",        // or "compact"
//     "radius": 6,                     // 0 to 16 pixels, for menus, sheets, and selected rows
//     "motion": "full"                 // or "reduced" (what the system setting does), or "none"
//   }
//
// Colours are hex. ground is the room, ink is text, soft is secondary text, accent marks and
// large type, accentText normal-weight text in the accent colour (the current lyric line), line
// rules and the selected-row tint (ink over the ground at 16% when absent). Text colours must
// read at 4.5:1 on the ground and on a selected row, and the accent at 3:1; a colour that falls
// short is moved (same hue, lighter or darker) until it does, and the theme says so.
//
// Fonts: "Young Serif" and "Familjen Grotesk" ship with the app. Any other name is looked up
// among the fonts installed on this computer, falling back to the bundled ones. size is the body
// text size in pixels (12 to 20); scale multiplies headings (0.8 to 1.4).

export interface ThemeColors { ground: string; ink: string; soft: string; accent: string; accentText: string; line: string | null }
export interface ThemeType { display: string; body: string; size: number; scale: number }
export interface ThemeTokens {
  colors: 'cover' | ThemeColors;
  type: ThemeType;
  density: 'comfortable' | 'compact';
  radius: number;
  motion: 'full' | 'reduced' | 'none';
}
export const DEFAULT_TOKENS: ThemeTokens = {
  colors: 'cover', type: { display: 'Young Serif', body: 'Familjen Grotesk', size: 15, scale: 1 },
  density: 'comfortable', radius: 6, motion: 'full',
};

export interface Checked { tokens: ThemeTokens | null; errors: string[]; notes: string[] }

const TOP = ['colors', 'type', 'density', 'radius', 'motion'];
// Carried in theme files for people, not read here.
const IGNORED = new Set(['name', 'id', 'description', '$schema']);
const COLOR_KEYS = ['ground', 'ink', 'soft', 'accent', 'accentText', 'line'];
const TYPE_KEYS = ['display', 'body', 'size', 'scale'];
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const FONT = /^[\p{L}\p{N} ._-]{1,60}$/u;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const list = (names: string[]) => names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
const shown = (value: unknown) => typeof value === 'string' ? `“${value}”` : JSON.stringify(value) ?? String(value);
function unknownKeys(value: Record<string, unknown>, allowed: string[], where: string, errors: string[], ignore = new Set<string>()) {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key) || ignore.has(key)) continue;
    const hint = key === 'colours' ? ' Use “colors”.' : key === 'font' || key === 'fonts' ? ' Fonts go under “type”.' : key === 'accent_text' || key === 'accenttext' ? ' Use “accentText”.' : '';
    errors.push(`${where}“${key}” isn't a theme setting. Use ${list(allowed)}.${hint}`);
  }
}
const hex = (value: string) => {
  const digits = value.slice(1).toLowerCase();
  return `#${digits.length === 3 ? [...digits].map(d => d + d).join('') : digits}`;
};

export function checkTokens(value: unknown): Checked {
  const errors: string[] = [], notes: string[] = [];
  if (!isObject(value)) return { tokens: null, errors: ['A theme is a JSON object with colors, type, density, radius, and motion.'], notes };
  unknownKeys(value, TOP, '', errors, IGNORED);
  const tokens: ThemeTokens = { ...DEFAULT_TOKENS, type: { ...DEFAULT_TOKENS.type } };

  // Colours
  const colors = value.colors;
  if (colors === undefined || colors === 'cover') tokens.colors = 'cover';
  else if (!isObject(colors)) errors.push(`colors is ${shown(colors)}. Use "cover", or an object with ground, ink, soft, accent, accentText, and line.`);
  else {
    unknownKeys(colors, COLOR_KEYS, 'colors: ', errors);
    const read = (key: string, required: boolean): string | null => {
      const raw = colors[key];
      if (raw === undefined) { if (required) errors.push(`colors.${key} is missing. A fixed theme needs at least ground and ink.`); return null; }
      if (typeof raw !== 'string' || !HEX.test(raw)) { errors.push(`colors.${key} is ${shown(raw)}, which isn't a colour. Use hex, such as “#1b2a3c”.`); return null; }
      return hex(raw);
    };
    const ground = read('ground', true), ink = read('ink', true);
    const soft = read('soft', false), accent = read('accent', false), accentText = read('accentText', false), line = read('line', false);
    if (ground && ink) {
      const fixed = enforceContrast({ ground, ink, soft: soft ?? blend(ground, ink, .72), accent: accent ?? ink, accentText: accentText ?? accent ?? ink, line }, notes, errors);
      if (fixed) tokens.colors = fixed;
    }
  }

  // Type
  const type = value.type;
  if (type !== undefined) {
    if (!isObject(type)) errors.push(`type is ${shown(type)}. Use an object with display, body, size, and scale.`);
    else {
      unknownKeys(type, TYPE_KEYS, 'type: ', errors);
      for (const slot of ['display', 'body'] as const) {
        const font = type[slot];
        if (font === undefined) continue;
        if (typeof font !== 'string' || !FONT.test(font.trim())) errors.push(`type.${slot} is ${shown(font)}. Name one font family, such as “Young Serif”, “Familjen Grotesk”, or one installed on this computer (letters, digits, spaces, and dashes).`);
        else tokens.type[slot] = font.trim();
      }
      const number = (key: 'size' | 'scale', min: number, max: number, unit: string) => {
        const raw = type[key];
        if (raw === undefined) return;
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) errors.push(`type.${key} is ${shown(raw)}. Use a number from ${min} to ${max}${unit}.`);
        else tokens.type[key] = raw;
      };
      number('size', 12, 20, ' (pixels)');
      number('scale', .8, 1.4, '');
    }
  }

  if (value.density !== undefined) {
    if (value.density === 'comfortable' || value.density === 'compact') tokens.density = value.density;
    else errors.push(`density is ${shown(value.density)}. Use “comfortable” or “compact”.`);
  }
  if (value.radius !== undefined) {
    const radius = value.radius;
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0 || radius > 16) errors.push(`radius is ${shown(radius)}. Use a number of pixels from 0 to 16.`);
    else tokens.radius = Math.round(radius);
  }
  if (value.motion !== undefined) {
    if (value.motion === 'full' || value.motion === 'reduced' || value.motion === 'none') tokens.motion = value.motion;
    else errors.push(`motion is ${shown(value.motion)}. Use “full”, “reduced”, or “none”.`);
  }
  return { tokens: errors.length ? null : tokens, errors, notes };
}

// The selected-row tint, which text must also read on.
export const tintOf = (colors: Pick<ThemeColors, 'ground' | 'ink' | 'line'>) => colors.line ?? blend(colors.ground, colors.ink, LINE_ALPHA);
const ratio = (value: number) => `${(Math.floor(value * 10) / 10).toFixed(1)}:1`;

// Moves each text colour until it reads on the ground and the selected row, and says what moved.
function enforceContrast(colors: ThemeColors, notes: string[], errors: string[]): ThemeColors | null {
  const out = { ...colors };
  const fix = (key: 'ink' | 'soft' | 'accent' | 'accentText', minimum: number) => {
    const grounds = [out.ground, tintOf(out)];
    const before = out[key];
    const worst = Math.min(...grounds.map(ground => contrast(before, ground)));
    if (worst >= minimum) return true;
    const after = ensureContrast(before, grounds, minimum);
    const reached = Math.min(...grounds.map(ground => contrast(after, ground)));
    const needs = minimum === MARK_CONTRAST ? 'marks need' : 'text needs';
    if (reached < minimum) {
      errors.push(`colors.${key} ${before} reads at ${ratio(worst)} and no shade of it reaches the ${minimum}:1 ${needs} on this ground${out.line ? ' and line' : ''}. Choose a lighter or darker ground${out.line ? ', or a quieter line' : ''}.`);
      return false;
    }
    out[key] = after;
    const where = contrast(before, out.ground) <= contrast(before, grounds[1]) ? 'on the ground' : 'on a selected row';
    notes.push(`colors.${key} ${before} reads at ${ratio(worst)} ${where}, below the ${minimum}:1 ${needs}, so it shows as ${after}.`);
    return true;
  };
  // Ink first: without a line colour, the selected-row tint is made from it.
  if (!fix('ink', TEXT_CONTRAST)) return null;
  const ok = [fix('soft', TEXT_CONTRAST), fix('accentText', TEXT_CONTRAST), fix('accent', MARK_CONTRAST)];
  return ok.every(Boolean) ? out : null;
}

// Font names to CSS stacks. Bundled fonts by their loaded names; anything else is quoted and
// falls back to the bundled font for its role.
const BUNDLED: Record<string, string> = { 'young serif': "'Young Serif'", 'familjen grotesk': "'Familjen Grotesk Variable'", 'familjen grotesk variable': "'Familjen Grotesk Variable'" };
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded']);
export function fontStack(name: string, role: 'display' | 'body') {
  const lower = name.trim().toLowerCase();
  const first = BUNDLED[lower] ?? (GENERIC.has(lower) ? lower : `'${name.trim()}'`);
  return role === 'display' ? `${first}, 'Young Serif', serif` : `${first}, 'Familjen Grotesk Variable', system-ui, sans-serif`;
}
export const isSerifDisplay = (name: string) => name.trim().toLowerCase() === 'young serif';

// Built-in themes --------------------------------------------------------------------------------
export interface ThemeDefinition { id: string; name: string; description: string; tokens: unknown }
export const BUILTIN_THEMES: ThemeDefinition[] = [
  { id: 'cover', name: 'Cover', description: 'The room takes its colours from the record that is playing.', tokens: {} },
  {
    id: 'studio', name: 'Studio', description: 'Control-room grey with a red on-air light. Grotesk headings, tighter spacing, square corners.',
    tokens: {
      colors: { ground: '#e2e5e9', ink: '#111418', soft: '#454c56', accent: '#c4251a', accentText: '#961b12' },
      type: { display: 'Familjen Grotesk', body: 'Familjen Grotesk', size: 14, scale: .92 }, density: 'compact', radius: 2,
    },
  },
  {
    id: 'night', name: 'Night', description: 'Blue-black, warm white, and a sodium-lamp amber, for listening late.',
    tokens: {
      colors: { ground: '#121620', ink: '#ebe7dd', soft: '#a2a8b6', accent: '#eda43a', accentText: '#f2b95c' },
      type: { scale: 1.05 }, radius: 8,
    },
  },
  {
    id: 'plain', name: 'Plain', description: 'Black on white, larger text, and nothing moves. The most contrast.',
    tokens: {
      colors: { ground: '#ffffff', ink: '#000000', soft: '#333333', accent: '#1238c4', accentText: '#1238c4', line: '#d9d9d9' },
      type: { size: 16 }, radius: 0, motion: 'none',
    },
  },
];
