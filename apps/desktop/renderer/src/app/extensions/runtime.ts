import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import { useSyncExternalStore } from 'react';
import type { ExtensionInfo } from '../../../../../../packages/core/contracts';
import * as extensionApi from '../../../../../../packages/extension-api/index';
import type { Dispose, Extension, ExtensionContext } from '../../../../../../packages/extension-api/index';
import { createContext, message, settingsKey, type Activation } from './context';
import { onPageError } from './pages';

// Loads each enabled extension's renderer entry from its squiggly-ext:// URL and activates it.
// When the URL changes (a saved edit, a reload) or the extension is turned off or removed, the
// old activation is disposed first: its commands, menu items, pages, themes, and styles go with it.
//
// Extension bundles import React and the API from the app (see main/extensions/compile.ts);
// they are handed over here, before any extension module runs.

const HOST_GLOBAL = '__squigglyHost';
const bridge = typeof window !== 'undefined' ? window.squiggly : undefined;

interface Active { url: string; activation: Activation }
const active = new Map<string, Active>();
let started = false;
let queue: Promise<void> = Promise.resolve();

// The latest list, for Settings › Extensions. Failures in this window (an import or activate()
// that threw, a page that crashed) are kept here and shown with the main process's own errors.
let received: ExtensionInfo[] = [];
let extensions: ExtensionInfo[] = [];
let loaded = false;
const failures = new Map<string, string>();
const listeners = new Set<() => void>();
const publish = () => {
  extensions = received.map(info => info.error || !failures.has(info.id) ? info : { ...info, error: failures.get(info.id)! });
  listeners.forEach(listener => listener());
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useExtensionList = () => useSyncExternalStore(subscribe, () => extensions);
export const useExtensionsLoaded = () => useSyncExternalStore(subscribe, () => loaded);

function fail(id: string, error: string | null) {
  if (error === null ? !failures.delete(id) : failures.get(id) === error) return;
  if (error !== null) failures.set(id, error.slice(0, 2000));
  publish();
}

function deactivate(id: string) {
  const entry = active.get(id);
  if (!entry) return;
  active.delete(id);
  entry.activation.dispose();
}

async function activate(info: ExtensionInfo & { rendererUrl: string }) {
  let activation: Activation | null = null;
  try {
    const module = await import(/* @vite-ignore */ info.rendererUrl) as { default?: unknown };
    const extension = (module.default ?? module) as Partial<Extension> | ((ctx: ExtensionContext) => unknown);
    const run = typeof extension === 'function' ? extension : extension.activate?.bind(extension);
    if (typeof run !== 'function') throw new Error('The renderer entry must export default defineExtension({ activate(ctx) { … } }).');
    activation = createContext(info);
    const current = activation;
    active.set(info.id, { url: info.rendererUrl, activation: current });
    const dispose = await run(current.ctx);
    if (typeof dispose === 'function') current.ctx.onDispose(dispose as Dispose);
    fail(info.id, null);
  } catch (error) {
    // Undo whatever it registered before failing, so a fixed version can register again.
    if (activation && active.get(info.id)?.activation === activation) deactivate(info.id);
    console.error(`[${info.id}] could not start`, error);
    fail(info.id, `The renderer entry failed to start: ${message(error)}`);
  }
}

async function reconcile(list: ExtensionInfo[]) {
  const wanted = new Map(list.filter((info): info is ExtensionInfo & { rendererUrl: string } => info.enabled && !!info.rendererUrl).map(info => [info.id, info]));
  for (const [id, entry] of active) if (wanted.get(id)?.rendererUrl !== entry.url) deactivate(id);
  for (const id of [...failures.keys()]) if (!wanted.has(id) || !active.has(id)) failures.delete(id);
  for (const info of wanted.values()) if (!active.has(info.id)) await activate(info);
  publish();
}
function apply(list: ExtensionInfo[]) {
  received = list; loaded = true; publish();
  queue = queue.then(() => reconcile(list)).catch(error => console.error('Extensions:', error));
}

// Settings › Extensions removes an extension's folder; its settings go with it.
export async function removeExtension(id: string) {
  const result = await bridge!.extensions.remove(id);
  if (result.ok) try { localStorage.removeItem(settingsKey(id)); } catch { /* storage unavailable */ }
  return result;
}

// Starts the runtime in the main window. The mini player window runs no extensions.
export function startExtensions() {
  if (started || !bridge?.extensions || bridge.window.isMini) return;
  started = true;
  (globalThis as Record<string, unknown>)[HOST_GLOBAL] = {
    modules: {
      react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient,
      '@squiggly/extension-api': extensionApi,
    },
  };
  onPageError((owner, error) => fail(owner, error));
  let pushed = false;
  bridge.extensions.subscribe(list => { pushed = true; apply(list); });
  void bridge.extensions.list().then(list => { if (!pushed) apply(list); }, error => console.error('Extensions:', error));
}
