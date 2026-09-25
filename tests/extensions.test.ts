import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compileEntry } from '../apps/desktop/main/extensions/compile';
import { extensionId, readManifest } from '../apps/desktop/main/extensions/manifest';
import { ExtensionManager } from '../apps/desktop/main/extensions/manager';
import type { ExtensionInfo } from '../packages/core/contracts';

// The renderer context reads app stores that need a browser; these stand in for them.
vi.mock('../apps/desktop/renderer/src/app/player', () => ({
  getPlayer: () => ({ engine: 'ready', connected: true, queue: [], entryIds: [], index: -1, playing: false, position: 0, duration: 0, volume: 100, radio: null, error: null }),
  usePlayer: () => undefined, current: () => undefined,
  player: { play: vi.fn(), add: vi.fn(), radio: vi.fn(), toggle: vi.fn(), next: vi.fn(), previous: vi.fn(), seek: vi.fn(), volume: vi.fn() },
}));
vi.mock('../apps/desktop/renderer/src/app/library', () => ({ api: {} }));
vi.mock('../apps/desktop/renderer/src/app/route', () => ({ nav: { go: vi.fn(), back: vi.fn() } }));
const themes = new Map<string, unknown>();
vi.mock('../apps/desktop/renderer/src/app/theme', () => ({
  registerTheme: (theme: { id: string }, owner: string) => {
    const id = `${owner}:${theme.id}`;
    if (themes.has(id)) throw new Error('collision');
    themes.set(id, theme);
    return () => themes.delete(id);
  },
}));

const temporary: string[] = [];
const managers: ExtensionManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});
const tempDir = async () => { const dir = await mkdtemp(join(tmpdir(), 'squiggly-ext-')); temporary.push(dir); return dir; };
const until = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting.'); await new Promise(done => setTimeout(done, 25)); }
};
const examples = resolve('examples/extensions');

describe('manifests', () => {
  it('needs a renderer entry inside the folder, and a usable id', async () => {
    const dir = await tempDir();
    const manifest = async (pkg: object) => { await writeFile(join(dir, 'package.json'), JSON.stringify(pkg)); return readManifest(dir); };
    expect(await manifest({ name: '@me/thing', version: '1.0.0', squiggly: { renderer: '../x.ts' } })).toMatchObject({ ok: false, error: expect.stringMatching(/inside the extension's folder/) });
    expect(await manifest({ name: 'x', squiggly: {} })).toMatchObject({ ok: false, error: expect.stringMatching(/Add "renderer"/) });
    expect(await manifest({ name: 'x' })).toMatchObject({ ok: false, error: expect.stringMatching(/no "squiggly" field/) });
    expect(await manifest({ name: 'x', squiggly: { renderer: 'i.ts', apiVersion: 99 } })).toMatchObject({ ok: false, error: expect.stringMatching(/needs extension API 99/) });
    expect(await manifest({ name: '@me/Thing Two', squiggly: { renderer: 'i.ts' } })).toMatchObject({ ok: false, error: expect.stringMatching(/can't be used as an extension id/) });
    expect(await readManifest(join(examples, 'library-stats'))).toMatchObject({ ok: true, value: { id: 'library-stats', name: 'Library stats', version: '1.0.0' } });
    expect(extensionId('@me/stats')).toEqual({ ok: true, value: 'me.stats' });
  });
});

describe('compiling', () => {
  it('bundles an example with React and the API left to the app, and runs it', async () => {
    const dir = join(examples, 'library-stats');
    const bundle = await compileEntry(join(dir, 'src/index.tsx'), dir);
    expect(bundle.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(bundle.code).toContain('__squigglyHost');
    // React itself is not in the bundle.
    expect(bundle.code).not.toMatch(/react\.production|__SECRET_INTERNALS|ReactSharedInternals/);
    expect(bundle.inputs.map(input => input.slice(dir.length + 1)).sort()).toEqual(['src/index.tsx']);

    // Load the bundle the way the window does, with the app's React supplied.
    (globalThis as Record<string, unknown>).__squigglyHost = { modules: {
      react: await import('react'), 'react/jsx-runtime': await import('react/jsx-runtime'), '@squiggly/extension-api': await import('../packages/extension-api/index'),
    } };
    const module = await import(`data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`) as { default: { activate(ctx: unknown): void } };
    const registered: string[] = [];
    module.default.activate({
      navigation: { registerPage: (page: { id: string }) => { registered.push(`page:${page.id}`); return { id: `library-stats:${page.id}`, dispose() {} }; }, openPage() {} },
      commands: { register: (command: { id: string }) => { registered.push(`command:${command.id}`); return () => {}; } },
    });
    expect(registered).toEqual(['page:stats', 'command:open']);
  });

  it('reports compile errors as file:line messages, and refuses a second React', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'index.ts'), 'import missing from "./nowhere";\nexport default missing;');
    await expect(compileEntry(join(dir, 'index.ts'), dir)).rejects.toThrow(/index\.ts:1:\d+: Could not resolve "\.\/nowhere"/);
    await writeFile(join(dir, 'index.ts'), 'import { renderToString } from "react-dom/server";\nexport default renderToString;');
    await expect(compileEntry(join(dir, 'index.ts'), dir)).rejects.toThrow(/react-dom\/server.*isn't available/);
  });
});

// A manager with real folders and real esbuild. The trash is a folder beside the config folder.
async function managerFor(watch = false) {
  const configDir = await tempDir();
  const trash = join(configDir, '..', `${configDir.split('/').pop()}-trash`);
  temporary.push(trash);
  const manager = new ExtensionManager({
    configDir, watch, debounceMs: 40,
    trash: async path => { await mkdir(trash, { recursive: true }); await rename(path, join(trash, path.split('/').pop()!)); },
  });
  managers.push(manager);
  return { manager, configDir, trash };
}

describe('extension manager', () => {
  it('finds extensions, serves the current module, turns them off and on, reloads, and removes to the trash', async () => {
    const { manager, configDir, trash } = await managerFor();
    await cp(join(examples, 'library-stats'), join(configDir, 'extensions', 'library-stats'), { recursive: true });
    await mkdir(join(configDir, 'extensions', 'not-an-extension'), { recursive: true });
    await writeFile(join(configDir, 'extensions', 'not-an-extension', 'package.json'), '{"name":"not-an-extension"}');
    await manager.start();
    const stats = manager.list().find(info => info.id === 'library-stats')!;
    expect(stats).toMatchObject({ name: 'Library stats', folder: 'library-stats', enabled: true, error: null });
    expect(stats.rendererUrl).toMatch(/^squiggly-ext:\/\/library-stats\/[0-9a-f]{16}\.js$/);
    expect(manager.rendererModule(stats.rendererUrl!)).toContain('__squigglyHost');
    expect(manager.rendererModule('squiggly-ext://library-stats/0000000000000000.js')).toBeNull();
    expect(manager.list().find(info => info.id === 'not-an-extension')?.error).toMatch(/no "squiggly" field/);

    // Turning it off is saved, and withdraws the module.
    expect(await manager.setEnabled('library-stats', false)).toEqual({ ok: true, value: undefined });
    expect(JSON.parse(await readFile(join(configDir, 'extensions.json'), 'utf8'))).toEqual({ disabled: ['library-stats'] });
    expect(manager.list().find(info => info.id === 'library-stats')).toMatchObject({ enabled: false, rendererUrl: null });
    expect(manager.rendererModule(stats.rendererUrl!)).toBeNull();
    await manager.setEnabled('library-stats', true);
    expect(manager.list().find(info => info.id === 'library-stats')?.rendererUrl).toBe(stats.rendererUrl);

    // reload() gives every module a new URL, so the window disposes and activates again.
    await manager.reload();
    expect(manager.list().find(info => info.id === 'library-stats')?.rendererUrl).not.toBe(stats.rendererUrl);

    expect(await manager.remove('library-stats')).toEqual({ ok: true, value: undefined });
    expect(existsSync(join(configDir, 'extensions', 'library-stats'))).toBe(false);
    expect(existsSync(join(trash, 'library-stats', 'package.json'))).toBe(true);
    expect(manager.list().map(info => info.id)).toEqual(['not-an-extension']);
  });

  it('refuses to remove without a trash, and names a folder whose id is taken', async () => {
    const configDir = await tempDir();
    const manager = new ExtensionManager({ configDir, watch: false });
    managers.push(manager);
    await cp(join(examples, 'sleep-timer'), join(configDir, 'extensions', 'sleep-timer'), { recursive: true });
    await cp(join(examples, 'sleep-timer'), join(configDir, 'extensions', 'sleep-timer-copy'), { recursive: true });
    await manager.start();
    expect(manager.list().find(info => info.folder === 'sleep-timer-copy')?.error).toMatch(/already uses the id “sleep-timer”/);
    expect(await manager.remove('sleep-timer')).toMatchObject({ ok: false, error: expect.stringMatching(/Delete the folder/) });
  });

  it('recompiles an extension when one of its files is saved, and finds new folders', async () => {
    const { manager, configDir } = await managerFor(true);
    const dir = join(configDir, 'extensions', 'sleep-timer');
    await cp(join(examples, 'sleep-timer'), dir, { recursive: true });
    await manager.start();
    const seen: ExtensionInfo[][] = [];
    manager.subscribe(list => seen.push(list));
    const first = manager.list()[0]!.rendererUrl;
    const source = await readFile(join(dir, 'src/index.ts'), 'utf8');
    await writeFile(join(dir, 'src/index.ts'), source.replace('Start the sleep timer', 'Start sleeping'));
    await until(() => manager.list()[0]!.rendererUrl !== first);
    expect(manager.rendererModule(manager.list()[0]!.rendererUrl!)).toContain('Start sleeping');
    // A syntax error shows as the extension's error and withdraws the old module.
    await writeFile(join(dir, 'src/index.ts'), 'export default {');
    await until(() => manager.list()[0]!.error !== null);
    expect(manager.list()[0]).toMatchObject({ rendererUrl: null, error: expect.stringMatching(/src\/index\.ts:1:\d+/) });
    await cp(join(examples, 'now-playing-clipboard'), join(configDir, 'extensions', 'now-playing-clipboard'), { recursive: true });
    await until(() => manager.list().length === 2);
    expect(seen.length).toBeGreaterThan(1);
  });
});

describe('renderer extension context', () => {
  it('undoes every registration on dispose, so a reload can register the same ids again', async () => {
    const stored = new Map<string, string>([['squiggly.extension.reloader', '{"minutes":5}']]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
    const { createContext } = await import('../apps/desktop/renderer/src/app/extensions/context');
    const { registry } = await import('../apps/desktop/renderer/src/app/registry');
    const { getExtensionPages } = await import('../apps/desktop/renderer/src/app/extensions/pages');
    const activate = () => {
      const activation = createContext({ id: 'reloader', name: 'Reloader', version: '1.0.0' });
      const { ctx } = activation;
      ctx.commands.register({ id: 'go', title: 'Go', keys: ['ctrl+g'], run() {} });
      ctx.menus.register({ id: 'item', label: 'Item', run() {} });
      ctx.navigation.registerPage({ id: 'page', title: 'Page', component: () => null });
      ctx.themes.register({ id: 'dark', name: 'Dark', tokens: { colors: { ground: '#000000', ink: '#ffffff' } } });
      const disposed = vi.fn();
      ctx.onDispose(disposed);
      return { activation, disposed };
    };
    const first = activate();
    expect(first.activation.ctx.settings.get('minutes', 30)).toBe(5);
    await first.activation.ctx.settings.set('minutes', 10);
    expect(JSON.parse(stored.get('squiggly.extension.reloader')!)).toEqual({ minutes: 10 });
    await expect(first.activation.ctx.settings.set('big', 'x'.repeat(300 * 1024))).rejects.toThrow(/256 KB/);
    expect(registry.commands.get('reloader:go')).toMatchObject({ title: 'Go', keys: ['ctrl+g'], category: 'Reloader', owner: 'reloader' });
    expect(registry.menu.for({ kind: 'album', album: {} as never }).find(item => item.owner === 'reloader')).toMatchObject({ section: 10 });
    expect(getExtensionPages().map(page => page.id)).toEqual(['reloader:page']);
    expect(themes.has('reloader:dark')).toBe(true);
    // Registering again while live collides, as the registry promises.
    expect(() => createContext({ id: 'reloader', name: 'R', version: '1' }).ctx.commands.register({ id: 'go', title: 'Go', run() {} })).toThrow(/already registered/);

    first.activation.dispose();
    expect(first.disposed).toHaveBeenCalledOnce();
    expect(registry.commands.get('reloader:go')).toBeUndefined();
    expect(registry.menu.for({ kind: 'album', album: {} as never }).some(item => item.owner === 'reloader')).toBe(false);
    expect(getExtensionPages()).toEqual([]);
    expect(themes.size).toBe(0);
    expect(() => first.activation.ctx.commands.register({ id: 'late', title: 'Late', run() {} })).toThrow(/unloaded/);

    const second = activate();
    expect(second.activation.ctx.settings.get('minutes', 30)).toBe(10);
    expect(registry.commands.get('reloader:go')).toBeDefined();
    second.activation.dispose();
    first.activation.dispose();
    vi.unstubAllGlobals();
  });
});
