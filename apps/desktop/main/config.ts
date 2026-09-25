import { watch as watchPath, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConfigFiles, ThemeFile } from '../../../packages/core/contracts';

// The user's config folder: keybindings and themes, edited by hand and applied live.
// Linux follows XDG (~/.config/squiggly); Windows uses %APPDATA%\Squiggly; macOS uses Application Support.
export function configDirectory(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.SQUIGGLY_CONFIG_DIR) return env.SQUIGGLY_CONFIG_DIR;
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Squiggly');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Squiggly');
  const xdg = env.XDG_CONFIG_HOME;
  // XDG says relative paths are invalid and must be ignored.
  return join(xdg && xdg.startsWith('/') ? xdg : join(home, '.config'), 'squiggly');
}

export const README = `Squiggly Music configuration
=============================

Everything in this folder is read by Squiggly while it runs. Save a file and the change
applies; there is nothing to restart.

  keybindings.json      Your keyboard shortcuts. They win over the app's defaults.
  themes/<name>.json    Colour themes: { "name": "Night", "colors": { "ground": "#101418", ... } }.
                        Settings > Theme lists them, with any problems in a file.

Settings > Keys lists every command and its keys.
`;

// Creates the folder and its layout. Existing files are never touched.
export async function ensureConfigDirectory(dir: string): Promise<void> {
  await mkdir(join(dir, 'themes'), { recursive: true });
  await writeFile(join(dir, 'README.txt'), README, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
}

export const CONFIG_FILE_LIMIT = 256 * 1024;
const THEME_LIMIT = 200;
const THEME_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Reads one JSON file. A missing file is null; anything else that goes wrong is a plain message.
export async function readJson(path: string, label: string): Promise<{ value: unknown } | { error: string } | null> {
  let size: number;
  try { size = (await stat(path)).size; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { error: `${label} could not be read.` };
  }
  if (size > CONFIG_FILE_LIMIT) return { error: `${label} is larger than ${CONFIG_FILE_LIMIT / 1024} KB and was skipped.` };
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return { error: `${label} could not be read.` }; }
  // An editor that truncates before writing can leave an empty file for a moment.
  if (!text.trim()) return null;
  try { return { value: JSON.parse(text) }; } catch (error) {
    return { error: `${label} is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}.` };
  }
}

// Keybindings and themes are passed on as parsed JSON. Checking what they contain is the renderer's job.
export async function readConfigFiles(dir: string): Promise<ConfigFiles> {
  const errors: string[] = [];
  const keys = await readJson(join(dir, 'keybindings.json'), 'keybindings.json');
  let keybindings: unknown = null;
  if (keys && 'error' in keys) errors.push(keys.error); else if (keys) keybindings = keys.value;

  const themes: ThemeFile[] = [];
  let names: string[] = [];
  try { names = (await readdir(join(dir, 'themes'))).filter(name => name.endsWith('.json')).sort(); } catch { /* No themes folder. */ }
  if (names.length > THEME_LIMIT) { errors.push(`Only the first ${THEME_LIMIT} themes are loaded.`); names = names.slice(0, THEME_LIMIT); }
  for (const name of names) {
    const label = `themes/${name}`;
    const id = name.slice(0, -'.json'.length).toLowerCase();
    if (!THEME_ID.test(id)) { errors.push(`${label}: name the file with letters, digits, dots, dashes, or underscores.`); continue; }
    const read = await readJson(join(dir, 'themes', name), label);
    if (!read) continue;
    if ('error' in read) { errors.push(read.error); continue; }
    const value = read.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${label}: a theme is a JSON object.`); continue; }
    // The file is the tokens; the renderer's theme checker ignores "name", "id", and "description".
    const title = (value as { name?: unknown }).name;
    themes.push({ id, name: typeof title === 'string' && title.trim() ? title.trim().slice(0, 60) : id, tokens: value });
  }
  return { keybindings, themes, errors };
}

// Non-recursive directory watchers that can be re-armed. A folder deleted and created again
// is watched again on the next set(). Events carry the directory and file name.
export class Watchers {
  private watchers = new Map<string, FSWatcher>();
  constructor(private onEvent: (dir: string, file: string | null) => void) {}
  set(dirs: Iterable<string>) {
    const wanted = new Set(dirs);
    for (const [dir, watcher] of this.watchers) if (!wanted.has(dir)) { watcher.close(); this.watchers.delete(dir); }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = watchPath(dir, { persistent: false }, (_event, file) => this.onEvent(dir, file ? String(file) : null));
        watcher.on('error', () => { watcher.close(); if (this.watchers.get(dir) === watcher) this.watchers.delete(dir); this.onEvent(dir, null); });
        this.watchers.set(dir, watcher);
      } catch { /* Missing folder: armed on a later set(). */ }
    }
  }
  get size() { return this.watchers.size; }
  close() { for (const watcher of this.watchers.values()) watcher.close(); this.watchers.clear(); }
}

export function debounce(run: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    trigger() { clearTimeout(timer); timer = setTimeout(run, ms); },
    cancel() { clearTimeout(timer); timer = undefined; },
  };
}

// Reads keybindings.json and themes/*.json, watches both, and tells subscribers when what they
// contain changes. Saving a file without changing it sends nothing.
export class ConfigFolder {
  private files: ConfigFiles = { keybindings: null, themes: [], errors: [] };
  private seen = '';
  private listeners = new Set<(files: ConfigFiles) => void>();
  private reading: Promise<ConfigFiles> | null = null;
  private again = false;
  private watchers = new Watchers((dir, file) => {
    // The root folder holds other files too; only these names matter here.
    if (dir === this.dir && file && file !== 'keybindings.json' && file !== 'themes') return;
    this.soon.trigger();
  });
  private soon: ReturnType<typeof debounce>;
  constructor(readonly dir: string, debounceMs = 150) { this.soon = debounce(() => void this.refresh(), debounceMs); }

  async start(): Promise<ConfigFiles> {
    await ensureConfigDirectory(this.dir);
    this.arm();
    return this.refresh();
  }
  private arm() { this.watchers.set([this.dir, join(this.dir, 'themes')]); }
  get current() { return this.files; }
  read(): Promise<ConfigFiles> { return this.reading ?? Promise.resolve(this.files); }
  subscribe(listener: (files: ConfigFiles) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  // One read at a time; a change during a read schedules one more.
  refresh(): Promise<ConfigFiles> {
    if (this.reading) { this.again = true; return this.reading; }
    this.reading = (async () => {
      try {
        do {
          this.again = false;
          this.arm();
          const files = await readConfigFiles(this.dir);
          const text = JSON.stringify(files);
          if (text !== this.seen) { this.seen = text; this.files = files; for (const listener of this.listeners) listener(files); }
        } while (this.again);
        return this.files;
      } finally { this.reading = null; }
    })();
    return this.reading;
  }
  close() { this.soon.cancel(); this.watchers.close(); this.listeners.clear(); }
}
