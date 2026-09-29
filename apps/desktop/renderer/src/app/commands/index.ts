import { useEffect } from 'react';
import { registry } from '../registry';
import { startKeymap } from './keymap';
import './builtin';

// Commands: every action in the app, runnable from the palette (Ctrl+K) and from keys.
// Built-ins register in ./builtin through registry.ts, like any other owner's commands.
export { shell } from './builtin';
export { CommandPalette } from './Palette';
export { KeySettings } from './KeySettings';
export { openPalette, closePalette, togglePalette } from './palette-state';
export { runCommand, useKeymap, keysFor, PALETTE } from './keymap';

// Listens for key presses (and the mouse's back and forward buttons) while the shell is mounted.
export function useCommandKeys() {
  useEffect(() => startKeymap(), []);
}

// The mini player's keys: playback, and every extension's commands. The app's other commands
// (built-ins and the theme list) act on pages, the palette, and settings the full window has.
const APP_OWNERS = new Set(['builtin', 'theme']);
const inMini = (id: string) => {
  const command = registry.commands.get(id);
  return !!command && (!APP_OWNERS.has(command.owner ?? 'builtin') || command.category === 'Playback');
};
export function useMiniCommandKeys() {
  useEffect(() => startKeymap(inMini), []);
}
