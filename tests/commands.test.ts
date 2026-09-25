import { describe, expect, it } from 'vitest';
import { allowedIn, chordId, formatChordId, match, parseKeys, readUserBindings, resolveKeymap, strokeId, strokeOf, type KeyEventLike, type Stroke } from '../apps/desktop/renderer/src/app/commands/keys';
import { filterCommands } from '../apps/desktop/renderer/src/app/commands/filter';
import { registry } from '../apps/desktop/renderer/src/app/registry';

const chord = (text: string) => {
  const parsed = parseKeys(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return chordId(parsed.strokes);
};
const error = (text: unknown) => { const parsed = parseKeys(text); return parsed.ok ? null : parsed.error; };
const press = (event: Partial<KeyEventLike> & { key: string }) => {
  const stroke = strokeOf({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...event });
  return stroke && strokeId(stroke);
};
const stroke = (text: string): Stroke => { const parsed = parseKeys(text); if (!parsed.ok) throw new Error(parsed.error); return parsed.strokes[0]; };
const always = () => true;

describe('key parsing', () => {
  it('reads modifiers, names, and chords into one canonical form', () => {
    expect(chord('ctrl+k')).toBe('ctrl+k');
    expect(chord('Shift+Ctrl+K')).toBe('ctrl+shift+k');
    expect(chord('meta+k')).toBe('meta+k');
    expect(chord('alt+ArrowLeft')).toBe('alt+left');
    expect(chord('Space')).toBe('space');
    expect(chord('g r')).toBe('g r');
    expect(chord('  g   r ')).toBe('g r');
    expect(chord('ctrl++')).toBe('ctrl++');
    expect(chord('?')).toBe('?');
    expect(chord('F5')).toBe('f5');
    expect(chord('ctrl+shift+1')).toBe('ctrl+shift+1');
  });

  it('refuses what cannot be typed, and says what to write instead', () => {
    expect(error('')).toMatch(/empty/);
    expect(error(42)).toMatch(/empty/);
    expect(error('ctrl')).toMatch(/no key after its modifiers/);
    expect(error('hyper+k')).toMatch(/“hyper” in “hyper\+k” isn't a modifier/);
    // There is no macOS build, so there is no "mod" or "cmd".
    expect(error('mod+k')).toMatch(/isn't a modifier/);
    expect(error('ctrl+kk')).toMatch(/isn't a key/);
    expect(error('shift+/')).toMatch(/“\?” rather than “shift\+\/”/);
    expect(error('tab')).toMatch(/Tab moves between controls/);
    expect(error('a b c d')).toMatch(/up to three/);
    expect(error('ctrl+tab')).toBeNull();
  });
});

describe('reading key presses', () => {
  it('matches the written form, whatever the layout', () => {
    expect(press({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })).toBe('ctrl+shift+k');
    expect(press({ key: 'k', code: 'KeyK', metaKey: true })).toBe('meta+k');
    // Shift made "?" already; it isn't counted twice.
    expect(press({ key: '?', code: 'Slash', shiftKey: true })).toBe('?');
    // Some layouts turn Alt+K into a symbol; the physical key names it.
    expect(press({ key: '˚', code: 'KeyK', altKey: true })).toBe('alt+k');
    // A Cyrillic layout still types the "g r" chord from the same keys.
    expect(press({ key: 'п', code: 'KeyG' })).toBe('g');
    expect(press({ key: ' ', code: 'Space' })).toBe('space');
    expect(press({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })).toBe('alt+left');
    expect(press({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true })).toBe('ctrl+shift+1');
    expect(press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })).toBeNull();
    expect(press({ key: 'Dead', code: 'Quote' })).toBeNull();
  });
});

describe('typing contexts', () => {
  it('leaves text fields their typing and editing keys', () => {
    expect(allowedIn('text', stroke('k'))).toBe(false);
    expect(allowedIn('text', stroke('/'))).toBe(false);
    expect(allowedIn('text', stroke('space'))).toBe(false);
    expect(allowedIn('text', stroke('ctrl+k'))).toBe(true);
    expect(allowedIn('text', stroke('ctrl+a'))).toBe(false);
    expect(allowedIn('text', stroke('ctrl+left'))).toBe(false);
    expect(allowedIn('text', stroke('alt+left'))).toBe(true);
    expect(allowedIn('text', stroke('f5'))).toBe(true);
  });
  it('leaves Space and Enter to buttons, and arrows to sliders', () => {
    expect(allowedIn('button', stroke('space'))).toBe(false);
    expect(allowedIn('button', stroke('enter'))).toBe(false);
    expect(allowedIn('button', stroke('m'))).toBe(true);
    expect(allowedIn('control', stroke('left'))).toBe(false);
    expect(allowedIn('control', stroke('space'))).toBe(false);
    expect(allowedIn('control', stroke('ctrl+right'))).toBe(true);
    expect(allowedIn('free', stroke('space'))).toBe(true);
  });
});

const commands = [
  { id: 'builtin:toggle', title: 'Play or pause', keys: ['space'] },
  { id: 'builtin:palette', title: 'Show all commands', keys: ['ctrl+k'] },
  { id: 'builtin:go-records', title: 'Go to records', keys: ['g r'] },
  { id: 'builtin:go-artists', title: 'Go to artists', keys: ['g a'] },
  { id: 'builtin:mute', title: 'Mute or unmute', keys: ['m'] },
];

describe('resolving bindings', () => {
  it('applies user additions and removals over the defaults', () => {
    const keymap = resolveKeymap(commands, [
      { key: 'shift+p', command: 'builtin:toggle' },
      { key: 'space', command: '-builtin:toggle' },
      { command: '-builtin:mute' },
    ]);
    expect(keymap.errors).toEqual([]);
    expect(keymap.table.get('shift+p')).toEqual(['builtin:toggle']);
    expect(keymap.table.has('space')).toBe(false);
    expect(keymap.table.has('m')).toBe(false);
    expect(keymap.table.get('ctrl+k')).toEqual(['builtin:palette']);
    expect(keymap.bindings.find(b => b.chord === 'shift+p')?.source).toBe('user');
  });

  it('lists every problem in plain words and keeps the good entries', () => {
    const keymap = resolveKeymap(commands, [
      'ctrl+k',
      { key: 'ctrl+j', command: 'builtin:palette', when: 'always' },
      { key: 'ctrl+j' },
      { key: 'ctrl+j', command: 'toggle' },
      { key: 'shift+/', command: 'builtin:palette' },
      { key: 'ctrl+j', command: 'builtin:palette' },
      { key: 'ctrl+l', command: 'someone:else' },
      { key: 'x', command: '-builtin:toggle' },
    ]);
    expect(keymap.errors).toEqual([
      expect.stringMatching(/^Entry 1 isn't an object/),
      expect.stringMatching(/^Entry 2 has “when”/),
      expect.stringMatching(/^Entry 3 has no command/),
      expect.stringMatching(/^Entry 4: “toggle” needs its owner, such as “builtin:toggle”/),
      expect.stringMatching(/^Entry 5: Write the character Shift makes/),
    ]);
    expect(keymap.table.get('ctrl+j')).toEqual(['builtin:palette']);
    expect(keymap.notes).toEqual([
      expect.stringMatching(/^Entry 7: no command called “someone:else” is loaded/),
      expect.stringMatching(/^Entry 8 removes “X” from “Play or pause”, which doesn't have it/),
    ]);
    // A binding for a command that isn't loaded yet still waits in the table.
    expect(keymap.table.get('ctrl+l')).toEqual(['someone:else']);
    expect(readUserBindings({ key: 'k' }).errors[0]).toMatch(/must be a list/);
    expect(resolveKeymap(commands, null).errors).toEqual([]);
  });

  it('finds conflicts: two commands on one key, and a key that hides a chord', () => {
    const keymap = resolveKeymap([...commands, { id: 'ext:go', title: 'Go somewhere', keys: ['g'] }, { id: 'ext:hush', title: 'Hush', keys: ['m'] }], [
      { key: 'ctrl+k', command: 'builtin:mute' },
    ]);
    // The user's binding comes first; the default it displaced is still listed.
    expect(keymap.table.get('ctrl+k')).toEqual(['builtin:mute', 'builtin:palette']);
    expect(keymap.table.get('m')).toEqual(['builtin:mute', 'ext:hush']);
    const messages = keymap.conflicts.map(c => c.message);
    expect(messages).toContain('Ctrl+K is bound to “Mute or unmute” and “Show all commands”. It runs “Mute or unmute” when both are available.');
    expect(messages).toContain('M is bound to “Mute or unmute” and “Hush”. It runs “Mute or unmute” when both are available.');
    expect(messages).toContain('G runs “Go somewhere” at once, so G then R and G then A can\'t be typed.');
  });
});

describe('matching presses', () => {
  const keymap = resolveKeymap(commands, [{ key: 'ctrl+k g', command: 'builtin:go-artists' }]);
  it('runs single keys and waits on the first step of a chord', () => {
    expect(match(keymap, [], 'space', always)).toEqual({ run: 'builtin:toggle', pending: [], consumed: true });
    const first = match(keymap, [], 'g', always);
    expect(first).toEqual({ run: null, pending: ['g'], consumed: true });
    expect(match(keymap, first.pending, 'r', always)).toEqual({ run: 'builtin:go-records', pending: [], consumed: true });
    expect(match(keymap, [], 'q', always)).toEqual({ run: null, pending: [], consumed: false });
  });
  it('starts over when a chord goes wrong, and takes the stroke on its own', () => {
    expect(match(keymap, ['g'], 'm', always)).toEqual({ run: 'builtin:mute', pending: [], consumed: true });
    expect(match(keymap, ['g'], 'q', always)).toEqual({ run: null, pending: [], consumed: false });
  });
  it('a complete binding runs at once even when it also starts a chord', () => {
    expect(match(keymap, [], 'ctrl+k', always).run).toBe('builtin:palette');
  });
  it('skips commands that are not available and falls through to the next', () => {
    const shared = resolveKeymap([...commands, { id: 'ext:hush', title: 'Hush', keys: ['m'] }], null);
    expect(match(shared, [], 'm', id => id !== 'builtin:mute').run).toBe('ext:hush');
    expect(match(shared, [], 'm', () => false)).toEqual({ run: null, pending: [], consumed: false });
    // A chord whose commands are all unavailable doesn't swallow its first key.
    expect(match(shared, [], 'g', () => false).consumed).toBe(false);
  });
  it('shows keys the way Windows and Linux write them', () => {
    expect(formatChordId('ctrl+shift+k')).toEqual(['Ctrl+Shift+K']);
    expect(formatChordId('meta+k')).toEqual(['Meta+K']);
    expect(formatChordId('g r')).toEqual(['G', 'R']);
    expect(formatChordId('alt+left')).toEqual(['Alt+←']);
  });
});

describe('registry commands and keys', () => {
  it('keys follow commands as they register, check their predicates, and leave on dispose', async () => {
    const scope = registry.scope('kbtest');
    let enabled = false;
    let ran = 0;
    let notified = 0;
    const stop = registry.commands.subscribe(() => notified++);
    scope.command({ id: 'one', title: 'One', category: 'Test', keys: ['ctrl+alt+1'], when: () => enabled, run: () => { ran++; } });
    scope.command({ id: 'two', title: 'Two', keys: ['ctrl+alt+2'], run() {} });
    scope.command({ id: 'broken', title: 'Broken', when: () => { throw new Error('no'); }, run() {} });
    await Promise.resolve();
    // Three registrations, one rebuild.
    expect(notified).toBe(1);
    const keymap = resolveKeymap(registry.commands.all(), null);
    expect(keymap.table.get('ctrl+alt+1')).toEqual(['kbtest:one']);
    expect(registry.commands.get('kbtest:one')?.category).toBe('Test');
    expect(match(keymap, [], 'ctrl+alt+1', registry.commands.available).run).toBeNull();
    enabled = true;
    const hit = match(keymap, [], 'ctrl+alt+1', registry.commands.available);
    expect(hit.run).toBe('kbtest:one');
    await registry.commands.get(hit.run!)!.run();
    expect(ran).toBe(1);
    expect(registry.commands.available('kbtest:broken')).toBe(false);
    expect(registry.commands.available('kbtest:missing')).toBe(false);

    const before = registry.commands.version();
    scope.dispose();
    await Promise.resolve();
    expect(registry.commands.version()).toBeGreaterThan(before);
    expect(notified).toBe(2);
    expect(resolveKeymap(registry.commands.all(), null).table.has('ctrl+alt+1')).toBe(false);
    stop();
  });
});

describe('palette filtering', () => {
  const list = (...titles: string[]) => titles.map((title, i) => ({ id: `t:${i}`, title, category: i === 0 ? 'Playback' : 'Go to' }));
  const titles = (query: string, items: ReturnType<typeof list>, recent: string[] = []) => filterCommands(query, items, recent).map(item => item.title);
  it('matches a substring, ignoring case, and ranks starts, then word starts, then position', () => {
    const items = list('Play or pause', 'Go to playlists', 'Replay the song', 'Go to records');
    expect(titles('PLAY', items)).toEqual(['Play or pause', 'Go to playlists', 'Replay the song']);
    expect(titles('xyz', items)).toEqual([]);
    expect(titles('  ', items)).toEqual(items.map(item => item.title));
    // Letters in order but not together don't match.
    expect(titles('gr', items)).toEqual([]);
  });
  it('breaks ties by recent use, then by order, and falls back to the category', () => {
    const items = list('Volume up', 'Go to queue', 'Go to lyrics');
    expect(titles('go to', items)).toEqual(['Go to queue', 'Go to lyrics']);
    expect(titles('go to', items, ['t:2'])).toEqual(['Go to lyrics', 'Go to queue']);
    expect(titles('playback', items)).toEqual(['Volume up']);
  });
});
