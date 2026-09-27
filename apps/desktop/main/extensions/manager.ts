import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ExtensionInfo, Result } from '../../../../packages/core/contracts';
import { debounce, readJson, Watchers } from '../config';
import { compileEntry, type Bundle } from './compile';
import { extensionId, readManifest, type Manifest } from './manifest';

// Finds, compiles, and reloads the extensions in the config folder.
//
//   <config>/extensions/<folder>   one extension each: watched, recompiled and reloaded on save
//   <config>/extensions.json       { "disabled": [ids] }
//
// Renderer entries are served to the window as squiggly-ext://<id>/<hash>.js. Every operation
// runs one at a time.

export const EXTENSION_SCHEME = 'squiggly-ext';

interface Loaded {
  id: string; dir: string;
  manifest: Manifest | null;
  // package.json problems, and compile problems.
  manifestError: string | null; loadError: string | null;
  renderer: Bundle | null;
  watchers: Watchers | null;
}

export interface ManagerOptions {
  configDir: string;
  compile?: (entry: string, dir: string) => Promise<Bundle>;
  // Moves an extension's folder to the system trash. Without it, extensions can't be removed from the app.
  trash?: (path: string) => Promise<void>;
  watch?: boolean;
  debounceMs?: number;
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error.';

export class ExtensionManager {
  private loaded = new Map<string, Loaded>();
  private disabled: string[] = [];
  private work: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(list: ExtensionInfo[]) => void>();
  private rootWatchers: Watchers | null = null;
  private rescan: ReturnType<typeof debounce>;
  private reloads = new Map<string, ReturnType<typeof debounce>>();
  private epoch = 0;
  private closed = false;
  private compile: NonNullable<ManagerOptions['compile']>;

  constructor(private options: ManagerOptions) {
    this.compile = options.compile ?? compileEntry;
    this.rescan = debounce(() => void this.exclusive(() => this.sync()).catch(() => undefined), options.debounceMs ?? 200);
  }

  get extensionsDir() { return join(this.options.configDir, 'extensions'); }
  private get statePath() { return join(this.options.configDir, 'extensions.json'); }

  // Runs operations one at a time, in order.
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.work.then(() => this.closed ? Promise.reject(new Error('Extensions are shutting down.')) : task());
    this.work = run.catch(() => undefined);
    return run;
  }

  async start(): Promise<void> {
    await mkdir(this.extensionsDir, { recursive: true });
    await this.exclusive(() => this.sync());
    if (this.options.watch !== false) {
      this.rootWatchers = new Watchers((dir, file) => {
        if (dir === this.options.configDir && file && file !== 'extensions.json' && file !== 'extensions') return;
        this.rescan.trigger();
      });
      this.rootWatchers.set([this.options.configDir, this.extensionsDir]);
    }
  }

  // Info --------------------------------------------------------------------------------

  private info(record: Loaded): ExtensionInfo {
    const enabled = !this.disabled.includes(record.id);
    return {
      id: record.id, name: record.manifest?.name ?? record.id, version: record.manifest?.version ?? '0.0.0',
      description: record.manifest?.description ?? null, folder: basename(record.dir), enabled,
      rendererUrl: enabled && record.renderer ? this.rendererUrl(record.id, record.renderer) : null,
      error: record.manifestError ?? (enabled ? record.loadError : null),
    };
  }
  private rendererUrl(id: string, bundle: Bundle) { return `${EXTENSION_SCHEME}://${id}/${bundle.hash}${this.epoch ? `-${this.epoch}` : ''}.js`; }
  list(): ExtensionInfo[] { return [...this.loaded.values()].map(record => this.info(record)).sort((a, b) => a.name.localeCompare(b.name)); }
  subscribe(listener: (list: ExtensionInfo[]) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { const list = this.list(); for (const listener of this.listeners) listener(list); }

  // The renderer module behind a squiggly-ext:// URL, while it is still the current one.
  rendererModule(url: string): string | null {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    const record = this.loaded.get(parsed.hostname);
    if (!record?.renderer || this.disabled.includes(record.id)) return null;
    return this.rendererUrl(record.id, record.renderer) === `${parsed.protocol}//${parsed.hostname}${parsed.pathname}` ? record.renderer.code : null;
  }

  // State file --------------------------------------------------------------------------

  private async readState(): Promise<void> {
    const read = await readJson(this.statePath, 'extensions.json');
    if (!read || 'error' in read || !read.value || typeof read.value !== 'object') return;
    const disabled = (read.value as { disabled?: unknown }).disabled;
    this.disabled = Array.isArray(disabled) ? disabled.filter((id): id is string => typeof id === 'string') : [];
  }
  private async writeState(): Promise<void> {
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ disabled: this.disabled }, null, 2)}\n`);
    await rename(temporary, this.statePath);
  }

  // Discovery ---------------------------------------------------------------------------

  private async folders() {
    try {
      return (await readdir(this.extensionsDir, { withFileTypes: true }))
        .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
        .map(entry => join(this.extensionsDir, entry.name)).sort();
    } catch { return []; }
  }

  // Brings loaded extensions in line with the folders and extensions.json.
  private async sync(force = false): Promise<void> {
    await this.readState();
    const found = new Map<string, { dir: string; manifest: Manifest | null; error: string | null }>();
    for (const dir of await this.folders()) {
      const manifest = await readManifest(dir);
      const fallback = extensionId(basename(dir));
      const id = manifest.ok ? manifest.value.id : fallback.ok ? fallback.value : `invalid-${found.size}`;
      const other = found.get(id);
      if (other) found.set(`${id}-${found.size}`, { dir, manifest: null, error: `Another extension folder (${other.dir}) already uses the id “${id}”.` });
      else found.set(id, { dir, manifest: manifest.ok ? manifest.value : null, error: manifest.ok ? null : manifest.error });
    }

    for (const [id, record] of this.loaded) if (!found.has(id) || found.get(id)!.dir !== record.dir) this.unload(record, true);
    for (const [id, next] of found) {
      const existing = this.loaded.get(id);
      const enabled = !this.disabled.includes(id);
      const same = existing && JSON.stringify(existing.manifest) === JSON.stringify(next.manifest) && existing.manifestError === next.error;
      const running = existing && (existing.renderer || existing.loadError);
      if (existing && same && !force && Boolean(running) === (enabled && !next.error)) continue;
      if (existing) this.unload(existing, false);
      const record: Loaded = existing ?? { id, dir: next.dir, manifest: null, manifestError: null, loadError: null, renderer: null, watchers: null };
      record.manifest = next.manifest; record.manifestError = next.error;
      this.loaded.set(id, record);
      if (enabled) await this.load(record);
      this.watch(record);
    }
    this.changed();
  }

  // Compiles one extension. Errors are kept on the record, never thrown.
  private async load(record: Loaded): Promise<void> {
    record.loadError = null;
    if (!record.manifest || record.manifestError) return;
    try { record.renderer = await this.compile(record.manifest.renderer, record.dir); }
    catch (error) { record.loadError = errorText(error); record.renderer = null; }
  }

  private unload(record: Loaded, forget: boolean) {
    record.renderer = null;
    if (forget) {
      record.watchers?.close(); record.watchers = null;
      this.reloads.get(record.id)?.cancel(); this.reloads.delete(record.id);
      if (this.loaded.get(record.id) === record) this.loaded.delete(record.id);
    }
  }

  // An extension reloads when a file its bundle was built from changes, or package.json does.
  private watch(record: Loaded) {
    if (this.options.watch === false) return;
    let reload = this.reloads.get(record.id);
    if (!reload) {
      reload = debounce(() => void this.exclusive(() => this.reloadOne(record.id)).catch(() => undefined), this.options.debounceMs ?? 200);
      this.reloads.set(record.id, reload);
    }
    const trigger = reload.trigger;
    record.watchers ??= new Watchers(() => trigger());
    const dirs = new Set([record.dir]);
    if (record.manifest) dirs.add(dirname(record.manifest.renderer));
    for (const input of record.renderer?.inputs ?? []) dirs.add(dirname(input));
    record.watchers.set(dirs);
  }

  private async reloadOne(id: string) {
    const record = this.loaded.get(id);
    if (!record) return;
    const manifest = await readManifest(record.dir);
    if (!manifest.ok || manifest.value.id !== id) { await this.sync(); return; }
    const before = `${record.renderer?.hash}:${record.loadError}`;
    record.manifest = manifest.value; record.manifestError = null;
    if (!this.disabled.includes(id)) await this.load(record);
    this.watch(record);
    if (`${record.renderer?.hash}:${record.loadError}` !== before) this.changed();
  }

  // Management --------------------------------------------------------------------------

  // Gives every renderer module a new URL, so the window disposes and activates each again.
  reload(): Promise<Result> {
    return this.exclusive(async () => {
      this.epoch++;
      await this.sync(true);
      return { ok: true as const, value: undefined };
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<Result> {
    return this.exclusive(async () => {
      const record = this.loaded.get(id);
      if (!record) return { ok: false as const, error: 'No such extension.' };
      this.disabled = this.disabled.filter(other => other !== id);
      if (!enabled) this.disabled.push(id);
      try { await this.writeState(); } catch { return { ok: false as const, error: 'Could not save extensions.json. Check that the config folder is writable.' }; }
      if (enabled) { await this.load(record); this.watch(record); } else this.unload(record, false);
      this.changed();
      return { ok: true as const, value: undefined };
    });
  }

  // Moves the extension's folder to the trash.
  remove(id: string): Promise<Result> {
    return this.exclusive(async (): Promise<Result> => {
      const record = this.loaded.get(id);
      if (!record) return { ok: false, error: 'No such extension.' };
      if (!this.options.trash) return { ok: false, error: `Delete the folder ${record.dir} to remove this extension.` };
      this.unload(record, true);
      try { await this.options.trash(record.dir); } catch (error) {
        await this.sync();
        return { ok: false, error: `Could not move ${record.dir} to the trash: ${errorText(error)}` };
      }
      if (this.disabled.includes(id)) {
        this.disabled = this.disabled.filter(other => other !== id);
        await this.writeState().catch(() => undefined);
      }
      this.changed();
      return { ok: true, value: undefined };
    });
  }

  async close(): Promise<void> {
    this.rescan.cancel();
    this.rootWatchers?.close();
    for (const reload of this.reloads.values()) reload.cancel();
    await this.work;
    this.closed = true;
    for (const record of this.loaded.values()) record.watchers?.close();
    this.listeners.clear();
  }
}
