import { useSyncExternalStore } from 'react';
import { registry } from '../registry';
import { configApi, watchConfig } from '../config';
import { allowedIn, formatChordId, match, resolveKeymap, strokeId, strokeOf, type Conflict, type Context, type Keymap } from './keys';

// The live key table: every registered command's default keys, with the user's bindings on
// top. On the desktop those come from keybindings.json in the config folder and apply as soon
// as the file is saved; the browser build keeps them in this browser (edited in Settings).

export const PALETTE = 'builtin:palette';
export const fileBacked = configApi !== null;
const STORAGE = 'squiggly.keybindings';
const RECENT = 'squiggly.commands.recent';

let userValue: unknown = null;
let sourceErrors: string[] = [];
let browserText = '';

export interface KeymapState {
  keymap: Keymap;
  // Problems with the file or stored text as a whole, then with its entries.
  errors: string[];
  notes: string[];
  conflicts: Conflict[];
  // The browser build's stored bindings, as the user wrote them.
  text: string;
}
const build = (): KeymapState => {
  const keymap = resolveKeymap(registry.commands.all(), userValue);
  return { keymap, errors: [...sourceErrors, ...keymap.errors], notes: keymap.notes, conflicts: keymap.conflicts, text: browserText };
};
let state = build();
const listeners = new Set<() => void>();
function rebuild() { state = build(); listeners.forEach(listener => listener()); }
registry.commands.subscribe(rebuild);

function readBrowser() {
  browserText = localStorage.getItem(STORAGE) ?? '';
  sourceErrors = [];
  if (!browserText.trim()) { userValue = null; return; }
  try { userValue = JSON.parse(browserText); } catch (error) {
    userValue = null;
    sourceErrors = [`Your key bindings aren't valid JSON, so the defaults apply. ${error instanceof Error ? error.message : ''}`.trim()];
  }
}
if (fileBacked) {
  watchConfig(files => {
    userValue = files.keybindings;
    sourceErrors = files.errors.filter(error => /keybindings/i.test(error));
    rebuild();
  });
} else if (typeof localStorage !== 'undefined') {
  readBrowser(); state = build();
  // Another tab saved new bindings.
  addEventListener('storage', event => { if (event.key === STORAGE) { readBrowser(); rebuild(); } });
}

export const getKeymap = () => state;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useKeymap = () => useSyncExternalStore(subscribe, () => state);

// Saves the browser build's bindings. Text that isn't JSON is refused; entries with problems
// are kept and listed, and the rest apply.
export function saveBrowserBindings(text: string): string | null {
  if (text.trim()) {
    try { JSON.parse(text); } catch (error) { return `That isn't valid JSON, so nothing was saved. ${error instanceof Error ? error.message : ''}`.trim(); }
    localStorage.setItem(STORAGE, text);
  } else localStorage.removeItem(STORAGE);
  readBrowser(); rebuild();
  return null;
}

// The keys shown beside a command: chords where it is the first choice.
export function keysFor(keymap: Keymap, command: string): string[][] {
  const out: string[][] = [];
  for (const [chord, ids] of keymap.table) if (ids[0] === command) out.push(formatChordId(chord));
  return out;
}

// Running --------------------------------------------------------------------------------------
let report: (message: string) => void = message => console.error(message);
export const onCommandError = (show: (message: string) => void) => { report = show; };

let recent: string[] = [];
try { recent = JSON.parse(localStorage.getItem(RECENT) ?? '[]').filter((id: unknown) => typeof id === 'string').slice(0, 12); } catch { recent = []; }
export const recentCommands = () => recent;
function remember(id: string) {
  recent = [id, ...recent.filter(other => other !== id)].slice(0, 12);
  try { localStorage.setItem(RECENT, JSON.stringify(recent)); } catch { /* storage full or blocked: recency is a nicety */ }
}

export async function runCommand(id: string) {
  const command = registry.commands.get(id);
  if (!command || !registry.commands.available(id)) return;
  if (id !== PALETTE) remember(id);
  try { await command.run(); }
  catch (error) { report(`“${command.title}” didn't work. ${error instanceof Error && error.message ? error.message : 'Something went wrong.'}`); }
}

// Key presses ----------------------------------------------------------------------------------
// The context menu and the palette handle their own keys. Inside the palette only the palette's
// own key passes through, so pressing it again closes it.
function contextOf(target: EventTarget | null): Context | 'menu' | 'owned' {
  const element = target instanceof Element ? target : null;
  if (!element) return 'free';
  if (element.closest('.menu-layer')) return 'menu';
  if (element.closest('[data-own-keys]')) return 'owned';
  const input = element.closest('input');
  if (input) return ['range', 'checkbox', 'radio'].includes(input.type) ? 'control' : ['button', 'submit', 'reset'].includes(input.type) ? 'button' : 'text';
  if (element.closest('textarea, select, [contenteditable=""], [contenteditable="true"]')) return 'text';
  if (element.closest('[role="slider"], [role="checkbox"], [role="radio"], [role="switch"], [role="listbox"]')) return 'control';
  if (element.closest('button, a[href], summary, [role="button"], [role="menuitem"], [role="option"], [role="link"]')) return 'button';
  return 'free';
}

let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
const resetChord = () => { pending = []; clearTimeout(timer); };

function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing) return;
  const stroke = strokeOf(event);
  if (!stroke) return;
  const context = contextOf(event.target);
  if (context === 'menu') { resetChord(); return; }
  const id = strokeId(stroke);
  if (context === 'owned') {
    resetChord();
    if (match(state.keymap, [], id, command => command === PALETTE).run) { event.preventDefault(); void runCommand(PALETTE); }
    return;
  }
  if (!allowedIn(context, stroke)) { resetChord(); return; }
  const result = match(state.keymap, pending, id, registry.commands.available);
  clearTimeout(timer);
  pending = result.pending;
  if (pending.length) timer = setTimeout(resetChord, 1500);
  if (!result.consumed) return;
  event.preventDefault();
  if (!result.run) return;
  if (event.repeat && !registry.commands.get(result.run)?.repeat) return;
  void runCommand(result.run);
}
// The mouse's back and forward buttons.
function onMouseUp(event: MouseEvent) {
  if (event.button === 3) void runCommand('builtin:back');
  else if (event.button === 4) void runCommand('builtin:forward');
}

export function startKeymap(): () => void {
  addEventListener('keydown', onKeyDown); addEventListener('mouseup', onMouseUp);
  return () => { removeEventListener('keydown', onKeyDown); removeEventListener('mouseup', onMouseUp); resetChord(); };
}
