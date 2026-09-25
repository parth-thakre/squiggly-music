import { useState, useSyncExternalStore } from 'react';
import { registry, type Command } from '../registry';
import { configApi, openConfigFolder } from '../config';
import { formatChord } from './keys';
import { fileBacked, PALETTE, saveBrowserBindings, useKeymap, keysFor } from './keymap';
import { CATEGORIES } from './Palette';

// Settings › Keys: every command with its keys, and what's wrong with the user's bindings.
export function KeySettings() {
  const state = useKeymap();
  useSyncExternalStore(registry.commands.subscribe, registry.commands.version);
  const [opened, setOpened] = useState<string | null>(null);
  const { keymap } = state;
  const title = (id: string) => registry.commands.get(id)?.title ?? id;
  const byCategory = new Map<string, Command[]>();
  for (const command of registry.commands.all()) {
    const category = command.category ?? 'Other';
    byCategory.set(category, [...(byCategory.get(category) ?? []), command]);
  }
  const order = (category: string) => { const at = CATEGORIES.indexOf(category); return at < 0 ? CATEGORIES.length : at; };
  const categories = [...byCategory.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const palette = keysFor(keymap, PALETTE)[0];
  const problems = state.errors.length + state.conflicts.length + state.notes.length;

  return <>
    <h2 id="keys">Keys</h2>
    <p className="note">
      {palette ? <>Press <kbd>{palette.join(' then ')}</kbd> to find any command. </> : null}
      {fileBacked ? 'Change keys in keybindings.json, in the config folder. Saved changes apply at once.' : 'Your keys are kept in this browser.'}
    </p>
    {fileBacked && <div className="actions settings-actions">
      <button type="button" className="text-button" onClick={async () => setOpened(await openConfigFolder())}>Open the config folder</button>
      {configApi?.dir && <span className="note path">{configApi.dir}</span>}
    </div>}
    {opened && <p className="note" role="alert">{opened}</p>}
    {problems > 0 && <div className="problems" role={state.errors.length ? 'alert' : undefined}>
      {state.errors.length > 0 && <><p className="problems-head">{state.errors.length === 1 ? 'One binding was skipped' : `${state.errors.length} bindings were skipped`}</p>
        <ul>{state.errors.map(error => <li key={error}>{error}</li>)}</ul></>}
      {state.conflicts.length > 0 && <><p className="problems-head">{state.conflicts.length === 1 ? 'One key does two things' : `${state.conflicts.length} keys do more than one thing`}</p>
        <ul>{state.conflicts.map(conflict => <li key={conflict.message}>{conflict.message}</li>)}</ul></>}
      {state.notes.length > 0 && <ul className="quiet">{state.notes.map(note => <li key={note}>{note}</li>)}</ul>}
    </div>}
    <table className="facts key-table" aria-label="Commands and their keys">
      {categories.map(category => <tbody key={category}>
        <tr><th scope="colgroup" colSpan={2} className="key-group">{category}</th></tr>
        {byCategory.get(category)!.map(command => {
          const bindings = keymap.bindings.filter(binding => binding.command === command.id);
          return <tr key={command.id}>
            <th scope="row">{command.title}<span className="command-id">{command.id}</span></th>
            <td>{bindings.length ? bindings.map(binding => {
              const ids = keymap.table.get(binding.chord) ?? [];
              const loses = ids[0] !== command.id;
              return <span key={binding.chord} className={`binding${loses ? ' loses' : ''}`}>
                <kbd>{formatChord(binding.strokes).join(' then ')}</kbd>
                {binding.source === 'user' && <span className="binding-note"> yours</span>}
                {loses && <span className="binding-note"> taken by {title(ids[0])}</span>}
              </span>;
            }) : <span className="binding-note">None</span>}</td>
          </tr>;
        })}
      </tbody>)}
    </table>
    {!fileBacked && <BrowserBindings text={state.text} />}
  </>;
}

const EXAMPLE = '[\n  { "key": "shift+p", "command": "builtin:toggle" },\n  { "key": "space", "command": "-builtin:toggle" }\n]';

function BrowserBindings({ text }: { text: string }) {
  const [draft, setDraft] = useState(text || '[]');
  const [message, setMessage] = useState<string | null>(null);
  return <div className="key-editor">
    <label htmlFor="keybindings-json">Your key bindings</label>
    <textarea id="keybindings-json" rows={Math.min(14, Math.max(5, draft.split('\n').length + 1))} spellCheck={false} value={draft}
      onChange={event => { setDraft(event.target.value); setMessage(null); }} />
    <div className="actions settings-actions">
      <button type="button" className="text-button" onClick={() => setMessage(saveBrowserBindings(draft) ?? 'Saved. The keys work now.')}>Save keys</button>
      <button type="button" className="text-button quiet" onClick={() => { setDraft('[]'); setMessage(saveBrowserBindings('') ?? 'Back to the default keys.'); }}>Use the default keys</button>
    </div>
    {message && <p className="note" role="status">{message}</p>}
    <p className="note hint">A list of entries like <code>{'{ "key": "ctrl+k", "command": "builtin:palette" }'}</code>. Put “-” before a command to remove its key. A chord is two keys with a space between, such as “g r”. For example:</p>
    <pre className="key-example">{EXAMPLE}</pre>
  </div>;
}
