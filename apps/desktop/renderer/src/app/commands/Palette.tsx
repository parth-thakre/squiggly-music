import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { registry, type Command } from '../registry';
import { filterCommands } from './filter';
import { keysFor, PALETTE, recentCommands, runCommand, useKeymap } from './keymap';
import { closePalette, isPhone, usePaletteOpen } from './palette-state';

// The command palette: a quiet list of everything the app can do, filtered as you type.
// Keyboard first (arrows, Enter, Escape); a bottom sheet on phones. The library has its own
// search in the bar.

export const CATEGORIES = ['Playback', 'Go to', 'Queue', 'Radio', 'View', 'Theme', 'Library', 'App'];
interface Item { key: string; command: Command; keys: string[] | null }
interface Group { label: string; items: Item[] }

export function CommandPalette() {
  return usePaletteOpen() ? <Palette /> : null;
}

function Palette() {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // On a touch screen nothing is highlighted until the keyboard is used.
  const [keyed, setKeyed] = useState(false);
  const version = useSyncExternalStore(registry.commands.subscribe, registry.commands.version);
  const { keymap } = useKeymap();
  const sheet = useMemo(isPhone, []);
  const dialog = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const groups = useMemo((): Group[] => {
    const commands = registry.commands.all().filter(command => command.id !== PALETTE && registry.commands.available(command.id));
    const item = (command: Command): Item => ({ key: command.id, command, keys: keysFor(keymap, command.id)[0] ?? null });
    const recent = recentCommands();
    const q = query.trim();
    if (!q) {
      const recentItems = recent.map(id => commands.find(command => command.id === id)).filter((c): c is Command => !!c).slice(0, 5);
      const rest = commands.filter(command => !recentItems.includes(command));
      const order = (category: string) => { const at = CATEGORIES.indexOf(category); return at < 0 ? CATEGORIES.length : at; };
      const categories = [...new Set(rest.map(command => command.category ?? 'Other'))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
      return [
        ...(recentItems.length ? [{ label: 'Recent', items: recentItems.map(item) }] : []),
        ...categories.map(category => ({ label: category, items: rest.filter(command => (command.category ?? 'Other') === category).map(item) })),
      ];
    }
    const found = filterCommands(q, commands, recent);
    return found.length ? [{ label: 'Commands', items: found.map(item) }] : [];
  }, [query, keymap, version]);
  const items = useMemo(() => groups.flatMap(group => group.items), [groups]);
  const at = Math.min(active, Math.max(0, items.length - 1));

  useEffect(() => { setActive(0); }, [query]);
  useLayoutEffect(() => { if (sheet) dialog.current?.focus({ preventScroll: true }); }, [sheet]);
  useLayoutEffect(() => { list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' }); }, [at]);
  useEffect(() => {
    // Leaving the window or resizing it closes the palette, like a menu.
    const close = () => void closePalette();
    addEventListener('blur', close);
    return () => removeEventListener('blur', close);
  }, []);

  const choose = async (chosen: Item | undefined) => {
    if (!chosen) return;
    await closePalette();
    await runCommand(chosen.command.id);
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const step = (by: number) => { event.preventDefault(); setKeyed(true); if (items.length) setActive((at + by + items.length) % items.length); };
    if (event.key === 'ArrowDown') step(1);
    else if (event.key === 'ArrowUp') step(-1);
    else if (event.key === 'PageDown') step(Math.min(8, items.length - 1 - at) || 0);
    else if (event.key === 'PageUp') step(-Math.min(8, at) || 0);
    else if (event.key === 'Enter') { event.preventDefault(); void choose(items[at]); }
    else if (event.key === 'Escape') { event.preventDefault(); void closePalette(); }
    // The palette is modal: Tab stays in its field.
    else if (event.key === 'Tab') event.preventDefault();
  };

  let index = -1;
  const optionId = (i: number) => `palette-option-${i}`;
  return <div className="palette-layer" onPointerDown={event => { if (event.target === event.currentTarget) void closePalette(); }}>
    <div ref={dialog} className={`menu palette${sheet ? ' sheet' : ''}${keyed ? ' keyed' : ''}`} role="dialog" aria-modal="true" aria-label="Commands" tabIndex={-1} data-own-keys onKeyDown={onKeyDown}>
      <input className="palette-input" type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
        aria-activedescendant={items.length ? optionId(at) : undefined} aria-label="Find a command" placeholder="Find a command"
        autoComplete="off" spellCheck={false} autoFocus={!sheet} value={query} onChange={event => setQuery(event.target.value)} />
      <div ref={list} id="palette-list" className="palette-list" role="listbox" aria-label="Results">
        {groups.map(group => <div key={group.label} role="group" aria-label={group.label}>
          <p className="menu-title" aria-hidden="true"><span>{group.label}</span></p>
          {group.items.map(item => {
            const i = ++index;
            return <div key={item.key} id={optionId(i)} data-index={i} role="option" aria-selected={i === at} className="palette-item"
              onPointerMove={() => { if (i !== at) setActive(i); }} onClick={() => void choose(item)}>
              <span className="palette-name">{item.command.title}
                {query.trim() && item.command.category && <span className="palette-detail">{item.command.category}</span>}</span>
              {item.keys && <span className="palette-keys">{item.keys.map((stroke, n) => <span key={n}>{n > 0 && <span className="then"> then </span>}<kbd>{stroke}</kbd></span>)}</span>}
            </div>;
          })}
        </div>)}
      </div>
      {!items.length && <p className="menu-note" role="status">{query.trim() ? `Nothing matches “${query.trim()}”.` : 'No commands are available right now.'}</p>}
    </div>
  </div>;
}
