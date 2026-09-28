import { Squiggly, type Posture } from './plugin';

// The phone around the page: the status bar, and the Flip's Flex Mode.

// The page sets <meta name="theme-color"> to the room's ground colour (App.tsx). The window
// behind the page takes that colour too, and the status bar's icons go light on a dark room
// and dark on a light one.
export function followRoomColour() {
  const meta = document.querySelector('meta[name="theme-color"]');
  const probe = document.createElement('canvas').getContext('2d');
  if (!meta || !probe) return;
  let last: string | null = null;
  const apply = () => {
    const colour = hexOf(meta.getAttribute('content') ?? '', probe);
    if (!colour || colour === last) return;
    last = colour;
    void Squiggly.setWindowColour({ colour, dark: dark(colour) }).catch(() => undefined);
  };
  new MutationObserver(apply).observe(meta, { attributes: true, attributeFilter: ['content'] });
  apply();
}

// Any CSS colour as #rrggbb; a canvas normalises it.
function hexOf(colour: string, probe: CanvasRenderingContext2D): string | null {
  probe.fillStyle = '#000000';
  probe.fillStyle = colour;
  return /^#[0-9a-f]{6}$/i.test(probe.fillStyle) ? probe.fillStyle : null;
}

/** Whether light text reads better than dark on this #rrggbb colour (relative luminance under 0.179). */
export function dark(hex: string): boolean {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.179;
}

// Half-folded, the Flip's screen is two halves. Chrome tells pages through viewport segments,
// which the phone layout already uses; the WebView doesn't, so the native side reports the
// hinge and posture.css lays the now-playing sheet out from these variables instead.
export function followPosture() {
  const root = document.documentElement;
  const apply = ({ posture, top, bottom }: Posture) => {
    if (posture === 'flex' && top > 0 && bottom > 0) {
      root.dataset.posture = 'flex';
      root.style.setProperty('--fold-top', `${top}px`);
      root.style.setProperty('--fold-bottom', `${bottom}px`);
    } else {
      delete root.dataset.posture;
      root.style.removeProperty('--fold-top');
      root.style.removeProperty('--fold-bottom');
    }
  };
  void Squiggly.addListener('posture', apply);
  void Squiggly.posture().then(apply, () => undefined);
}
