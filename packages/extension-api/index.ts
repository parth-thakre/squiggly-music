// The public API for Squiggly extensions. See docs/extensions.md.
//
// An extension is a folder in the config folder's extensions/ with a package.json:
//
//   { "name": "sleep-timer", "version": "1.0.0",
//     "squiggly": { "renderer": "src/index.ts", "displayName": "Sleep timer" } }
//
// The renderer entry runs in the app window and can add commands, menu items, pages, and
// themes. It is TypeScript, compiled by the app when it loads; edit it and it reloads.
//
// Extensions are full trust. Nothing here is a sandbox: an extension can do anything the
// window can, including changing your playlists on the server. It has no Node access.
//
// The types below come from the app's own modules, so what an extension is promised is what
// the app actually implements.
import type { LibraryApi as AppLibraryApi, Track } from '../core/contracts';
import type { PlayerState as AppPlayerState, RadioStart } from '../../apps/desktop/renderer/src/app/player';
import type { Command, MenuItem, MenuTarget } from '../../apps/desktop/renderer/src/app/registry';
import type { Route } from '../../apps/desktop/renderer/src/app/route';
import type { ThemeInput } from '../../apps/desktop/renderer/src/app/theme';
import type { ThemeTokensInput } from '../../apps/desktop/renderer/src/app/theme/tokens';
import type { PageContribution } from '../../apps/desktop/renderer/src/app/extensions/pages';

export type {
  Album, AlbumDetail, AlbumListType, Artist, ArtistDetail, Genre, LibraryItems, Lyrics, LyricsQuery, Playlist,
  PlaylistDetail, RandomSongOptions, Result, StarTarget, Track,
} from '../core/contracts';
export type { MenuTarget, PageContribution, Route, ThemeTokensInput };

// Bumped only for breaking changes. Additions keep the same number.
export const API_VERSION = 1;

// Undoes a registration. Calling it twice does nothing the second time.
export type Dispose = () => void;

// The app's library API, without the calls the app makes for itself (play reports and the
// server-saved queue). Calls return { ok, value } or { ok: false, error } and never throw.
// They use the app's server session; credentials never reach extensions.
export type LibraryApi = Omit<AppLibraryApi, 'reportPlay' | 'savedQueue' | 'saveQueue'>;

// A command, as the registry keeps it. `id` is without the extension's prefix; the app adds it
// ("sleep-timer:start"). `category` defaults to the extension's name.
export type CommandContribution = Omit<Command, 'owner'>;

// A right-click menu item. `section` defaults to 10, below the built-in items (0 to 6).
export interface MenuContribution extends Omit<MenuItem, 'owner' | 'section' | 'submenu'> {
  section?: number;
  submenu?(target: MenuTarget): MenuContribution[] | Promise<MenuContribution[]>;
}

// A theme, in the same shape as a themes/*.json file in the config folder.
export type ThemeContribution = Omit<ThemeInput, 'tokens'> & { tokens: ThemeTokensInput };

// Player state as the window sees it. Positions are seconds.
export type PlayerState = Pick<AppPlayerState, 'engine' | 'connected' | 'queue' | 'entryIds' | 'index' | 'playing' | 'position' | 'duration' | 'volume' | 'radio' | 'error'>;
export type RadioSeed = RadioStart;

// Per-extension settings, kept in the window's local storage. Removed with the extension.
export interface SettingsStore {
  get<T>(key: string, fallback: T): T;
  // Values must survive JSON. The whole store is capped at 256 KB.
  set(key: string, value: unknown): Promise<void>;
  all(): Readonly<Record<string, unknown>>;
  subscribe(listener: (values: Readonly<Record<string, unknown>>) => void): Dispose;
}

export interface Logger {
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
}

export interface PlayerApi {
  get(): PlayerState;
  // Called after every change. Snapshots arrive a few times a second while playing.
  subscribe(listener: (state: PlayerState) => void): Dispose;
  // Called when the selected value changes (compared with Object.is).
  select<T>(selector: (state: PlayerState) => T, listener: (value: T) => void): Dispose;
  // A React hook for pages: re-renders when the selected value changes.
  use<T>(selector: (state: PlayerState) => T): T;
  current(): Track | null;
  // Replaces the queue. Tracks must come from the library API.
  play(tracks: Track[], startIndex?: number): Promise<void>;
  add(tracks: Track[], where: 'next' | 'end'): Promise<void>;
  radio(seed: RadioSeed): Promise<void>;
  toggle(): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  next(): void;
  previous(): void;
  seek(seconds: number): void;
  volume(percent: number): void;
}

export interface ExtensionContext {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: number;
  commands: {
    register(command: CommandContribution): Dispose;
    // Runs any registered command by its full id, such as "builtin:toggle" or "other-extension:thing".
    execute(id: string): Promise<void>;
  };
  menus: { register(item: MenuContribution): Dispose };
  player: PlayerApi;
  library: LibraryApi;
  navigation: {
    go(route: Route): void;
    back(): void;
    // Returns the page's full id, for go({ view: 'extension', id }).
    registerPage(page: PageContribution): { id: string; dispose: Dispose };
    openPage(id: string): void;
  };
  // Adds the theme to Settings › Theme, next to themes/*.json. Throws, listing every problem, if the tokens are invalid.
  themes: { register(theme: ThemeContribution): Dispose };
  // Adds a <style> element to the window. Removed on dispose.
  styles: { add(css: string): Dispose };
  settings: SettingsStore;
  notify(message: string, options?: { level?: 'info' | 'error' }): void;
  clipboard: { writeText(text: string): Promise<void> };
  log: Logger;
  // Runs when the extension is turned off, removed, or reloaded. Registrations above are undone for you.
  onDispose(dispose: Dispose): void;
}

// The renderer entry's default export. activate may return a function to run on dispose.
export interface Extension {
  activate(ctx: ExtensionContext): void | Dispose | Promise<void | Dispose>;
}

// An identity function that gives the entry its types.
export function defineExtension(extension: Extension): Extension { return extension; }
