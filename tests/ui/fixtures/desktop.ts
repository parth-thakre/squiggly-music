import type { Page } from '@playwright/test';

// The renderer becomes the desktop app when window.squiggly exists. This installs a small
// stand-in for the preload bridge before the page loads, so desktop-only UI can be checked in
// the browser suite. Nothing here reaches a main process or libmpv. window.bridgeCalls lists
// the calls a test may want to check.
//
// `extensions` are listed by window.squiggly.extensions, each with the URL its module is served
// from (the test routes that URL to a compiled bundle).
export interface FakeExtension { id: string; name: string; url: string; error?: string }
export async function installDesktopBridge(page: Page, options: { extensions?: FakeExtension[] } = {}) {
  await page.addInitScript(({ extensions: given }) => {
    const listeners = new Set<(snapshot: unknown) => void>();
    const audio = {
      codec: null, decoderRate: null, decoderFormat: null, decoderChannels: null, outputRate: null, outputFormat: null,
      outputChannels: null, outputBackend: null, requestedDevice: 'auto', replayGain: null, exclusiveRequested: null,
      filters: null, bufferSeconds: null, streamBytesPerSecond: null, buffering: false,
    };
    let server: { connected: boolean; name: string | null; sessionId: string | null } = { connected: true, name: 'Navidrome (music.example.com)', sessionId: 'session-1' };
    const snapshot = () => ({
      player: { engine: 'ready', error: null, playing: false, position: 0, duration: 0, volume: 100, currentIndex: -1, queue: [], entryIds: [], radio: null, devices: [], audio },
      diagnostics: { uptimeSeconds: 0, startupMs: null, ipcCommands: 0, playerMessagesPerSecond: 0, playerBytesPerSecond: 0, pendingCommands: 0, eventLoopDelayMs: 0, processes: [], operations: [] },
      server,
    });
    const empty: Record<string, unknown> = { starred: { artists: [], albums: [], tracks: [] }, savedQueue: null };
    const library = new Proxy({}, {
      get: (_target, method: string) => method === 'coverUrl' ? () => '' : async () => ({ ok: true, value: method in empty ? empty[method] : [] }),
    });
    const settings = { lyricsLookup: false, exclusiveOutput: false, closeToTray: false, syncQueue: false, reportPlays: false, miniOnTop: true };
    const calls: string[] = [];
    Object.assign(window, { bridgeCalls: calls });
    const disabled = new Set<string>(), removed = new Set<string>();
    const extensionListeners = new Set<(list: unknown) => void>();
    const extensionList = () => given.filter(extension => !removed.has(extension.id)).map(extension => ({
      id: extension.id, name: extension.name, version: '1.0.0', description: null, folder: extension.id,
      enabled: !disabled.has(extension.id), error: extension.error ?? null,
      rendererUrl: disabled.has(extension.id) || extension.error ? null : extension.url,
    }));
    const pushExtensions = () => { const list = extensionList(); extensionListeners.forEach(listener => listener(list)); };
    Object.assign(window, { squiggly: {
      snapshot: async () => snapshot(),
      subscribe: (listener: (snapshot: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      command: async () => ({ ok: true, value: undefined }),
      settings: async () => settings,
      updateSettings: async () => ({ ok: true, value: settings }),
      library,
      window: { isMini: false, toggleMini: async () => ({ ok: true }), setAlwaysOnTop: async () => ({ ok: true }) },
      extensions: {
        list: async () => extensionList(),
        subscribe: (listener: (list: unknown) => void) => { extensionListeners.add(listener); return () => extensionListeners.delete(listener); },
        setEnabled: async (id: string, on: boolean) => { calls.push(`set-enabled:${id}:${on}`); if (on) disabled.delete(id); else disabled.add(id); pushExtensions(); return { ok: true, value: undefined }; },
        reload: async () => { calls.push('reload'); return { ok: true, value: undefined }; },
        remove: async (id: string) => { calls.push(`remove:${id}`); removed.add(id); pushExtensions(); return { ok: true, value: undefined }; },
        openDir: async () => ({ ok: true, value: undefined }),
        writeClipboard: async (text: string) => { calls.push(`clipboard:${text}`); return { ok: true, value: undefined }; },
      },
      disconnect: async () => {
        calls.push('disconnect');
        server = { connected: false, name: null, sessionId: null };
        const next = snapshot();
        listeners.forEach(listener => listener(next));
        return { ok: true, value: undefined };
      },
    } });
  }, { extensions: options.extensions ?? [] });
}
