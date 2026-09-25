import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigFolder, configDirectory, readConfigFiles, CONFIG_FILE_LIMIT } from '../apps/desktop/main/config';

const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });
const tempDir = async () => { const dir = await mkdtemp(join(tmpdir(), 'squiggly-config-')); temporary.push(dir); return dir; };
const until = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting.'); await new Promise(done => setTimeout(done, 25)); }
};

describe('config folder', () => {
  it('follows each platform, and XDG_CONFIG_HOME on Linux', () => {
    expect(configDirectory('linux', {}, '/home/a')).toBe('/home/a/.config/squiggly');
    expect(configDirectory('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/a')).toBe('/xdg/squiggly');
    // Relative XDG paths are invalid by the spec and ignored.
    expect(configDirectory('linux', { XDG_CONFIG_HOME: 'relative' }, '/home/a')).toBe('/home/a/.config/squiggly');
    expect(configDirectory('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a')).toMatch(/Roaming[\\/]Squiggly$/);
    expect(configDirectory('darwin', {}, '/Users/a')).toBe('/Users/a/Library/Application Support/Squiggly');
    expect(configDirectory('linux', { SQUIGGLY_CONFIG_DIR: '/custom' }, '/home/a')).toBe('/custom');
  });

  it('creates its layout and a README once, and reads keybindings and themes with plain errors', async () => {
    const dir = join(await tempDir(), 'squiggly');
    const folder = new ConfigFolder(dir, 20);
    const empty = await folder.start();
    expect(empty).toEqual({ keybindings: null, themes: [], errors: [] });
    expect(existsSync(join(dir, 'themes'))).toBe(true);
    await writeFile(join(dir, 'README.txt'), 'edited');
    folder.close();
    await new ConfigFolder(dir).start().then(() => undefined);
    expect(await readFile(join(dir, 'README.txt'), 'utf8')).toBe('edited');

    await writeFile(join(dir, 'keybindings.json'), '{ "builtin:play": ["space"] }');
    await writeFile(join(dir, 'themes', 'night.json'), '{ "name": "Night", "colors": { "ground": "#101418" } }');
    await writeFile(join(dir, 'themes', 'broken.json'), '{ nope');
    await writeFile(join(dir, 'themes', 'list.json'), '[1]');
    await writeFile(join(dir, 'themes', 'big.json'), `{"name":"${'x'.repeat(CONFIG_FILE_LIMIT)}"}`);
    await writeFile(join(dir, 'themes', 'Bad Name.json'), '{}');
    await writeFile(join(dir, 'themes', 'notes.txt'), 'ignored');
    const files = await readConfigFiles(dir);
    expect(files.keybindings).toEqual({ 'builtin:play': ['space'] });
    expect(files.themes).toEqual([{ id: 'night', name: 'Night', tokens: { name: 'Night', colors: { ground: '#101418' } } }]);
    expect(files.errors).toHaveLength(4);
    expect(files.errors.join('\n')).toMatch(/themes\/broken\.json is not valid JSON/);
    expect(files.errors.join('\n')).toMatch(/big\.json is larger than 256 KB/);
    expect(files.errors.join('\n')).toMatch(/list\.json: a theme is a JSON object/);
  });

  it('pushes changes after a debounce, and only when the contents change', async () => {
    const dir = join(await tempDir(), 'squiggly');
    const folder = new ConfigFolder(dir, 30);
    await folder.start();
    const seen: unknown[] = [];
    folder.subscribe(files => seen.push(files.keybindings));
    await writeFile(join(dir, 'keybindings.json'), '{"a":["x"]}');
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual({ a: ['x'] });
    // Saved again without a change: nothing new.
    await writeFile(join(dir, 'keybindings.json'), '{"a":["x"]}');
    await new Promise(done => setTimeout(done, 200));
    expect(seen).toHaveLength(1);
    await writeFile(join(dir, 'themes', 'day.json'), '{"name":"Day"}');
    await until(() => seen.length === 2 && folder.current.themes.length === 1);
    // Other files in the folder don't count as a config change.
    await writeFile(join(dir, 'notes.json'), '{}');
    await new Promise(done => setTimeout(done, 200));
    expect(seen).toHaveLength(2);
    folder.close();
  });
});

