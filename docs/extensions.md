# Extensions

Squiggly keeps a small core and lets extensions do the rest. An extension is a folder of TypeScript with a `package.json`. Put it in the extensions folder and it loads. Save a file in it and it reloads.

## Trust model

Extensions are full trust. They are not sandboxed.

- An extension runs inside the app's window, with everything the interface can do. It can read your library, control playback, and act on your music server account as the app does: star songs, create, edit, and delete playlists.
- It can't use Node or Electron, and it can't read or write your files. The window's content security policy lets it load scripts only from the app and from extensions, and blocks network requests to anywhere else.
- Squiggly doesn't review, sign, or check extensions. It loads the folders you put in the extensions folder, and nothing else.

Add extensions only from people you trust, and read the code first if you can.

## Quick start

1. Open Settings, then Extensions, then **Open the extensions folder**. The folder is:
   - Linux: `~/.config/squiggly/extensions` (or `$XDG_CONFIG_HOME/squiggly/extensions`)
   - Windows: `%APPDATA%\Squiggly\extensions`
2. Copy one of the examples from this repository into it:
   - [`examples/extensions/sleep-timer`](../examples/extensions/sleep-timer): commands and a right-click menu item.
   - [`examples/extensions/now-playing-clipboard`](../examples/extensions/now-playing-clipboard): a command with a default key (Ctrl+Shift+C) and a setting.
   - [`examples/extensions/library-stats`](../examples/extensions/library-stats): a page that pages through the library.
3. It appears in Settings › Extensions within a moment. Its commands are in the command palette (Ctrl+K).
4. Edit `src/index.ts` and save. The extension is compiled again, its old commands, menu items, pages, and themes are removed, and the new version starts.

A compile error shows on the extension's row in Settings › Extensions, with the file, line, and column. Fix it and save again.

For type checking in your editor, point `@squiggly/extension-api` at `packages/extension-api/index.ts` from this repository, as [`examples/extensions/tsconfig.json`](../examples/extensions/tsconfig.json) does. The app doesn't need it: it supplies that module itself when it compiles your extension.

## The config folder

Everything in the config folder applies while the app runs. There is nothing to restart.

| Path | What it is |
| --- | --- |
| `keybindings.json` | Your keys. They win over the app's and extensions' default keys. |
| `themes/<name>.json` | Themes. They appear in Settings › Theme. |
| `extensions/<folder>/` | Extensions. Watched and reloaded on save. |
| `extensions.json` | Which extensions are turned off. |

Files larger than 256 KB are skipped with a message. Set `SQUIGGLY_CONFIG_DIR` to use a different folder.

## Anatomy of an extension

```json
{
  "name": "sleep-timer",
  "version": "1.0.0",
  "description": "Pause playback after a while.",
  "squiggly": {
    "displayName": "Sleep timer",
    "renderer": "src/index.ts",
    "apiVersion": 1
  }
}
```

- `name` becomes the extension's id. A scoped name such as `@me/stats` becomes `me.stats`. Ids are lowercase and start with a letter, and everything an extension registers is prefixed with it: the command `start` of `sleep-timer` is `sleep-timer:start`.
- `squiggly.renderer` is the entry, a path inside the extension's folder. It can be TypeScript, JavaScript, TSX, or JSX.
- `displayName` and `description` show in Settings. `apiVersion` is the API the extension was written for; an extension that needs a newer API than the app has refuses to load, with a message.

The app compiles the entry with esbuild into one module, including any packages in the extension's own `node_modules`. Run `npm install` inside the extension's folder to use a dependency.

A few imports come from the app instead of `node_modules`, so an extension shares the window's copy: `@squiggly/extension-api`, `react`, `react/jsx-runtime`, `react-dom`, and `react-dom/client`. Other React packages such as `react-dom/server` are refused, because two copies of React in one window break hooks.

## The entry

```ts
import { defineExtension } from '@squiggly/extension-api';

export default defineExtension({
  activate(ctx) {
    ctx.commands.register({ id: 'hello', title: 'Say hello', keys: ['ctrl+alt+h'], run: () => ctx.notify('Hello.') });
    // Optional: return a function to run when the extension is turned off, removed, or reloaded.
    return () => {};
  },
});
```

`activate(ctx)` runs once per load. Everything registered through `ctx` is removed for you when the extension unloads, so an extension only cleans up what it started itself (timers, for example). Registering after unload throws.

The types in `@squiggly/extension-api` come from the app's own modules, so they always match what the app does.

### `ctx.commands`

- `register({ id, title, run, category?, when?, keys?, repeat? })` adds a command to the palette and returns a function that removes it.
  - `keys` are default keys in `keybindings.json` syntax: `ctrl+shift+c`, `alt+right`, or a chord like `g s`. The user's `keybindings.json` can add to or remove them.
  - `when()` hides the command, and turns its keys off, while it returns false.
  - `category` groups the palette and the key list. It defaults to the extension's name.
  - `repeat` lets a held key repeat the command.
- `execute(id)` runs any command by its full id, such as `builtin:toggle` or `other-extension:thing`.

### `ctx.menus`

`register({ id, label, run?, when?, submenu?, section?, danger? })` adds an item to right-click menus. `when(target)` decides where it shows. `target.kind` is `tracks`, `album`, `artist`, or `playlist`, with the matching data. Built-in items use sections 0 to 6; extension items default to section 10, below them.

### `ctx.player`

| Member | What it does |
| --- | --- |
| `get()` | The current state: `engine`, `connected`, `queue`, `entryIds`, `index`, `playing`, `position`, `duration`, `volume`, `radio`, `error`. |
| `subscribe(listener)` | Called on every update, a few times a second while playing. |
| `select(selector, listener)` | Called when the selected value changes. Prefer it to `subscribe`. |
| `use(selector)` | A React hook for pages. |
| `current()` | The playing track, or null. |
| `play(tracks, startIndex?)`, `add(tracks, 'next' \| 'end')`, `radio(seed)` | Queue changes. Tracks must come from the library API. |
| `toggle()`, `pause()`, `resume()`, `next()`, `previous()`, `seek(seconds)`, `volume(percent)` | Transport. |

### `ctx.library`

The app's library API: `albums`, `album`, `artists`, `artist`, `playlists`, `playlist`, `genres`, `starred`, `randomSongs`, `search`, `star`, playlist editing, `similarSongs`, `topSongs`, `lyrics`, and `coverUrl(coverArt, size)` for an image URL. Calls return `{ ok: true, value }` or `{ ok: false, error }` and never throw. They use the app's server session. Server credentials are not part of the API, because nothing in it needs them.

### `ctx.navigation`

- `go(route)` goes to a place: `{ view: 'records' }`, `{ view: 'album', id }`, `{ view: 'search', query }`, `{ view: 'queue' }`, `{ view: 'settings' }`, and so on.
- `back()`.
- `registerPage({ id, title, component })` adds a page and returns `{ id, dispose }`. The page is a React component rendered with the app's React, at the route `{ view: 'extension', id }`. A page that throws while rendering shows a message in its place, and the error appears in Settings › Extensions.
- `openPage(id)` goes to a registered page by its full id.

Pages can use the app's own class names (`head`, `head-text`, `facts`, `note`, `text-button`) to look at home, as the library-stats example does.

### `ctx.themes`

`register({ id, name, description?, tokens })` adds a theme to Settings › Theme, next to the user's theme files. `tokens` has the same shape as a `themes/*.json` file:

```ts
ctx.themes.register({
  id: 'harbour', name: 'Harbour',
  tokens: {
    colors: { ground: '#dfe6ea', ink: '#10202b', accent: '#0b6e99' },
    type: { display: 'Young Serif', body: 'Familjen Grotesk', size: 15, scale: 1 },
    density: 'comfortable', radius: 6, motion: 'full',
  },
});
```

Every field is optional, except that fixed colours need both `ground` and `ink`; the other colours are worked out from those two when missing. `colors: 'cover'` keeps taking colours from the playing record's sleeve. Colours that don't reach 4.5:1 against the ground (3:1 for the accent) are adjusted, and Settings says so. A theme with errors throws a `ThemeError` whose `problems` lists each one.

### Everything else

- `ctx.settings`: `get(key, fallback)`, `set(key, value)`, `all()`, `subscribe(listener)`. Kept in the window's local storage, at most 256 KB per extension, and removed with the extension.
- `ctx.notify(message, { level: 'info' | 'error' })` shows a short message in the corner of the window. Errors stay until dismissed.
- `ctx.styles.add(css)` adds a `<style>` element. A `.css` file imported by the entry comes in as text for this.
- `ctx.clipboard.writeText(text)`.
- `ctx.log.info / warn / error` write to the window's developer console, prefixed with the extension's id.
- `ctx.onDispose(fn)` runs `fn` when the extension unloads.

## Reloading, turning off, removing

- Saving a file the extension was built from, or its `package.json`, compiles it again. If the output changed, the old version is unloaded (its registrations removed, `onDispose` functions run) and the new one starts. Saving without a change does nothing.
- Adding or removing a folder in `extensions/` loads or unloads it.
- **Reload all** in Settings reloads every extension, even unchanged ones.
- Turning an extension off unloads it and records that in `extensions.json`.
- **Remove** in Settings moves the extension's folder to the system trash and deletes its settings.

To share an extension, share its folder: a git repository or an archive that someone copies into their extensions folder.

## Limits

- Extensions run only in the desktop app, in the main window. The mini player and the browser build don't load them.
- The API is versioned by `API_VERSION` in `@squiggly/extension-api`. Additions keep the number; breaking changes raise it.

## For contributors

| Where | What |
| --- | --- |
| `packages/extension-api/index.ts` | The public API: `defineExtension`, the context, and types re-exported from the app. |
| `apps/desktop/main/extensions/manager.ts` | Discovery, compiling, turning on and off, hot reload, removing to the trash. |
| `apps/desktop/main/extensions/compile.ts` | esbuild, and the modules the app supplies. |
| `apps/desktop/main/extensions/electron.ts` | IPC and the `squiggly-ext://` scheme. |
| `apps/desktop/renderer/src/app/extensions/` | The window's runtime, the context extensions receive, pages, notices, and Settings › Extensions. |
