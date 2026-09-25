import { useSyncExternalStore } from 'react';
import { nav } from '../route';

// Whether the command palette is open, and where focus goes when it closes. On phones it is a
// bottom sheet with its own history entry, so the back gesture closes it (as with the menu).
let open = false;
let invoker: HTMLElement | null = null;
let inHistory = false;
let closed: (() => void) | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export const usePaletteOpen = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => open);
export const isPhone = () => matchMedia('(max-width: 760px)').matches;

export function openPalette() {
  if (open) return;
  const focus = document.activeElement;
  invoker = focus instanceof HTMLElement && focus !== document.body && !focus.closest('.palette-layer') ? focus : null;
  open = true; emit();
  if (isPhone() && !nav.overlayOpen) {
    inHistory = true;
    nav.openOverlay(() => {}, () => { inHistory = false; finish(); closed?.(); closed = null; });
  }
}
function finish() {
  if (!open) return;
  open = false; emit();
  const focus = document.activeElement;
  if (invoker?.isConnected && (!focus || focus === document.body || focus.closest('.palette-layer'))) invoker.focus({ preventScroll: true });
  else if (!focus || focus === document.body || !focus.isConnected) nav.scroller?.focus({ preventScroll: true });
  invoker = null;
}
// Resolves once the palette is gone, its history entry included, so a command that navigates
// runs after the back step instead of being undone by it.
export function closePalette(): Promise<void> {
  if (!inHistory) { finish(); return Promise.resolve(); }
  return new Promise(resolve => { closed = resolve; nav.closeOverlay(); });
}
export function togglePalette() { if (open) void closePalette(); else openPalette(); }
