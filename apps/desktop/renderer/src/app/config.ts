import type { ConfigApi, ConfigFiles } from '../../../../../packages/core/contracts';

// The desktop's config folder (keybindings.json, themes/*.json), read and watched by the main
// process. Read once and shared by the key bindings and the themes. The browser build has no
// folder; both fall back to what this browser stores.
export const configApi: ConfigApi | null = (typeof window !== 'undefined' && window.squiggly?.config) || null;

let files: ConfigFiles | null = null;
let started = false;
const listeners = new Set<(files: ConfigFiles) => void>();
const deliver = (next: ConfigFiles) => { files = next; listeners.forEach(listener => listener(next)); };
const unreadable = (error: unknown): ConfigFiles => ({ keybindings: null, themes: [], errors: [`The config folder couldn't be read. ${error instanceof Error ? error.message : String(error)}`] });

export function watchConfig(listener: (files: ConfigFiles) => void): () => void {
  listeners.add(listener);
  if (files) listener(files);
  if (!started && configApi) {
    started = true;
    let pushed = false;
    try {
      configApi.subscribe(next => { pushed = true; deliver(next); });
      void configApi.read().then(next => { if (!pushed) deliver(next); }, error => { if (!pushed) deliver(unreadable(error)); });
    } catch (error) { deliver(unreadable(error)); }
  }
  return () => { listeners.delete(listener); };
}

export async function openConfigFolder(): Promise<string | null> {
  if (!configApi) return 'The config folder is only on the desktop app.';
  try { const result = await configApi.openDir(); return result.ok ? null : result.error; }
  catch (error) { return `The config folder didn't open. ${error instanceof Error ? error.message : String(error)}`; }
}
