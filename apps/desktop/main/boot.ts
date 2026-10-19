import { app } from 'electron';
import { enableCompileCache } from 'node:module';
import { join } from 'node:path';

// The main process's entry. Before index.ts and everything it imports are read, Node is told to
// keep the code it compiles, so later launches skip compiling it again (the app's own code, and
// packages such as effect, take much of a cold start). The audio process gets the same folder
// through NODE_COMPILE_CACHE, which the host it forks inherits (launchPlayer in index.ts).
// The cache lives with the app's data, not in the shared temporary folder, where another account
// could plant entries. It's left off where the app's files move on every launch (an AppImage
// mounts somewhere new, the Windows portable exe unpacks somewhere new): each launch would add a
// cache and never reuse one.
if (!process.env.APPIMAGE && !process.env.PORTABLE_EXECUTABLE_DIR) {
  const dir = join(app.getPath('userData'), 'code-cache');
  // Only a speed-up: a cache that can't be made changes nothing else.
  try { enableCompileCache(dir); process.env.NODE_COMPILE_CACHE = dir; } catch { /* compiled each launch, as before */ }
}
await import('./index');
