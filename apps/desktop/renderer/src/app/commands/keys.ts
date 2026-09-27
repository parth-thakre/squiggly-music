// Key bindings, without the DOM: parsing "ctrl+k" and chords like "g r", reading a key press,
// deciding whether a press belongs to the focused control, resolving defaults against the
// user's keybindings.json, finding conflicts, and matching presses to commands.
//
// A binding is one or more strokes separated by spaces. A stroke is modifiers and a key joined
// by "+": "ctrl+shift+k", "space", "alt+left", "/", "?". Characters Shift produces are written
// as themselves: "?" rather than "shift+/".

export interface Stroke { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }

const MODIFIERS: Record<string, 'ctrl' | 'alt' | 'shift' | 'meta'> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', meta: 'meta', super: 'meta', win: 'meta',
};
const NAMED: Record<string, string> = {
  space: 'space', ' ': 'space', spacebar: 'space', left: 'left', arrowleft: 'left', right: 'right', arrowright: 'right',
  up: 'up', arrowup: 'up', down: 'down', arrowdown: 'down', enter: 'enter', return: 'enter', esc: 'escape', escape: 'escape',
  tab: 'tab', backspace: 'backspace', delete: 'delete', del: 'delete', home: 'home', end: 'end', pageup: 'pageup',
  pagedown: 'pagedown', insert: 'insert', plus: '+', minus: '-', comma: ',', period: '.', slash: '/',
};
const LETTER = /^[a-z]$/;
const printable = (key: string) => key.length === 1;

function keyName(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (NAMED[lower]) return NAMED[lower];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower;
  if ([...raw].length === 1 && raw.trim()) return lower;
  return null;
}

export type Parsed = { ok: true; strokes: Stroke[] } | { ok: false; error: string };
export function parseKeys(text: unknown): Parsed {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'The key is empty. Write one such as “ctrl+k” or “g r”.' };
  const parts = text.trim().split(/\s+/);
  if (parts.length > 3) return { ok: false, error: `“${text}” has ${parts.length} steps. A chord can have up to three, such as “g r”.` };
  const strokes: Stroke[] = [];
  for (const part of parts) {
    const pieces = part === '+' ? ['+'] : part.endsWith('++') ? [...part.slice(0, -2).split('+'), '+'] : part.split('+');
    const stroke: Stroke = { key: '', ctrl: false, alt: false, shift: false, meta: false };
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i], last = i === pieces.length - 1;
      const modifier = MODIFIERS[piece.toLowerCase()];
      if (!last) {
        if (!modifier) return { ok: false, error: `“${piece}” in “${text}” isn't a modifier. Use ctrl, alt, shift, or meta.` };
        stroke[modifier] = true;
        continue;
      }
      if (modifier) return { ok: false, error: `“${part}” has no key after its modifiers. Add one, such as “${part}+k”.` };
      const key = keyName(piece);
      if (!key) return { ok: false, error: `“${piece}” in “${text}” isn't a key this app knows. Use a letter, digit, symbol, F1 to F24, or a name such as space, left, enter, escape.` };
      stroke.key = key;
    }
    if (printable(stroke.key) && !LETTER.test(stroke.key) && stroke.shift && !stroke.ctrl && !stroke.alt && !stroke.meta) {
      return { ok: false, error: `Write the character Shift makes instead of “${part}”, such as “?” rather than “shift+/”.` };
    }
    if (stroke.key === 'tab' && !stroke.ctrl && !stroke.alt && !stroke.meta) return { ok: false, error: 'Tab moves between controls, so it can\'t be bound on its own or with Shift.' };
    strokes.push(stroke);
  }
  return { ok: true, strokes };
}

// Canonical form, used as the table key: "ctrl+alt+shift+meta+key", strokes joined by spaces.
export const strokeId = (s: Stroke) => [s.ctrl && 'ctrl', s.alt && 'alt', s.shift && 'shift', s.meta && 'meta', s.key].filter(Boolean).join('+');
export const chordId = (strokes: Stroke[]) => strokes.map(strokeId).join(' ');

// What a keydown means as a stroke, or null for a lone modifier or an IME/dead key.
export interface KeyEventLike { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }
export function strokeOf(event: KeyEventLike): Stroke | null {
  const { key: raw, code = '' } = event;
  if (!raw || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified', 'Process', 'Compose'].includes(raw)) return null;
  const stroke: Stroke = { key: '', ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey };
  const fromCode = /^Key([A-Z])$/.exec(code)?.[1]?.toLowerCase() ?? /^Digit([0-9])$/.exec(code)?.[1];
  const commanded = stroke.ctrl || stroke.alt || stroke.meta;
  let key = keyName(raw);
  // With Ctrl, Alt, or Meta held (AltGr and some layouts turn letters into symbols), and on
  // layouts whose letters aren't Latin, the physical key names the stroke.
  if (fromCode && ((commanded && key !== null && printable(key)) || (key && printable(key) && /[^\x20-\x7e]/.test(key)))) key = fromCode;
  if (!key) return null;
  // Shift made the character already: "?" is "?", however it was typed.
  if (printable(key) && !LETTER.test(key) && !commanded) stroke.shift = false;
  stroke.key = key;
  return stroke;
}

// Where focus is decides which presses are the page's to take.
//   text     a text field or select: only Ctrl, Alt, or Meta combinations, minus the editing ones
//   control  a slider, checkbox, or radio: its arrows, Home, End, Page keys, and Space stay its own
//   button   a button or link: Space and Enter press it
//   free     anywhere else
export type Context = 'text' | 'control' | 'button' | 'free';
const EDITING = new Set(['a', 'c', 'v', 'x', 'z', 'y', 'left', 'right', 'up', 'down', 'home', 'end', 'backspace', 'delete']);
const CONTROL_KEYS = new Set(['left', 'right', 'up', 'down', 'home', 'end', 'pageup', 'pagedown', 'space']);
export function allowedIn(context: Context, stroke: Stroke): boolean {
  const commanded = stroke.ctrl || stroke.alt || stroke.meta;
  if (context === 'text') {
    if (!commanded) return /^f\d+$/.test(stroke.key);
    return !((stroke.ctrl || stroke.meta) && EDITING.has(stroke.key));
  }
  if (context === 'control') return commanded || !CONTROL_KEYS.has(stroke.key);
  if (context === 'button') return commanded || (stroke.key !== 'space' && stroke.key !== 'enter');
  return true;
}

// Resolving ---------------------------------------------------------------------------------

export interface CommandKeys { id: string; title?: string; keys?: readonly string[] }
export interface Binding { chord: string; strokes: Stroke[]; command: string; source: 'default' | 'user' }
export interface Conflict { chord: string; commands: string[]; message: string }
export interface Keymap {
  bindings: Binding[];
  // Chord → the commands bound to it, first choice first (the user's latest binding, then defaults).
  table: Map<string, string[]>;
  // Every chord that begins a longer chord.
  prefixes: Set<string>;
  errors: string[];
  notes: string[];
  conflicts: Conflict[];
}

// A user rule: add a binding, or (command starting with "-") remove one.
interface Rule { index: number; chord: string | null; strokes: Stroke[]; command: string; remove: boolean }
const FIELDS = new Set(['key', 'command']);

export function readUserBindings(value: unknown): { rules: Rule[]; errors: string[] } {
  const errors: string[] = [];
  if (value === null || value === undefined) return { rules: [], errors };
  if (!Array.isArray(value)) return { rules: [], errors: ['keybindings.json must be a list, such as [{ "key": "ctrl+k", "command": "builtin:palette" }].'] };
  const rules: Rule[] = [];
  value.forEach((entry, i) => {
    const at = `Entry ${i + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${at} isn't an object like { "key": "ctrl+k", "command": "builtin:palette" }.`); return; }
    const extra = Object.keys(entry).filter(field => !FIELDS.has(field));
    if (extra.length) { errors.push(`${at} has ${extra.map(f => `“${f}”`).join(', ')}, which keybindings.json doesn't use. Each entry has a key and a command.`); return; }
    const { key, command } = entry as { key?: unknown; command?: unknown };
    if (typeof command !== 'string' || !command.trim() || command.trim() === '-') { errors.push(`${at} has no command. Name one, such as "builtin:toggle", or "-builtin:toggle" to remove its key.`); return; }
    const remove = command.trim().startsWith('-');
    const id = command.trim().replace(/^-/, '');
    if (!id.includes(':')) { errors.push(`${at}: “${id}” needs its owner, such as “builtin:${id}”.`); return; }
    if (key === undefined && remove) { rules.push({ index: i, chord: null, strokes: [], command: id, remove }); return; }
    const parsed = parseKeys(key);
    if (!parsed.ok) { errors.push(`${at}: ${parsed.error}`); return; }
    rules.push({ index: i, chord: chordId(parsed.strokes), strokes: parsed.strokes, command: id, remove });
  });
  return { rules, errors };
}

export function resolveKeymap(commands: readonly CommandKeys[], user: unknown): Keymap {
  const errors: string[] = [], notes: string[] = [];
  const known = new Map(commands.map(command => [command.id, command]));
  const title = (id: string) => known.get(id)?.title ?? id;
  let bindings: Binding[] = [];
  for (const command of commands) for (const key of command.keys ?? []) {
    const parsed = parseKeys(key);
    if (!parsed.ok) { errors.push(`The default key for “${title(command.id)}” doesn't work: ${parsed.error}`); continue; }
    bindings.push({ chord: chordId(parsed.strokes), strokes: parsed.strokes, command: command.id, source: 'default' });
  }
  const read = readUserBindings(user);
  errors.push(...read.errors);
  for (const rule of read.rules) {
    if (!known.has(rule.command)) notes.push(`Entry ${rule.index + 1}: no command called “${rule.command}” is loaded. The binding works once that command is registered.`);
    if (rule.remove) {
      const before = bindings.length;
      bindings = bindings.filter(b => !(b.command === rule.command && (rule.chord === null || b.chord === rule.chord)));
      if (before === bindings.length && known.has(rule.command)) notes.push(`Entry ${rule.index + 1} removes ${rule.chord ? `“${formatChord(rule.strokes).join(' then ')}”` : 'the keys'} from “${title(rule.command)}”, which doesn't have ${rule.chord ? 'it' : 'any'}.`);
      continue;
    }
    bindings = bindings.filter(b => !(b.command === rule.command && b.chord === rule.chord));
    bindings.push({ chord: rule.chord!, strokes: rule.strokes, command: rule.command, source: 'user' });
  }
  // The user's latest binding for a chord comes first, then defaults in registration order.
  const table = new Map<string, string[]>();
  const ordered = [...bindings.filter(b => b.source === 'user').reverse(), ...bindings.filter(b => b.source === 'default')];
  for (const b of ordered) { const list = table.get(b.chord) ?? []; if (!list.includes(b.command)) list.push(b.command); table.set(b.chord, list); }
  const prefixes = new Set<string>();
  for (const chord of table.keys()) { const steps = chord.split(' '); for (let n = 1; n < steps.length; n++) prefixes.add(steps.slice(0, n).join(' ')); }

  const conflicts: Conflict[] = [];
  const shown = (chord: string) => formatChord(strokesOf(chord)).join(' then ');
  for (const [chord, ids] of table) {
    if (ids.length > 1) conflicts.push({ chord, commands: ids, message: `${shown(chord)} is bound to ${ids.map(id => `“${title(id)}”`).join(' and ')}. It runs ${ids.length > 2 ? 'the first available of these' : `“${title(ids[0])}” when both are available`}.` });
    if (prefixes.has(chord)) {
      const longer = [...table.keys()].filter(other => other.startsWith(`${chord} `));
      conflicts.push({ chord, commands: [...ids, ...longer.flatMap(other => table.get(other)!)], message: `${shown(chord)} runs “${title(ids[0])}” at once, so ${longer.map(other => shown(other)).join(' and ')} can't be typed.` });
    }
  }
  return { bindings, table, prefixes, errors, notes, conflicts };
}

const strokesOf = (chord: string): Stroke[] => chord.split(' ').map(step => {
  const parts = step === '+' ? ['+'] : step.endsWith('++') ? [...step.slice(0, -2).split('+'), '+'] : step.split('+');
  const key = parts.pop()!;
  return { key, ctrl: parts.includes('ctrl'), alt: parts.includes('alt'), shift: parts.includes('shift'), meta: parts.includes('meta') };
});

// Matching ------------------------------------------------------------------------------------
// `pending` is the chord typed so far. A complete binding runs at once; a prefix waits for the
// next stroke; anything else starts over from this stroke alone.
export interface Match { run: string | null; pending: string[]; consumed: boolean }
export function match(keymap: Keymap, pending: readonly string[], stroke: string, available: (command: string) => boolean): Match {
  const sequence = [...pending, stroke], chord = sequence.join(' ');
  const run = keymap.table.get(chord)?.find(available) ?? null;
  if (run) return { run, pending: [], consumed: true };
  if (keymap.prefixes.has(chord) && [...keymap.table].some(([other, ids]) => other.startsWith(`${chord} `) && ids.some(available))) return { run: null, pending: sequence, consumed: true };
  if (pending.length) return match(keymap, [], stroke, available);
  return { run: null, pending: [], consumed: false };
}

// Display -------------------------------------------------------------------------------------
const SHOWN: Record<string, string> = { space: 'Space', left: '←', right: '→', up: '↑', down: '↓', enter: 'Enter', escape: 'Esc', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', home: 'Home', end: 'End', pageup: 'Page Up', pagedown: 'Page Down', insert: 'Insert' };
// One string per stroke: ["Ctrl+K"], or ["G", "R"] for a chord.
export function formatChord(strokes: Stroke[]): string[] {
  return strokes.map(s => [s.ctrl && 'Ctrl', s.alt && 'Alt', s.shift && 'Shift', s.meta && 'Meta', SHOWN[s.key] ?? s.key.toUpperCase()].filter(Boolean).join('+'));
}
export const formatChordId = (chord: string) => formatChord(strokesOf(chord));
