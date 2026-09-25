import type { Album, Artist, Playlist, Track } from '../../../../../packages/core/contracts';

// The seam extensions will plug into. Built-in features register here the same way an
// extension will, so the API stays honest: nothing below is special-cased for built-ins.
//
// Lifecycle rules:
// - Every contribution has an owner ("builtin", or an extension's name). Its stored id is
//   namespaced as `owner:id`, so "play" registered by the built-ins is "builtin:play".
// - Collisions are refused, not resolved: adding an id that is already live throws a
//   RegistryCollision naming both owners. Nobody can silently shadow a built-in or another
//   extension; to replace something, dispose it first and register again.
// - Disposers are idempotent and identity-checked. Calling one twice does nothing the second
//   time, and disposing an old registration never removes a newer one with the same id.
// - `registry.scope(owner)` hands an extension its own add functions and one dispose() that
//   removes everything it registered, so an extension can be unloaded in one call.

export type MenuTarget =
  | { kind: 'tracks'; tracks: Track[]; indexes?: number[]; from?: { playlist?: Playlist; queue?: boolean };
      // Present when one song in an editable list is targeted: move it without dragging.
      reorder?: { index: number; length: number; move(to: number): void } }
  | { kind: 'album'; album: Album }
  | { kind: 'artist'; artist: Pick<Artist, 'id' | 'name'> & Partial<Artist> }
  | { kind: 'playlist'; playlist: Playlist };

export interface MenuItem {
  id: string;
  // Set by the registry: who contributed this item. Items built on the fly (submenu entries) have none.
  owner?: string;
  // Items are grouped by section, then kept in registration order.
  section: number;
  label: string | ((target: MenuTarget) => string);
  when?(target: MenuTarget): boolean;
  run?(target: MenuTarget): void | Promise<void>;
  // A nested list, such as the playlists to add to.
  submenu?(target: MenuTarget): MenuItem[] | Promise<MenuItem[]>;
  // A one-line text field in place of the item, such as a new playlist's name. Returns an error to show, if any.
  input?: { placeholder: string; submit(target: MenuTarget, value: string): Promise<string | void> };
  // Plain information lines, not actions.
  note?: boolean;
  danger?: boolean;
}

export interface Command { id: string; owner?: string; title: string; run(): void | Promise<void> }

export class RegistryCollision extends Error {
  constructor(kind: 'menu item' | 'command', id: string, owner: string) {
    super(`The ${kind} “${id}” is already registered by ${owner}. Dispose it before registering it again.`);
    this.name = 'RegistryCollision';
  }
}

type Dispose = () => void;
const OWNER = /^[a-z][a-z0-9._-]*$/;
const namespaced = (owner: string, id: string) => {
  if (!OWNER.test(owner)) throw new Error(`“${owner}” is not a valid owner name. Use lowercase letters, digits, dots, dashes, or underscores.`);
  if (!id || id.includes(':')) throw new Error(`“${id}” is not a valid id. The registry adds the owner prefix itself.`);
  return `${owner}:${id}`;
};

// Menu items keep registration order, so they live in an array; each entry is its own object,
// which is what the disposer checks for.
const menuItems: MenuItem[] = [];
const commands = new Map<string, Command>();

function addMenuItem(item: MenuItem, owner: string): Dispose {
  const entry: MenuItem = { ...item, id: namespaced(owner, item.id), owner };
  const live = menuItems.find(existing => existing.id === entry.id);
  if (live) throw new RegistryCollision('menu item', entry.id, live.owner ?? 'unknown');
  menuItems.push(entry);
  return () => { const at = menuItems.indexOf(entry); if (at >= 0) menuItems.splice(at, 1); };
}
function addCommand(command: Command, owner: string): Dispose {
  const entry: Command = { ...command, id: namespaced(owner, command.id), owner };
  const live = commands.get(entry.id);
  if (live) throw new RegistryCollision('command', entry.id, live.owner ?? 'unknown');
  commands.set(entry.id, entry);
  return () => { if (commands.get(entry.id) === entry) commands.delete(entry.id); };
}

export interface Scope {
  readonly owner: string;
  menu(item: MenuItem): Dispose;
  command(command: Command): Dispose;
  // Removes everything registered through this scope. Safe to call more than once.
  dispose(): void;
}

export const registry = {
  menu: {
    add: (item: MenuItem, owner = 'builtin') => addMenuItem(item, owner),
    // A predicate that throws hides its item and is reported, instead of breaking the whole menu.
    for(target: MenuTarget, onError: (item: MenuItem, error: unknown) => void = () => {}) {
      return menuItems.filter(item => {
        if (!item.when) return true;
        try { return item.when(target); } catch (error) { onError(item, error); return false; }
      }).sort((a, b) => a.section - b.section);
    },
  },
  commands: {
    add: (command: Command, owner = 'builtin') => addCommand(command, owner),
    get: (id: string) => commands.get(id),
    all: () => [...commands.values()],
  },
  scope(owner: string): Scope {
    namespaced(owner, 'check');
    const disposers = new Set<Dispose>();
    const track = (dispose: Dispose): Dispose => {
      let done = false;
      const once = () => { if (done) return; done = true; disposers.delete(once); dispose(); };
      disposers.add(once);
      return once;
    };
    return {
      owner,
      menu: item => track(addMenuItem(item, owner)),
      command: command => track(addCommand(command, owner)),
      dispose() { for (const dispose of [...disposers]) dispose(); },
    };
  },
};

export const labelOf = (item: MenuItem, target: MenuTarget) => typeof item.label === 'function' ? item.label(target) : item.label;
