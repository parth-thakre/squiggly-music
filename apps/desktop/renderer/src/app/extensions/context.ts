import type { ExtensionInfo } from '../../../../../../packages/core/contracts';
import {
  API_VERSION, type Dispose, type ExtensionContext, type MenuContribution, type PlayerState, type SettingsStore,
} from '../../../../../../packages/extension-api/index';
import { api } from '../library';
import { current, getPlayer, player, usePlayer, type PlayerState as AppPlayerState } from '../player';
import { registry, type MenuItem } from '../registry';
import { nav } from '../route';
import { registerTheme } from '../theme';
import { showNotice } from './notices';
import { addPage, openExtensionPage } from './pages';

// Builds the ExtensionContext a renderer entry receives. Everything registered through it is
// tracked and undone by dispose(): commands and menu items through the extension's registry
// scope, pages, themes, and styles through their own disposers.

const views = new WeakMap<AppPlayerState, PlayerState>();
// The public view of the player store, cached per store state so selectors see stable objects.
export function playerView(state: AppPlayerState): PlayerState {
  let view = views.get(state);
  if (!view) {
    view = {
      engine: state.engine, connected: state.connected, queue: state.queue, entryIds: state.entryIds, index: state.index,
      playing: state.playing, position: state.position, duration: state.duration, volume: state.volume, radio: state.radio, error: state.error,
    };
    views.set(state, view);
  }
  return view;
}

const bridge = typeof window !== 'undefined' ? window.squiggly : undefined;
// The player store updates from these snapshots before later subscribers hear of them.
function onPlayer(listener: () => void): Dispose {
  if (!bridge) return () => {};
  return bridge.subscribe(() => listener());
}
async function command(type: 'play' | 'pause') {
  if (!bridge) { if ((type === 'play') !== getPlayer().playing) player.toggle(); return; }
  const result = await bridge.command({ type });
  if (!result.ok) throw new Error(result.error);
}

// Settings live in this window's local storage, one key per extension.
const SETTINGS_LIMIT = 256 * 1024;
export const settingsKey = (id: string) => `squiggly.extension.${id}`;
function storedSettings(id: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(settingsKey(id)) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export interface Activation {
  ctx: ExtensionContext;
  dispose(): void;
}

export function createContext(info: Pick<ExtensionInfo, 'id' | 'name' | 'version'>): Activation {
  const scope = registry.scope(info.id);
  const disposers: Dispose[] = [];
  let disposed = false;
  const track = (dispose: Dispose): Dispose => {
    let done = false;
    const once = () => { if (done) return; done = true; const at = disposers.indexOf(once); if (at >= 0) disposers.splice(at, 1); dispose(); };
    disposers.push(once);
    return once;
  };
  const alive = () => { if (disposed) throw new Error(`${info.name} was unloaded; register from activate().`); };
  const menuItem = ({ section = 10, submenu, ...item }: MenuContribution): MenuItem => ({
    ...item, section, submenu: submenu && (async target => (await submenu(target)).map(menuItem)),
  });

  let values = storedSettings(info.id);
  const settingsListeners = new Set<(values: Readonly<Record<string, unknown>>) => void>();
  const settings: SettingsStore = {
    get: <T,>(key: string, fallback: T) => (Object.hasOwn(values, key) ? values[key] : fallback) as T,
    async set(key, value) {
      const text = JSON.stringify({ ...values, [key]: value });
      if (text.length > SETTINGS_LIMIT) throw new Error('Settings are limited to 256 KB per extension.');
      localStorage.setItem(settingsKey(info.id), text);
      values = JSON.parse(text) as Record<string, unknown>;
      settingsListeners.forEach(listener => listener(values));
    },
    all: () => values,
    subscribe(listener) { settingsListeners.add(listener); return track(() => settingsListeners.delete(listener)); },
  };

  const log = (level: 'info' | 'warn' | 'error') => (...args: unknown[]) => console[level === 'info' ? 'log' : level](`[${info.id}]`, ...args);

  const ctx: ExtensionContext = {
    id: info.id, version: info.version, apiVersion: API_VERSION,
    commands: {
      // A failing run is reported where it was started (the palette, a key, a menu).
      register(entry) { alive(); return track(scope.command({ ...entry, category: entry.category ?? info.name })); },
      async execute(id) {
        const found = registry.commands.get(id);
        if (!found) throw new Error(`There is no command “${id}”.`);
        if (!registry.commands.available(id)) throw new Error(`“${found.title}” isn't available right now.`);
        await found.run();
      },
    },
    menus: { register(item) { alive(); return track(scope.menu(menuItem(item))); } },
    player: {
      get: () => playerView(getPlayer()),
      subscribe(listener) { return track(onPlayer(() => listener(playerView(getPlayer())))); },
      select(selector, listener) {
        let last = selector(playerView(getPlayer()));
        return track(onPlayer(() => { const value = selector(playerView(getPlayer())); if (!Object.is(value, last)) { last = value; listener(value); } }));
      },
      use: selector => usePlayer(state => selector(playerView(state))),
      current: () => current(getPlayer()) ?? null,
      play: (tracks, startIndex = 0) => player.play(tracks, startIndex),
      add: (tracks, where) => player.add(tracks, where),
      radio: seed => player.radio(seed),
      toggle: () => player.toggle(),
      pause: () => command('pause'),
      resume: () => command('play'),
      next: () => player.next(),
      previous: () => player.previous(),
      seek: seconds => player.seek(Math.max(0, seconds)),
      volume: percent => player.volume(Math.min(100, Math.max(0, percent)), true),
    },
    library: api,
    navigation: {
      go: route => nav.go(route),
      back: () => nav.back(),
      registerPage(page) { alive(); const added = addPage(info.id, page); return { id: added.id, dispose: track(added.dispose) }; },
      openPage: id => openExtensionPage(id),
    },
    themes: { register(theme) { alive(); return track(registerTheme(theme, info.id)); } },
    styles: {
      add(css) {
        alive();
        const style = document.createElement('style');
        style.dataset.extension = info.id;
        style.textContent = String(css);
        document.head.append(style);
        return track(() => style.remove());
      },
    },
    settings,
    notify: (text, options) => showNotice(info.name, text, options?.level ?? 'info'),
    clipboard: {
      async writeText(text) {
        if (!bridge) { await navigator.clipboard.writeText(String(text)); return; }
        const result = await bridge.extensions.writeClipboard(String(text));
        if (!result.ok) throw new Error(result.error);
      },
    },
    log: { info: log('info'), warn: log('warn'), error: log('error') },
    onDispose(dispose) { track(dispose); },
  };

  return {
    ctx,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of [...disposers].reverse()) {
        try { dispose(); } catch (error) { console.error(`[${info.id}] dispose failed`, error); }
      }
      scope.dispose();
      settingsListeners.clear();
    },
  };
}

export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
