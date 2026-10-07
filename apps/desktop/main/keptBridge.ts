import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { Effect, Schema } from 'effect';
import type { Track } from '../../../packages/core/contracts';
import { KEPT_MESSAGES } from '../../../packages/core/kept';
import { KeepRequestSchema, KeptIdSchema } from '../../../packages/core/desktopValidation';
import type { KeepManager } from './keepManager';
import type { KeptStore } from './keptStore';

type Handle = (channel: string, task: (value: unknown, generation: number) => Effect.Effect<unknown, unknown>, lane: 'kept') => void;

// Connects Keep on this device to the windows: the IPC channels, and a push on squiggly:kept with
// the downloads' progress, at most every 250 ms. Windows see song ids, containers, and the folder;
// never a song's path.
export function startKept(deps: {
  assertSender(event: IpcMainInvokeEvent): void; windows(): WebContents[]; handle: Handle;
  dir: string; manager: KeepManager; store: KeptStore; remember(tracks: readonly Track[]): void;
}) {
  const { manager, store, dir } = deps;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const progress = manager.progress();
      for (const target of deps.windows()) if (!target.isDestroyed()) target.send('squiggly:kept', progress);
    }, 250);
  };
  ipcMain.handle('squiggly:kept:state', event => { deps.assertSender(event); return manager.state(dir); });
  ipcMain.handle('squiggly:kept:present', event => { deps.assertSender(event); return store.presentIds(); });
  const id = (value: unknown) => Schema.decodeUnknown(KeptIdSchema)(value).pipe(Effect.mapError(() => new Error(KEPT_MESSAGES.unknown)));
  deps.handle('kept:container', value => Effect.gen(function* () {
    const [kind, containerId] = yield* id(value);
    const detail = store.detail(kind, containerId);
    if (!detail) return yield* Effect.fail(new Error(KEPT_MESSAGES.unknown));
    // So play-tracks finds them, as it finds tracks the library returned.
    deps.remember(detail.tracks);
    return detail;
  }), 'kept');
  deps.handle('kept:keep', value => Effect.gen(function* () {
    const request = yield* Schema.decodeUnknown(KeepRequestSchema)(value).pipe(Effect.mapError(() => new Error('Invalid keep request.')));
    const result = yield* Effect.promise(() => manager.keep(request));
    if (!result.ok) return yield* Effect.fail(new Error(result.error));
  }), 'kept');
  deps.handle('kept:cancel', value => Effect.gen(function* () {
    const [kind, containerId] = yield* id(value);
    manager.cancel(kind, containerId);
  }), 'kept');
  deps.handle('kept:forget', value => Effect.gen(function* () {
    const [kind, containerId] = yield* id(value);
    const result = yield* Effect.promise(() => manager.forget(kind, containerId));
    if (!result.ok) return yield* Effect.fail(new Error(result.error));
  }), 'kept');
  deps.handle('kept:forget-all', () => Effect.promise(() => manager.forgetAll()), 'kept');
  deps.handle('kept:open-dir', () => Effect.gen(function* () {
    const error = yield* Effect.promise(() => shell.openPath(dir));
    if (error) return yield* Effect.fail(new Error('Could not open the kept folder.'));
  }), 'kept');
  return { push };
}
