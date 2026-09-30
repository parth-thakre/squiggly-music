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
//
// Keep on this device, against a thin fake of the main process:
// `server: true` sends library calls to the browser build's host (/api, the fake Navidrome), as
// the main process would send them to the server, and passes a failure's `unreachable` flag
// through. A flagged failure puts the fake away at once (the real main process confirms with a
// probe first, which vitest covers); while away, library calls answer at once, and
// retryServer() asks /api/albums. `away: true` opens away, as a launch with the server
// unreachable and songs kept does.
// `kept` adds window.squiggly.kept: `seed` containers kept already, and `refuse`, a message every
// keep is refused with. Keeping fetches each song from /api/stream, one at a time, each only
// once window.keepGate.allow says so (the test raises it with page.evaluate). playTracks records
// `play:<ids>:device|stream` in bridgeCalls and plays at once, from the device when every song is
// kept. Nothing here checks limits or files; vitest covers the real main process.
export interface KeptSeed { kind: 'album' | 'playlist' | 'mix'; id: string; name: string; artist: string | null; coverArt: string | null; tracks: object[] }
export async function installDesktopBridge(page: Page, options: { extensions?: FakeExtension[]; mediaHost?: boolean; signIn?: object; connected?: boolean; update?: object; player?: object; mini?: boolean;
  server?: boolean; away?: boolean; kept?: { seed?: KeptSeed[]; refuse?: string } } = {}) {
  await page.addInitScript(({ extensions: given, mediaHost, signInPatch, connected, updatePatch, playerPatch, mini, useServer, startAway, keptOptions }) => {
    const listeners = new Set<(snapshot: unknown) => void>();
    const audio = {
      codec: null, decoderRate: null, decoderFormat: null, decoderChannels: null, outputRate: null, outputFormat: null,
      outputChannels: null, outputBackend: null, requestedDevice: 'auto', replayGain: null, exclusiveRequested: null,
      filters: null, bufferSeconds: null, streamBytesPerSecond: null, buffering: false, sink: null,
    };
    const signIn = { saved: null, canRemember: true, reconnecting: false, reconnectError: null, ...signInPatch };
    let server: { connected: boolean; name: string | null; sessionId: string | null; account: string | null } = connected
      ? { connected: true, name: 'Navidrome (music.example.com)', sessionId: 'session-1', account: 'https://music.example.com\nlistener' } : { connected: false, name: null, sessionId: null, account: null };
    type Track = { id: string; source: string; coverArt?: string | null; duration?: number | null };
    let reach = { away: startAway, since: startAway ? Date.now() : null, checking: false, checkedAt: null as number | null };
    let played: { queue: Track[]; index: number; fromDevice: boolean; playId: number } | null = null;
    const snapshot = () => ({
      player: { engine: 'ready', error: null, playing: !!played, position: 0, duration: played?.queue[played.index]?.duration ?? 0, volume: 100,
        currentIndex: played ? played.index : -1, queue: played?.queue ?? [], entryIds: played ? played.queue.map((_, i) => `e${played!.playId}.${i}`) : [],
        playId: played ? `p${played.playId}` : '', radio: null, devices: [], audio, fromDevice: played?.fromDevice ?? false, ...playerPatch },
      diagnostics: { uptimeSeconds: 0, startupMs: null, ipcCommands: 0, playerMessagesPerSecond: 0, playerBytesPerSecond: 0, pendingCommands: 0, eventLoopDelayMs: 0, processes: [], operations: [] },
      server: { ...server, ...signIn, reach, queuedPlays: 0 },
      update: { mode: 'install', status: 'up-to-date', current: '0.1.0', version: null, percent: null, error: null, ...updatePatch },
    });
    const push = () => { const next = snapshot(); listeners.forEach(listener => listener(next)); };
    const empty: Record<string, unknown> = { starred: { artists: [], albums: [], tracks: [] }, savedQueue: null };
    // Tracks a window has been shown, as the main process remembers them for play-tracks.
    const known = new Map<string, Track>();
    const learn = (value: unknown, depth = 0): void => {
      if (!value || typeof value !== 'object' || depth > 4) return;
      if (Array.isArray(value)) { value.forEach(item => learn(item, depth + 1)); return; }
      const item = value as Track;
      if (typeof item.id === 'string' && typeof item.source === 'string') known.set(item.id, item);
      else Object.values(value).forEach(inner => learn(inner, depth + 1));
    };
    const outOfReach = 'Your server is out of reach. Try again when it is back.';
    const post = async (method: string, args: unknown[]) => {
      const response = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
      return await response.json().catch(() => ({ ok: false, error: 'No answer.' })) as { ok: boolean; value?: unknown; error?: string; unreachable?: boolean };
    };
    const serverLibrary = new Proxy({}, {
      get: (_target, method: string) => method === 'coverUrl' ? (id: string, size: number) => `/api/cover?id=${encodeURIComponent(id)}&size=${Math.round(size)}`
        : async (...args: unknown[]) => {
          if (reach.away) return { ok: false, error: outOfReach, unreachable: true };
          while (args.length && args[args.length - 1] === undefined) args.pop();
          const result = await post(method, args);
          if (result.ok) learn(result.value);
          else if (result.unreachable) { reach = { away: true, since: Date.now(), checking: false, checkedAt: Date.now() }; push(); }
          return result;
        },
    });
    const library = useServer ? serverLibrary : new Proxy({}, {
      get: (_target, method: string) => method === 'coverUrl' ? () => '' : async () => ({ ok: true, value: method in empty ? empty[method] : [] }),
    });
    const settings = { lyricsLookup: false, exclusiveOutput: false, closeToTray: false, syncQueue: false, reportPlays: false, miniOnTop: true, outputDevice: 'auto', checkForUpdates: true, keptLimitMb: 4096 };
    // Keep on this device.
    type Container = { kind: string; id: string; name: string; artist: string | null; coverArt: string | null; tracks: Track[]; keptAt: number };
    const containers = new Map<string, Container>();
    const keptSongs = new Map<string, { track: Track; bytes: number }>();
    type Job = { kind: string; id: string; name: string; done: number; total: number; failed: number; state: string; error: string | null; cancelled: boolean };
    let jobs: Job[] = [];
    let revision = 1;
    const keptListeners = new Set<(progress: unknown) => void>();
    const gate = { allow: 0 };
    let fetched = 0;
    Object.assign(window, { keepGate: gate });
    for (const seed of keptOptions?.seed ?? []) {
      containers.set(`${seed.kind}:${seed.id}`, { ...seed, tracks: seed.tracks as Track[], keptAt: Date.now() });
      for (const track of seed.tracks as Track[]) { keptSongs.set(track.id, { track, bytes: 1024 * 1024 }); known.set(track.id, track); }
    }
    const summary = (c: Container) => {
      const present = c.tracks.filter(t => keptSongs.has(t.id));
      return { kind: c.kind, id: c.id, name: c.name, artist: c.artist, coverArt: c.coverArt, total: c.tracks.length, present: present.length,
        bytes: present.reduce((sum, t) => sum + keptSongs.get(t.id)!.bytes, 0), keptAt: c.keptAt };
    };
    const used = () => [...keptSongs.values()].reduce((sum, song) => sum + song.bytes, 0);
    const jobViews = () => jobs.map(({ cancelled: _cancelled, ...job }) => job);
    const progress = () => { const value = { revision, usedBytes: used(), jobs: jobViews() }; keptListeners.forEach(listener => listener(value)); };
    const keptState = () => ({ revision, songs: keptSongs.size, usedBytes: used(), limitBytes: 4096 * 1024 * 1024,
      containers: [...containers.values()].map(summary), jobs: jobViews(), dir: '/home/listener/.config/Squiggly Music/kept', notice: null });
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    async function run(job: Job, tracks: Track[]) {
      for (const track of tracks) {
        if (keptSongs.has(track.id)) { job.done++; continue; }
        while (gate.allow <= fetched && !job.cancelled) await wait(20);
        if (job.cancelled) return;
        fetched++;
        const response = await fetch(`/api/stream?id=${encodeURIComponent(track.id)}`);
        const bytes = response.ok ? (await response.arrayBuffer()).byteLength : 0;
        if (job.cancelled) return;
        if (!response.ok) { job.failed++; continue; }
        keptSongs.set(track.id, { track, bytes });
        job.done++; revision++;
        progress();
      }
      if (job.failed) { job.state = 'stopped'; job.error = job.failed === 1 ? 'One song couldn\'t be kept.' : `${job.failed} songs couldn't be kept.`; }
      else jobs = jobs.filter(j => j !== job);
      revision++;
      progress();
    }
    const kept = {
      state: async () => keptState(),
      present: async () => [...keptSongs.keys()],
      container: async (kind: string, id: string) => {
        const c = containers.get(`${kind}:${id}`);
        if (!c) return { ok: false, error: 'That isn\'t kept on this device.' };
        return { ok: true, value: { container: summary(c), trackIds: c.tracks.map(t => t.id), tracks: c.tracks.filter(t => keptSongs.has(t.id)) } };
      },
      subscribe: (listener: (progress: unknown) => void) => { keptListeners.add(listener); return () => keptListeners.delete(listener); },
      keep: async (request: { kind: string; id: string; name: string; artist: string | null; coverArt: string | null; tracks: Track[] }) => {
        calls.push(`keep:${request.kind}:${request.id}`);
        if (keptOptions?.refuse) return { ok: false, error: keptOptions.refuse };
        if (reach.away) return { ok: false, error: 'Your server is out of reach. Keeping needs it.' };
        containers.set(`${request.kind}:${request.id}`, { ...request, keptAt: Date.now() });
        const done = request.tracks.filter(t => keptSongs.has(t.id)).length;
        const job: Job = { kind: request.kind, id: request.id, name: request.name, done, total: request.tracks.length, failed: 0, state: 'keeping', error: null, cancelled: false };
        jobs = [...jobs.filter(j => !(j.kind === request.kind && j.id === request.id)), job];
        revision++;
        progress();
        void run(job, request.tracks);
        return { ok: true, value: undefined };
      },
      cancel: async (kind: string, id: string) => {
        for (const job of jobs) if (job.kind === kind && job.id === id) job.cancelled = true;
        jobs = jobs.filter(j => !(j.kind === kind && j.id === id));
        revision++; progress();
        return { ok: true, value: undefined };
      },
      forget: async (kind: string, id: string) => {
        calls.push(`forget:${kind}:${id}`);
        containers.delete(`${kind}:${id}`);
        const listed = new Set([...containers.values()].flatMap(c => c.tracks.map(t => t.id)));
        for (const trackId of [...keptSongs.keys()]) if (!listed.has(trackId)) keptSongs.delete(trackId);
        revision++; progress();
        return { ok: true, value: undefined };
      },
      forgetAll: async () => { containers.clear(); keptSongs.clear(); jobs = []; revision++; progress(); return { ok: true, value: undefined }; },
      openDir: async () => ({ ok: true, value: undefined }),
    };
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
      ...(useServer ? {
        playTracks: async (ids: string[], start: number) => {
          const queue = ids.map(id => known.get(id)).filter((track): track is Track => !!track);
          if (queue.length !== ids.length) return { ok: false, error: 'Some tracks are no longer loaded. Refresh the library and try again.' };
          const fromDevice = !!keptOptions && queue.every(track => keptSongs.has(track.id));
          calls.push(`play:${ids.join(',')}:${fromDevice ? 'device' : 'stream'}`);
          played = { queue, index: start, fromDevice, playId: (played?.playId ?? 0) + 1 };
          push();
          return { ok: true, value: undefined };
        },
        retryServer: async () => {
          if (!reach.away) return { ok: true, value: undefined };
          reach = { ...reach, checking: true }; push();
          const result = await post('albums', ['newest', 0, 1]);
          const answered = result.ok || !result.unreachable;
          reach = answered ? { away: false, since: null, checking: false, checkedAt: Date.now() } : { ...reach, checking: false, checkedAt: Date.now() };
          push();
          return answered ? { ok: true, value: undefined } : { ok: false, error: outOfReach, unreachable: true };
        },
      } : {}),
      ...(keptOptions ? { kept } : {}),
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
    playerPatch: options.player ?? {}, mini: options.mini ?? false, useServer: options.server ?? false, startAway: options.away ?? false, keptOptions: options.kept ?? null });
}
