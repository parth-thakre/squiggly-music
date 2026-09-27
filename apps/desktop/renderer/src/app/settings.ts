import { useSyncExternalStore } from 'react';
import type { Settings } from '../../../../../packages/core/contracts';

// Desktop settings live in the main process; the browser build keeps its own in localStorage.
// Exclusive output, the tray, and the mini player only exist on the desktop.
const defaults: Settings = { lyricsLookup: false, exclusiveOutput: false, closeToTray: true, syncQueue: true, reportPlays: true, miniOnTop: true };
const KEY = 'squiggly.settings';
const desktop = window.squiggly;

function stored(): Settings {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return defaults; }
}
let settings: Settings = desktop ? defaults : stored();
let error: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
if (desktop) void desktop.settings().then(value => { settings = value; emit(); });

export const getSettings = () => settings;
export const useSettings = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => settings);
export const useSettingsError = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => error);

export async function updateSettings(changes: Partial<Settings>) {
  const previous = settings;
  settings = { ...settings, ...changes }; error = null; emit();
  if (!desktop) { localStorage.setItem(KEY, JSON.stringify(settings)); return; }
  const result = await desktop.updateSettings(changes);
  if (result.ok) settings = result.value; else { settings = previous; error = result.error; }
  emit();
}
