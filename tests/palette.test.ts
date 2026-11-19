import { describe, expect, it } from 'vitest';
import { blend, contrast, isStandIn, LINE_ALPHA, MARK_CONTRAST, neutral, paletteFromPixels, selectedTint, TEXT_CONTRAST, type Palette } from '../apps/desktop/renderer/src/app/palette';

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
  if (palette.deck) grounds.push(palette.deck, blend(palette.deck, palette.ink, LINE_ALPHA));
  for (const ground of grounds) {
    expect(contrast(palette.ink, ground), `ink on ${ground}`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrast(palette.soft, ground), `soft on ${ground}`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrast(palette.accentText ?? palette.accent, ground), `accent text on ${ground}`).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    expect(contrast(palette.accent, ground), `accent on ${ground}`).toBeGreaterThanOrEqual(MARK_CONTRAST);
  }
}

// The hue of a #rrggbb colour, in degrees.
function hueOf(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe('the room follows the colour you see', () => {
  it('a yellow sleeve with a large purple-black shadow gets a yellow room, not a purple one', () => {
    const palette = paletteFromPixels(sleeve([43, 31, 48], [43, 31, 48], [43, 31, 48], [230, 190, 40], [230, 190, 40]));
    const hue = hueOf(palette.ground);
    expect(hue, `ground ${palette.ground}`).toBeGreaterThan(30);
    expect(hue, `ground ${palette.ground}`).toBeLessThan(65);
    // The accent is still the sleeve's yellow.
    expect(hueOf(palette.accent), `accent ${palette.accent}`).toBeGreaterThan(30);
    expect(hueOf(palette.accent), `accent ${palette.accent}`).toBeLessThan(65);
    expectReadable(palette);
  });

  it('a sleeve whose largest patch already shares its vivid hue keeps that patch\'s hue', () => {
    const palette = paletteFromPixels(sleeve([20, 26, 46], [20, 26, 46], [20, 26, 46], [60, 90, 200]));
    const hue = hueOf(palette.ground);
    expect(hue, `ground ${palette.ground}`).toBeGreaterThan(200);
    expect(hue, `ground ${palette.ground}`).toBeLessThan(240);
  });
});

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
    expect(neutral.deck).toBeDefined();
    expect(neutral.neutralAccent).toBe(true);
    expectReadable(neutral);
  });

  it('opens light sleeves into tinted light rooms with a deeper deck and dark ink', () => {
    const lightWarm = paletteFromPixels(sleeve([235, 224, 198], [235, 224, 198], [235, 224, 198], [190, 90, 45]));
    expect(lightWarm.scheme).toBe('light');
    expect(lightWarm.deck).toBeDefined();
    expect(contrast('#000000', lightWarm.ground)).toBeGreaterThan(contrast('#ffffff', lightWarm.ground));
    expect(contrast('#000000', lightWarm.deck!)).toBeGreaterThan(contrast('#ffffff', lightWarm.deck!));
    // Deck sits deeper than ground in a light room.
    expect(contrast('#ffffff', lightWarm.deck!)).toBeGreaterThan(contrast('#ffffff', lightWarm.ground));
    expectReadable(lightWarm);

    const lightNeutral = paletteFromPixels(sleeve([240, 240, 240]));
    expect(lightNeutral.scheme).toBe('light');
    expect(lightNeutral.neutralAccent).toBe(true);
    expectReadable(lightNeutral);
  });

  it('adopts a secondary vivid hue for the deck when the sleeve carries two colour families', () => {
    // 75% deep teal + 25% vivid burnt orange: ground stays teal, deck adopts warm orange-brown hue.
    const twoTone = paletteFromPixels(sleeve([18, 86, 98], [18, 86, 98], [18, 86, 98], [218, 96, 32]));
    expect(twoTone.scheme).toBe('dark');
    expect(twoTone.deck).toBeDefined();
    expect(twoTone.neutralAccent).toBe(false);
    const groundHue = hueOf(twoTone.ground);
    const deckHue = hueOf(twoTone.deck!);
    const gap = Math.min(Math.abs(groundHue - deckHue), 360 - Math.abs(groundHue - deckHue));
    expect(gap, `ground ${twoTone.ground} (${groundHue.toFixed(1)}°) vs deck ${twoTone.deck} (${deckHue.toFixed(1)}°)`).toBeGreaterThan(45);
    expectReadable(twoTone);
  });

  it('marks neutralAccent on grey and monochrome sleeves and clears it on vivid sleeves', () => {
    for (const color of [[0, 0, 0], [60, 60, 60], [128, 128, 128], [200, 200, 200], [255, 255, 255]] as [number, number, number][]) {
      const palette = paletteFromPixels(sleeve(color));
      expect(palette.neutralAccent, `grey ${color.join(',')}`).toBe(true);
      expect(palette.accent).toBe(palette.ink);
      expect(palette.accentText).toBe(palette.ink);
      expectReadable(palette);
    }
    const vivid = paletteFromPixels(sleeve([30, 30, 30], [30, 30, 30], [220, 40, 60]));
    expect(vivid.neutralAccent).toBe(false);
    expect(vivid.accent).not.toBe(vivid.ink);
    expectReadable(vivid);
  });
});

describe('a server\'s stock picture of an artist', () => {
  const pixels = (colours: [number, number, number][]) => colours.flatMap(([r, g, b]) => [r, g, b, 255]);
  const fill = (count: number, colour: [number, number, number]) => Array.from({ length: count }, () => colour);
  it('is a grey figure on flat grey: no colour, two tones', () => {
    expect(isStandIn(pixels([...fill(800, [222, 222, 222]), ...fill(200, [196, 196, 196]), ...fill(24, [209, 209, 209])]))).toBe(true);
  });
  it('is not a black-and-white photograph, whose greys run the whole range', () => {
    expect(isStandIn(pixels(Array.from({ length: 1024 }, (_, i) => { const v = (i * 37) % 256; return [v, v, v] as [number, number, number]; })))).toBe(false);
  });
  it('is not a black-and-white logo, whose two tones are far apart, nor a dark two-tone picture', () => {
    expect(isStandIn(pixels([...fill(700, [255, 255, 255]), ...fill(324, [0, 0, 0])]))).toBe(false);
    expect(isStandIn(pixels([...fill(700, [40, 40, 40]), ...fill(324, [70, 70, 70])]))).toBe(false);
  });
  it('is not a flat picture in colour, nor an empty one', () => {
    expect(isStandIn(pixels([...fill(900, [230, 60, 60]), ...fill(124, [200, 40, 40])]))).toBe(false);
    expect(isStandIn([])).toBe(false);
  });
});
