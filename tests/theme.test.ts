import { describe, expect, it } from 'vitest';
import { contrast, MARK_CONTRAST, TEXT_CONTRAST } from '../apps/desktop/renderer/src/app/palette';
import { BUILTIN_THEMES, checkTokens, DEFAULT_TOKENS, fontStack, tintOf, type ThemeColors } from '../apps/desktop/renderer/src/app/theme/tokens';
import { RegistryCollision } from '../apps/desktop/renderer/src/app/registry';
import { getThemes, loadUserThemes, registerTheme, selectTheme, ThemeError, themePalette } from '../apps/desktop/renderer/src/app/theme';

const fixed = (tokens: unknown) => {
  const checked = checkTokens(tokens);
  if (!checked.tokens) throw new Error(checked.errors.join('\n'));
  return { colors: checked.tokens.colors as ThemeColors, notes: checked.notes, tokens: checked.tokens };
};
function expectReadable(colors: ThemeColors) {
  for (const ground of [colors.ground, tintOf(colors)]) {
    for (const key of ['ink', 'soft', 'accentText'] as const) expect(contrast(colors[key], ground), `${key} on ${ground}`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrast(colors.accent, ground), `accent on ${ground}`).toBeGreaterThanOrEqual(MARK_CONTRAST);
  }
}

describe('theme tokens', () => {
  it('fills what is missing from the Cover theme', () => {
    expect(checkTokens({})).toEqual({ tokens: DEFAULT_TOKENS, errors: [], notes: [] });
    expect(checkTokens({ colors: 'cover', name: 'Mine', $schema: 'x' }).tokens?.colors).toBe('cover');
    const { tokens } = fixed({ colors: { ground: '#FFF', ink: '#000' }, type: { size: 17, scale: 1.2, display: 'IBM Plex Serif' }, density: 'compact', radius: 3.4, motion: 'none' });
    expect(tokens.colors).toMatchObject({ ground: '#ffffff', ink: '#000000', accent: '#000000', accentText: '#000000', line: null });
    expect(tokens.type).toEqual({ display: 'IBM Plex Serif', body: 'Familjen Grotesk', size: 17, scale: 1.2 });
    expect(tokens).toMatchObject({ density: 'compact', radius: 3, motion: 'none' });
  });

  it('refuses mistakes with one plain message each', () => {
    const { tokens, errors } = checkTokens({
      colours: {}, colors: { ground: 'navy', ink: '#12345', glow: '#fff' },
      type: { display: 'Evil"; } body { x', size: 40, scale: 'big', weight: 700 }, density: 'cosy', radius: -1, motion: 'slow',
    });
    expect(tokens).toBeNull();
    expect(errors).toEqual([
      '“colours” isn\'t a theme setting. Use colors, type, density, radius, or motion. Use “colors”.',
      'colors: “glow” isn\'t a theme setting. Use ground, ink, soft, accent, accentText, or line.',
      'colors.ground is “navy”, which isn\'t a colour. Use hex, such as “#1b2a3c”.',
      'colors.ink is “#12345”, which isn\'t a colour. Use hex, such as “#1b2a3c”.',
      'type: “weight” isn\'t a theme setting. Use display, body, size, or scale.',
      expect.stringMatching(/^type\.display is “Evil"; \} body \{ x”\. Name one font family/),
      'type.size is 40. Use a number from 12 to 20 (pixels).',
      'type.scale is “big”. Use a number from 0.8 to 1.4.',
      'density is “cosy”. Use “comfortable” or “compact”.',
      'radius is -1. Use a number of pixels from 0 to 16.',
      'motion is “slow”. Use “full”, “reduced”, or “none”.',
    ]);
    expect(checkTokens([]).errors[0]).toMatch(/JSON object/);
    expect(checkTokens({ colors: { ink: '#000' } }).errors).toEqual(['colors.ground is missing. A fixed theme needs at least ground and ink.']);
    expect(checkTokens({ colors: 'sleeve' }).errors[0]).toMatch(/Use "cover", or an object/);
  });

  it('corrects colours that fail contrast, and says what it changed', () => {
    const { colors, notes } = fixed({ colors: { ground: '#f4f1ea', ink: '#222222', soft: '#b0aca4', accent: '#f5d76e', accentText: '#e0b030' } });
    expectReadable(colors);
    expect(colors.ink).toBe('#222222');
    expect(colors.soft).not.toBe('#b0aca4');
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/^colors\.soft #b0aca4 reads at \d\.\d:1 on a selected row, below the 4\.5:1 text needs, so it shows as #[0-9a-f]{6}\.$/);
    expect(notes.find(note => note.startsWith('colors.accent '))).toMatch(/below the 3:1 marks need/);
    // Dark grounds get lighter text.
    const night = fixed({ colors: { ground: '#101418', ink: '#e0e0e0', soft: '#404850' } });
    expectReadable(night.colors);
    expect(contrast(night.colors.soft, '#ffffff')).toBeLessThan(contrast('#404850', '#ffffff'));
  });

  it('refuses colours no shade can fix', () => {
    const { tokens, errors } = checkTokens({ colors: { ground: '#ffffff', ink: '#111111', line: '#111111' } });
    expect(tokens).toBeNull();
    expect(errors[0]).toMatch(/^colors\.ink #111111 reads at 1\.0:1 and no shade of it reaches the 4\.5:1 text needs on this ground and line/);
  });

  it('ships built-in themes that need no correction', () => {
    expect(BUILTIN_THEMES.map(theme => theme.id)).toEqual(['cover', 'studio', 'night', 'plain']);
    for (const theme of BUILTIN_THEMES) {
      const checked = checkTokens(theme.tokens);
      expect(checked.errors, theme.id).toEqual([]);
      expect(checked.notes, theme.id).toEqual([]);
      if (checked.tokens!.colors !== 'cover') expectReadable(checked.tokens!.colors);
    }
  });

  it('turns font names into safe stacks', () => {
    expect(fontStack('Young Serif', 'display')).toBe("'Young Serif', 'Young Serif', serif");
    expect(fontStack('familjen grotesk', 'body')).toBe("'Familjen Grotesk Variable', 'Familjen Grotesk Variable', system-ui, sans-serif");
    expect(fontStack('Iowan Old Style', 'display')).toBe("'Iowan Old Style', 'Young Serif', serif");
    expect(fontStack('monospace', 'body')).toBe("monospace, 'Familjen Grotesk Variable', system-ui, sans-serif");
  });
});

describe('theme files', () => {
  const harbour = { id: 'harbour', name: 'Harbour', tokens: { colors: { ground: '#dfe6ea', ink: '#10202b', accent: '#c2410c' } } };

  it('shows Cover while a picked theme is gone, and returns to it', () => {
    loadUserThemes([harbour]);
    selectTheme('user:harbour');
    expect(getThemes().active).toMatchObject({ id: 'user:harbour', source: 'user' });
    expect(themePalette(getThemes().active)).toMatchObject({ ground: '#dfe6ea', ink: '#10202b' });
    loadUserThemes([]);
    expect(getThemes()).toMatchObject({ chosen: 'user:harbour', active: { id: 'builtin:cover' } });
    expect(themePalette(getThemes().active)).toBeNull();
    loadUserThemes([harbour]);
    expect(getThemes().active.id).toBe('user:harbour');
    loadUserThemes([]);
    selectTheme('builtin:cover');
  });

  it('loads theme files one by one, naming the file that failed', () => {
    loadUserThemes([
      { id: 'dusk', name: 'Dusk', tokens: { colors: { ground: '#2a2233', ink: '#f1e9ff', soft: '#6a5f78' } } },
      { id: 'oops', name: 'Oops', tokens: { colors: { ground: 'blue', ink: '#000' } } },
    ], ['themes/unreadable.json is not valid JSON.']);
    const state = getThemes();
    expect(state.themes.map(theme => theme.id)).toContain('user:dusk');
    expect(state.themes.map(theme => theme.id)).not.toContain('user:oops');
    expect(state.problems).toEqual(['themes/unreadable.json is not valid JSON.', 'themes/oops.json: colors.ground is “blue”, which isn\'t a colour. Use hex, such as “#1b2a3c”.']);
    expect(state.notes).toEqual([expect.stringMatching(/^Dusk: colors\.soft #6a5f78 reads at/)]);
    loadUserThemes([]);
    expect(getThemes().problems).toEqual([]);
  });
});

describe('extension themes', () => {
  const harbour = { id: 'harbour', name: 'Harbour', tokens: { colors: { ground: '#dfe6ea', ink: '#10202b', accent: '#c2410c' } } };

  it('namespaces extension themes, refuses collisions, and disposes only its own', () => {
    const dispose = registerTheme(harbour, 'org.example');
    expect(getThemes().themes.find(theme => theme.id === 'org.example:harbour')).toMatchObject({ name: 'Harbour', owner: 'org.example', source: 'extension' });
    expect(() => registerTheme(harbour, 'org.example')).toThrow(RegistryCollision);
    expect(() => registerTheme(harbour, 'org.example')).toThrow(/The theme “org\.example:harbour” is already registered by org\.example/);
    dispose();
    const again = registerTheme({ ...harbour, name: 'Harbour 2' }, 'org.example');
    dispose();
    expect(getThemes().themes.find(theme => theme.id === 'org.example:harbour')?.name).toBe('Harbour 2');
    again(); again();
    expect(getThemes().themes.some(theme => theme.id === 'org.example:harbour')).toBe(false);
  });

  it('refuses a broken theme with every problem listed', () => {
    let thrown: unknown;
    try { registerTheme({ id: 'Bad Id', name: '', tokens: { radius: 99 } }, 'org.example'); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ThemeError);
    expect((thrown as ThemeError).problems).toEqual([
      'The id "Bad Id" isn\'t usable. Use lowercase letters, digits, dots, dashes, or underscores.',
      'The name must be text, 1 to 60 characters.',
      'radius is 99. Use a number of pixels from 0 to 16.',
    ]);
    expect(() => registerTheme(harbour, 'Not An Owner')).toThrow(/valid owner name/);
  });
});
