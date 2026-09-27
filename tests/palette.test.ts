import { describe, expect, it } from 'vitest';
import { blend, contrast, MARK_CONTRAST, neutral, paletteFromPixels, selectedTint, TEXT_CONTRAST, type Palette } from '../apps/desktop/renderer/src/app/palette';

// A 48 x 48 sleeve, as paletteFromImage samples it, filled with the given colors in bands.
function sleeve(...colors: [number, number, number][]) {
  const data = new Uint8ClampedArray(48 * 48 * 4);
  for (let pixel = 0; pixel < 48 * 48; pixel++) {
    const [r, g, b] = colors[Math.floor(pixel / (48 * 48) * colors.length)];
    data.set([r, g, b, 255], pixel * 4);
  }
  return data;
}

function expectReadable(palette: Palette) {
  const grounds = [palette.ground, selectedTint(palette)];
  for (const ground of grounds) {
    expect(contrast(palette.ink, ground), `ink on ${ground}`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrast(palette.soft, ground), `soft on ${ground}`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrast(palette.accentText ?? palette.accent, ground), `accent text on ${ground}`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrast(palette.accent, ground), `accent on ${ground}`).toBeGreaterThanOrEqual(MARK_CONTRAST);
  }
}

describe('palette contrast', () => {
  it('measures contrast and compositing like the browser', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBe(1);
    expect(blend('#000000', '#ffffff', .5)).toBe('#808080');
    expect(blend('#123456', '#123456', .16)).toBe('#123456');
  });

  it.each([
    ['red', [255, 0, 0]], ['green', [0, 255, 0]], ['blue', [0, 0, 255]],
    ['black', [0, 0, 0]], ['white', [255, 255, 255]], ['grey', [128, 128, 128]],
    ['light grey', [200, 200, 200]], ['dark grey', [60, 60, 60]], ['yellow', [255, 230, 0]],
  ] as [string, [number, number, number]][])('keeps text readable on a solid %s sleeve, selected rows included', (_, color) => {
    const palette = paletteFromPixels(sleeve(color));
    expect(palette.accentText).toBeDefined();
    expectReadable(palette);
  });

  it.each([
    ['red on white', [[255, 255, 255], [255, 255, 255], [220, 20, 30]]],
    ['yellow on navy', [[20, 30, 90], [20, 30, 90], [250, 210, 30]]],
    ['green on black', [[0, 0, 0], [0, 0, 0], [30, 200, 60]]],
    ['blue on grey', [[128, 128, 128], [128, 128, 128], [40, 90, 230]]],
  ] as [string, [number, number, number][]][])('keeps a vivid accent readable as text: %s', (_, colors) => {
    const palette = paletteFromPixels(sleeve(...colors));
    expect(palette.accent).not.toBe(palette.ink);
    expectReadable(palette);
  });

  it('meets the same rules with the neutral palette used before any art loads', () => {
    expectReadable(neutral);
  });
});
