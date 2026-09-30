import type { Page } from '@playwright/test';

// The renderer becomes the desktop app when window.squiggly exists. This installs a small
// stand-in for the preload bridge before the page loads, so desktop-only UI can be checked in
// the browser suite. Nothing here reaches a main process or libmpv. window.bridgeCalls lists
// the calls a test may want to check.
//
// `extensions` are listed by window.squiggly.extensions, each with the URL its module is served
// from (the test routes that URL to a compiled bundle). One marked `isNew` starts off, as a new
// folder does, until it's turned on.
//
// `mediaHost` makes the page the window that hosts the system media session (systemMedia.ts):
// window.pushMedia(state) stands in for the main process, and player commands are recorded in
// bridgeCalls.
export interface FakeExtension { id: string; name: string; url: string; error?: string; isNew?: boolean }
// `signIn` overrides the saved sign-in state (ServerState), and `connected: false` starts on the
// connect screen.
// `update` overrides the update state (UpdateState); update calls are recorded in bridgeCalls.
// `connect` answers connect by the address given (a Result); any other address fails.
// `diagnostics` makes it a beta with remote diagnostics built in: the bridge has sendDiagnostics,
// whose calls are recorded in bridgeCalls. Without it (the default) there are none, as in
// stable releases. Settings changes are kept and recorded as `settings:<json>`.
export async function installDesktopBridge(page: Page, options: { extensions?: FakeExtension[]; mediaHost?: boolean; signIn?: object; connected?: boolean; update?: object; connect?: Record<string, object>; diagnostics?: boolean } = {}) {
  await page.addInitScript(({ extensions: given, mediaHost, signInPatch, connected, updatePatch, connectResults, diagnostics }) => {
    const listeners = new Set<(snapshot: unknown) => void>();
    const audio = {
      codec: null, decoderRate: null, decoderFormat: null, decoderChannels: null, outputRate: null, outputFormat: null,
      outputChannels: null, outputBackend: null, requestedDevice: 'auto', replayGain: null, exclusiveRequested: null,
      filters: null, bufferSeconds: null, streamBytesPerSecond: null, buffering: false,
    };
    const signIn = { saved: null, canRemember: true, reconnecting: false, reconnectError: null, ...signInPatch };
    let server: { connected: boolean; name: string | null; sessionId: string | null } = connected
      ? { connected: true, name: 'Navidrome (music.example.com)', sessionId: 'session-1' } : { connected: false, name: null, sessionId: null };
    const snapshot = () => ({
      player: { engine: 'ready', error: null, playing: false, position: 0, duration: 0, volume: 100, currentIndex: -1, queue: [], entryIds: [], radio: null, devices: [], audio },
      diagnostics: { uptimeSeconds: 0, startupMs: null, ipcCommands: 0, playerMessagesPerSecond: 0, playerBytesPerSecond: 0, pendingCommands: 0, eventLoopDelayMs: 0, processes: [], operations: [] },
      server: { ...server, ...signIn },
      update: { mode: 'install', status: 'up-to-date', current: '0.1.0', version: null, percent: null, error: null, ...updatePatch },
    });
    const empty: Record<string, unknown> = { starred: { artists: [], albums: [], tracks: [] }, savedQueue: null };
    const library = new Proxy({}, {
      get: (_target, method: string) => method === 'coverUrl' ? () => '' : async () => ({ ok: true, value: method in empty ? empty[method] : [] }),
    });
    const settings = { lyricsLookup: false, exclusiveOutput: false, closeToTray: false, syncQueue: false, reportPlays: false, miniOnTop: true, outputDevice: 'auto', checkForUpdates: true, diagnostics: true };
    const calls: string[] = [];
    Object.assign(window, { bridgeCalls: calls });
    const disabled = new Set<string>(), removed = new Set<string>();
    const fresh = new Set(given.filter(extension => extension.isNew).map(extension => extension.id));
    const extensionListeners = new Set<(list: unknown) => void>();
    const extensionList = () => given.filter(extension => !removed.has(extension.id)).map(extension => ({
      id: extension.id, name: extension.name, version: '1.0.0', description: null, folder: extension.id,
      enabled: !disabled.has(extension.id) && !fresh.has(extension.id), isNew: fresh.has(extension.id), error: extension.error ?? null,
      rendererUrl: disabled.has(extension.id) || fresh.has(extension.id) || extension.error ? null : extension.url,
    }));
    const pushExtensions = () => { const list = extensionList(); extensionListeners.forEach(listener => listener(list)); };
    Object.assign(window, { squiggly: {
      snapshot: async () => snapshot(),
      subscribe: (listener: (snapshot: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      command: async (command: unknown) => { if (mediaHost) calls.push(`command:${JSON.stringify(command)}`); return { ok: true, value: undefined }; },
      updates: {
        check: async () => { calls.push('update:check'); return { ok: true, value: undefined }; },
        install: async () => { calls.push('update:install'); return { ok: true, value: undefined }; },
        open: async () => { calls.push('update:open'); return { ok: true, value: undefined }; },
      },
      media: {
        hosted: mediaHost,
        subscribe: (listener: (state: unknown) => void) => { Object.assign(window, { pushMedia: listener }); return () => undefined; },
      },
      settings: async () => ({ ...settings }),
      updateSettings: async (changes: object) => { calls.push(`settings:${JSON.stringify(changes)}`); Object.assign(settings, changes); return { ok: true, value: { ...settings } }; },
      ...(diagnostics ? { sendDiagnostics: async () => { calls.push('send-diagnostics'); return { ok: true, value: 'Sent 3 diagnostic events.' }; } } : {}),
      library,
      window: {
        isMini: false, toggleMini: async () => ({ ok: true }), setAlwaysOnTop: async () => ({ ok: true }),
        followWhileHidden: async (on: boolean) => { calls.push(`follow-while-hidden:${on}`); return { ok: true, value: undefined }; },
      },
      extensions: {
        list: async () => extensionList(),
        subscribe: (listener: (list: unknown) => void) => { extensionListeners.add(listener); return () => extensionListeners.delete(listener); },
        setEnabled: async (id: string, on: boolean) => { calls.push(`set-enabled:${id}:${on}`); fresh.delete(id); if (on) disabled.delete(id); else disabled.add(id); pushExtensions(); return { ok: true, value: undefined }; },
        reload: async () => { calls.push('reload'); return { ok: true, value: undefined }; },
        remove: async (id: string) => { calls.push(`remove:${id}`); removed.add(id); pushExtensions(); return { ok: true, value: undefined }; },
        openDir: async () => ({ ok: true, value: undefined }),
        writeClipboard: async (text: string) => { calls.push(`clipboard:${text}`); return { ok: true, value: undefined }; },
      },
      connect: async (connection: { url: string; username: string }) => {
        calls.push(`connect:${connection.url}:${connection.username}`);
        return connectResults[connection.url] ?? { ok: false, error: 'No server in the test.' };
      },
      disconnect: async () => {
        calls.push('disconnect');
        server = { connected: false, name: null, sessionId: null };
        const next = snapshot();
        listeners.forEach(listener => listener(next));
        return { ok: true, value: undefined };
      },
    } });
  }, { extensions: options.extensions ?? [], mediaHost: options.mediaHost ?? false, signInPatch: options.signIn ?? {}, connected: options.connected ?? true, updatePatch: options.update ?? {}, connectResults: options.connect ?? {}, diagnostics: options.diagnostics ?? false });
}
