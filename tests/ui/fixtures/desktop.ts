import type { Page } from '@playwright/test';

// The renderer becomes the desktop app when window.squiggly exists. This installs a small
// stand-in for the preload bridge before the page loads, so desktop-only UI can be checked in
// the browser suite. Nothing here reaches a main process or libmpv. window.bridgeCalls lists
// the calls a test may want to check.
export async function installDesktopBridge(page: Page) {
  await page.addInitScript(() => {
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
    Object.assign(window, { squiggly: {
      snapshot: async () => snapshot(),
      subscribe: (listener: (snapshot: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      command: async () => ({ ok: true, value: undefined }),
      settings: async () => settings,
      updateSettings: async () => ({ ok: true, value: settings }),
      library,
      window: { isMini: false, toggleMini: async () => ({ ok: true }), setAlwaysOnTop: async () => ({ ok: true }) },
      disconnect: async () => {
        calls.push('disconnect');
        server = { connected: false, name: null, sessionId: null };
        const next = snapshot();
        listeners.forEach(listener => listener(next));
        return { ok: true, value: undefined };
      },
    } });
  });
}
