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
// that threw, a page or slot that crashed) are kept here and shown with the main process's own
// errors.
let received: ExtensionInfo[] = [];
let extensions: ExtensionInfo[] = [];
let loaded = false;
const failures = new Map<string, string>();
// The mini player has no Settings, so it sends its failures, and their clearing, to the main
// window over this channel. Each names the module URL it happened in, and is shown only while
// that version is the one listed.
const CHANNEL = 'squiggly.extension-failures';
let channel: BroadcastChannel | null = null;
const miniFailures = new Map<string, { url: string; error: string }>();
const fromMini = (info: ExtensionInfo) => {
  const failure = miniFailures.get(info.id);
  return failure && failure.url === info.rendererUrl ? `In the mini player: ${failure.error}` : undefined;
};
const listeners = new Set<() => void>();
const publish = () => {
  extensions = received.map(info => {
    const error = info.error ? null : failures.get(info.id) ?? fromMini(info);
    return error ? { ...info, error } : info;
  });
  listeners.forEach(listener => listener());
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useExtensionList = () => useSyncExternalStore(subscribe, () => extensions);
export const useExtensionsLoaded = () => useSyncExternalStore(subscribe, () => loaded);

function fail(id: string, error: string | null, url = active.get(id)?.url) {
  if (channel && bridge?.window.isMini && url) channel.postMessage({ id, url, error: error?.slice(0, 2000) ?? null });
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
    // The last version's failures go now: a deck slot can render, and fail, before run() returns.
    fail(info.id, null, info.rendererUrl);
    activation = createContext(info);
    const current = activation;
    active.set(info.id, { url: info.rendererUrl, activation: current });
    const dispose = await run(current.ctx);
    if (typeof dispose === 'function') current.ctx.onDispose(dispose as Dispose);
  } catch (error) {
    // Undo whatever it registered before failing, so a fixed version can register again.
    if (activation && active.get(info.id)?.activation === activation) deactivate(info.id);
    console.error(`[${info.id}] could not start`, error);
    fail(info.id, `The renderer entry failed to start: ${message(error)}`, info.rendererUrl);
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
  received = list; loaded = true;
  for (const [id, failure] of miniFailures) if (list.find(info => info.id === id)?.rendererUrl !== failure.url) miniFailures.delete(id);
  publish();
  queue = queue.then(() => reconcile(list)).catch(error => console.error('Extensions:', error));
}

// A report from the mini player's runtime, checked before it is kept.
function miniReport(data: unknown): { id: string; url: string; error: string | null } | null {
  if (!data || typeof data !== 'object') return null;
  const { id, url, error } = data as Record<string, unknown>;
  if (typeof id !== 'string' || !id || id.length > 214 || typeof url !== 'string' || !url || url.length > 4096) return null;
  if (error !== null && (typeof error !== 'string' || error.length > 2000)) return null;
  return { id, url, error };
}

// Settings › Extensions removes an extension's folder; its settings go with it.
export async function removeExtension(id: string) {
  const result = await bridge!.extensions.remove(id);
  if (result.ok) try { localStorage.removeItem(settingsKey(id)); } catch { /* storage unavailable */ }
  return result;
}

// Starts the runtime. Both windows run it: the mini player loads the same list from the main
// process, through the same preload, for its deck slots and keys. Its pages go unused, and its
// failures are shown in the main window's Settings.
export function startExtensions() {
  if (started || !bridge?.extensions) return;
  started = true;
  (globalThis as Record<string, unknown>)[HOST_GLOBAL] = {
    modules: {
      react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM, 'react-dom/client': ReactDOMClient,
      '@squiggly/extension-api': extensionApi,
    },
  };
  onPageError((owner, error) => fail(owner, error));
  channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  if (channel && !bridge.window.isMini) channel.onmessage = ({ data }: MessageEvent<unknown>) => {
    const report = miniReport(data);
    if (!report) return;
    if (report.error === null) miniFailures.delete(report.id);
    else miniFailures.set(report.id, { url: report.url, error: report.error });
    publish();
  };
  let pushed = false;
  bridge.extensions.subscribe(list => { pushed = true; apply(list); });
  void bridge.extensions.list().then(list => { if (!pushed) apply(list); }, error => console.error('Extensions:', error));
}
