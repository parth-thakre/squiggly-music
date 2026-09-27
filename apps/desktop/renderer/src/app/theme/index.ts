// Themes: built in, and from the user's config folder (themes/*.json, desktop).
//
// - A theme's tokens have the shape documented at the top of ./tokens.ts (colors, type,
//   density, radius, motion). They are validated strictly: a theme file with errors is refused
//   and its problems are listed in Settings › Theme in plain words. Colours that fail contrast
//   are corrected rather than refused; the corrections show there too.
// - Stored ids are namespaced `owner:id`, as in registry.ts: `builtin:cover`, `user:night`.
// - If the user had picked a theme that goes away, the app shows Cover and switches back when
//   the theme returns (its file saved again).
import { useSyncExternalStore } from 'react';
import type { ThemeFile } from '../../../../../../packages/core/contracts';
import { configApi, watchConfig } from '../config';
import type { Palette } from '../palette';
import { BUILTIN_THEMES, checkTokens, DEFAULT_TOKENS, fontStack, isSerifDisplay, tintOf, type ThemeTokens } from './tokens';

export type { ThemeTokens } from './tokens';
export interface ThemeInput { id: string; name: string; description?: string; tokens: unknown }
export interface Theme {
  id: string; name: string; description: string;
  owner: string; source: 'builtin' | 'user';
  tokens: ThemeTokens;
  // Contrast corrections applied to this theme.
  notes: string[];
}
const ID = /^[a-z0-9][a-z0-9._-]*$/;
const COVER = 'builtin:cover';
const SELECTED = 'squiggly.theme';

function make(input: ThemeInput, owner: string, source: Theme['source']): { theme: Theme | null; problems: string[] } {
  const problems: string[] = [];
  if (!input || typeof input !== 'object') return { theme: null, problems: ['A theme is an object with an id, a name, and tokens.'] };
  if (typeof input.id !== 'string' || !ID.test(input.id)) problems.push(`The id ${JSON.stringify(input.id)} isn't usable. Use lowercase letters, digits, dots, dashes, or underscores.`);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) problems.push('The name must be text, 1 to 60 characters.');
  const checked = checkTokens(input.tokens);
  problems.push(...checked.errors);
  if (problems.length || !checked.tokens) return { theme: null, problems };
  return {
    theme: { id: `${owner}:${input.id}`, name: input.name.trim(), description: typeof input.description === 'string' ? input.description : '', owner, source, tokens: checked.tokens, notes: checked.notes },
    problems,
  };
}

const builtins: Theme[] = BUILTIN_THEMES.map(definition => {
  const { theme, problems } = make(definition, 'builtin', 'builtin');
  if (!theme) throw new Error(`Built-in theme ${definition.id}: ${problems.join(' ')}`);
  return theme;
});
let userThemes: Theme[] = [];
// Problems with user theme files, each starting with the file's name.
let userProblems: string[] = [];
let chosen = (() => { try { return localStorage.getItem(SELECTED) ?? COVER; } catch { return COVER; } })();

export interface ThemeState {
  themes: Theme[];
  // What the user picked, and what is showing (Cover when the pick isn't available).
  chosen: string;
  active: Theme;
  // Plain messages for Settings: refused theme files, and contrast corrections.
  problems: string[];
  notes: string[];
}
const build = (): ThemeState => {
  const themes = [...builtins, ...userThemes];
  const active = themes.find(theme => theme.id === chosen) ?? builtins[0];
  const notes = themes.filter(theme => theme.source !== 'builtin').flatMap(theme => theme.notes.map(note => `${theme.name}: ${note}`));
  return { themes, chosen, active, problems: userProblems, notes };
};
let state = build();
const listeners = new Set<() => void>();
const emit = () => { state = build(); listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const getThemes = () => state;
export const useThemes = () => useSyncExternalStore(subscribe, () => state);
export const onThemesChange = subscribe;

export function selectTheme(id: string) {
  chosen = id;
  try { localStorage.setItem(SELECTED, id); } catch { /* the choice lasts this session */ }
  emit();
}

// Themes folder (desktop). Each file is checked on its own, so one bad file never hides the rest.
export function loadUserThemes(files: ThemeFile[], errors: string[] = []) {
  const themes: Theme[] = [], problems: string[] = [...errors];
  for (const file of files) {
    const label = `themes/${file.id}.json`;
    const { theme, problems: found } = make({ id: file.id, name: file.name, tokens: file.tokens }, 'user', 'user');
    if (theme) themes.push(theme); else problems.push(...found.map(problem => `${label}: ${problem}`));
  }
  userThemes = themes; userProblems = problems;
  emit();
}
if (configApi) watchConfig(files => loadUserThemes(files.themes, files.errors.filter(error => !/keybindings/i.test(error))));

// Applying -----------------------------------------------------------------------------------
// Fixed colours as a palette for the room, or null when colours come from the cover.
export function themePalette(theme: Theme): Palette | null {
  const colors = theme.tokens.colors;
  if (colors === 'cover') return null;
  return { ground: colors.ground, ink: colors.ink, soft: colors.soft, accent: colors.accent, accentText: colors.accentText, line: colors.line ?? undefined };
}
export const selectedRowOf = (theme: Theme) => theme.tokens.colors === 'cover' ? null : tintOf(theme.tokens.colors);

// Type, spacing, corners, and motion go on the document root; colours stay on the room, where
// the cover palette has always been applied.
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement) {
  const { type, density, radius, motion } = theme.tokens;
  const text = type.size / DEFAULT_TOKENS.type.size;
  root.style.setProperty('--font-display', fontStack(type.display, 'display'));
  root.style.setProperty('--font-body', fontStack(type.body, 'body'));
  root.style.setProperty('--display-weight', isSerifDisplay(type.display) ? '400' : '600');
  root.style.setProperty('--text', String(text));
  root.style.setProperty('--display-size', String(text * type.scale));
  root.style.setProperty('--radius', `${radius}px`);
  root.dataset.density = density;
  root.dataset.motion = motion;
  root.dataset.theme = theme.id;
  motionChanged();
}

// Reduced motion from either the system or the theme, shaped like a MediaQueryList so code that
// checks matchMedia('(prefers-reduced-motion: reduce)') can use it instead.
const system = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const motionListeners = new Set<(event: { matches: boolean }) => void>();
let lastMotion: boolean | null = null;
function motionChanged() {
  const now = reducedMotion.matches;
  if (now === lastMotion) return;
  lastMotion = now;
  motionListeners.forEach(listener => listener({ matches: now }));
}
system?.addEventListener?.('change', motionChanged);
export const reducedMotion = {
  get matches() { return !!system?.matches || state.active.tokens.motion !== 'full'; },
  addEventListener(_type: 'change', listener: (event: { matches: boolean }) => void) { motionListeners.add(listener); },
  removeEventListener(_type: 'change', listener: (event: { matches: boolean }) => void) { motionListeners.delete(listener); },
};

export function useActiveTheme() { return useThemes().active; }
