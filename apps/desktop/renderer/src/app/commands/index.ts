import { useEffect } from 'react';
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
