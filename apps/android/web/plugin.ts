import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

// The app's own Capacitor plugin (apps/android/app/src/main/java/dev/squiggly/music/SquigglyPlugin.kt).

// A queue entry as the native player holds it. The stream addresses carry credentials; they go
// to the player and nowhere else. `track` is the page's Track as JSON, kept natively so a page
// that loads while the player is already going (after the app was swiped away) can show it.
export interface NativeItem {
  id: string; url: string; fallbackUrl: string;
  title: string; artist: string; album: string; coverArt: string | null; duration: number | null;
  track: string;
}
export type NativeOp =
  | { type: 'replace'; items: NativeItem[] }
  | { type: 'remove'; from: number; count: number }
  | { type: 'insert'; at: number; items: NativeItem[] }
  | { type: 'move'; from: number; to: number };

export interface NativePlayback {
  // The last command with a sequence number the player has carried out. Reports from before a
  // command the page has since sent describe a queue position the page has already left.
  seq: number;
  entryId: string | null; playId: number;
  playing: boolean; buffering: boolean; ended: boolean;
  position: number; duration: number; fallback: boolean; error: string | null;
}
export interface NativeAccount { url: string; username: string; password: string }
export interface Posture { posture: 'flat' | 'flex'; top: number; bottom: number }

export interface SquigglyPlugin {
  http(options: { id: number; url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number }):
    Promise<{ status: number; headers: Record<string, string>; body: string }>;
  cancelHttp(options: { id: number }): Promise<void>;

  // The sign-in, encrypted with a key in the Android Keystore. canRemember is false when the
  // Keystore can't be used; the page then keeps the password for this session only.
  loadAccount(): Promise<{ canRemember: boolean; account: NativeAccount | null }>;
  saveAccount(account: NativeAccount): Promise<{ saved: boolean }>;
  forgetAccount(): Promise<void>;
  // Where the cover proxy (https://localhost/api/cover) fetches from; null after disconnecting.
  setServer(options: { coverBase: string | null; key: string | null }): Promise<void>;

  edit(options: { ops: NativeOp[]; seq: number }): Promise<{ ids: string[] }>;
  load(options: { id: string; position: number; play: boolean; seq: number }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { id: string; position: number }): Promise<void>;
  volume(options: { volume: number }): Promise<void>;
  restore(): Promise<{ items: { id: string; track: string }[]; playback: NativePlayback }>;
  // ExoPlayer's repeat mode. The page shuffles its queue itself.
  repeat(options: { mode: 'off' | 'all' | 'one' }): Promise<void>;
  posture(): Promise<Posture>;
  // The window's own background (#rrggbb), which shows around the page on older WebViews, and
  // light (dark: true) or dark system bar icons.
  setWindowColour(options: { colour: string; dark: boolean }): Promise<void>;

  addListener(event: 'playback', listener: (playback: NativePlayback) => void): Promise<PluginListenerHandle>;
  addListener(event: 'posture', listener: (posture: Posture) => void): Promise<PluginListenerHandle>;
}

export const Squiggly = registerPlugin<SquigglyPlugin>('Squiggly');
