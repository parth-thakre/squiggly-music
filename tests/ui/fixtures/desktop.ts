import type { Page } from '@playwright/test';

// The renderer becomes the desktop app when window.squiggly exists. This installs a small
// stand-in for the preload bridge before the page loads, so desktop-only UI can be checked in
// the browser suite. Nothing here reaches a main process or libmpv. window.bridgeCalls lists
// the calls a test may want to check.
//
// `extensions` are listed by window.squiggly.extensions, each with the URL its module is served
// from (the test routes that URL to a compiled bundle). Reload all gives every URL a new
// `?v=` number, as the main process gives each a new hash, so the window starts them again.
//
// `mediaHost` makes the page the window that hosts the system media session (systemMedia.ts):
// window.pushMedia(state) stands in for the main process, and player commands are recorded in
// bridgeCalls.
export interface FakeExtension { id: string; name: string; url: string; error?: string }
// `signIn` overrides the saved sign-in state (ServerState), and `connected: false` starts on the
// connect screen.
// `update` overrides the update state (UpdateState); update calls are recorded in bridgeCalls.
// `player` overrides the player snapshot (a queue and currentIndex put a song in the deck), and
// `mini` makes the page the mini player window.
export async function installDesktopBridge(page: Page, options: { extensions?: FakeExtension[]; mediaHost?: boolean; signIn?: object; connected?: boolean; update?: object; player?: object; mini?: boolean } = {}) {
  await page.addInitScript(({ extensions: given, mediaHost, signInPatch, connected, updatePatch, playerPatch, mini }) => {
    const listeners = new Set<(snapshot: unknown) => void>();
    const audio = {
      codec: null, decoderRate: null, decoderFormat: null, decoderChannels: null, outputRate: null, outputFormat: null,
      outputChannels: null, outputBackend: null, requestedDevice: 'auto', replayGain: null, exclusiveRequested: null,
      filters: null, bufferSeconds: null, streamBytesPerSecond: null, buffering: false,
    };
    const signIn = { saved: null, canRemember: true, reconnecting: false, reconnectError: null, ...signInPatch };
    let server: { connected: boolean; name: string | null; sessionId: string | null; account: string | null } = connected
      ? { connected: true, name: 'Navidrome (music.example.com)', sessionId: 'session-1', account: 'https://music.example.com\nlistener' } : { connected: false, name: null, sessionId: null, account: null };
    const snapshot = () => ({
      player: { engine: 'ready', error: null, playing: false, position: 0, duration: 0, volume: 100, currentIndex: -1, queue: [], entryIds: [], radio: null, devices: [], audio, ...playerPatch },
      diagnostics: { uptimeSeconds: 0, startupMs: null, ipcCommands: 0, playerMessagesPerSecond: 0, playerBytesPerSecond: 0, pendingCommands: 0, eventLoopDelayMs: 0, processes: [], operations: [] },
      server: { ...server, ...signIn },
      update: { mode: 'install', status: 'up-to-date', current: '0.1.0', version: null, percent: null, error: null, ...updatePatch },
    });
    const empty: Record<string, unknown> = { starred: { artists: [], albums: [], tracks: [] }, savedQueue: null };
    const library = new Proxy({}, {
      get: (_target, method: string) => method === 'coverUrl' ? () => '' : async () => ({ ok: true, value: method in empty ? empty[method] : [] }),
    });
    const settings = { lyricsLookup: false, exclusiveOutput: false, closeToTray: false, syncQueue: false, reportPlays: false, miniOnTop: true, outputDevice: 'auto', checkForUpdates: true };
    const calls: string[] = [];
    Object.assign(window, { bridgeCalls: calls });
    const disabled = new Set<string>(), removed = new Set<string>();
    let reloads = 0;
    const extensionListeners = new Set<(list: unknown) => void>();
    const extensionList = () => given.filter(extension => !removed.has(extension.id)).map(extension => ({
      id: extension.id, name: extension.name, version: '1.0.0', description: null, folder: extension.id,
      enabled: !disabled.has(extension.id), error: extension.error ?? null,
      rendererUrl: disabled.has(extension.id) || extension.error ? null : reloads ? `${extension.url}?v=${reloads}` : extension.url,
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
      settings: async () => settings,
      updateSettings: async () => ({ ok: true, value: settings }),
      library,
      window: {
        isMini: mini, toggleMini: async () => ({ ok: true }), setAlwaysOnTop: async () => ({ ok: true }),
        followWhileHidden: async (on: boolean) => { calls.push(`follow-while-hidden:${on}`); return { ok: true, value: undefined }; },
      },
      extensions: {
        list: async () => extensionList(),
        subscribe: (listener: (list: unknown) => void) => { extensionListeners.add(listener); return () => extensionListeners.delete(listener); },
        setEnabled: async (id: string, on: boolean) => { calls.push(`set-enabled:${id}:${on}`); if (on) disabled.delete(id); else disabled.add(id); pushExtensions(); return { ok: true, value: undefined }; },
        reload: async () => { calls.push('reload'); reloads++; pushExtensions(); return { ok: true, value: undefined }; },
        remove: async (id: string) => { calls.push(`remove:${id}`); removed.add(id); pushExtensions(); return { ok: true, value: undefined }; },
        openDir: async () => ({ ok: true, value: undefined }),
        writeClipboard: async (text: string) => { calls.push(`clipboard:${text}`); return { ok: true, value: undefined }; },
      },
      // Files dropped on the window, as the preload takes them: the Files themselves (the page has
      // no paths to give). The call is recorded with the files' names; more than a full queue is
      // refused, as the main process refuses it.
      openDropped: async (files: File[], mode: string) => {
        calls.push(`open-dropped:${files.length}:${JSON.stringify(files.slice(0, 3).map(file => file instanceof File ? file.name : typeof file))}:${mode}`);
        if (files.length > 1000) return { ok: false, error: 'Drop up to 1,000 files at a time.' };
        return { ok: true, value: { opened: files.length, skipped: 0 } };
      },
      connect: async (connection: { url: string; username: string }) => { calls.push(`connect:${connection.url}:${connection.username}`); return { ok: false, error: 'No server in the test.' }; },
      disconnect: async () => {
        calls.push('disconnect');
        server = { connected: false, name: null, sessionId: null, account: null };
        const next = snapshot();
        listeners.forEach(listener => listener(next));
        return { ok: true, value: undefined };
      },
    } });
  }, { extensions: options.extensions ?? [], mediaHost: options.mediaHost ?? false, signInPatch: options.signIn ?? {}, connected: options.connected ?? true, updatePatch: options.update ?? {},
    playerPatch: options.player ?? {}, mini: options.mini ?? false });
}
