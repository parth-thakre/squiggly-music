import { albumDetail, loadKept } from './library';

// Reaching for a link (pressing it, or resting the pointer on it a moment) asks for what the page
// it opens shows, so by the click the page usually opens whole. Links say what they open with
// data-warm: "artist:<id>" or "album:<id>". The requests are the pages' own, under the same keys.

export function warmArtist(id: string, full = false) {
  void loadKept(`artist:${id}`, from => from.artist(id));
  // artistInfo hits external metadata agents (Last.fm/Deezer) on Navidrome; only warm it on
  // actual press intent, never on passive hover.
  if (full) void loadKept(`artistInfo:${id}`, from => from.artistInfo(id));
}
export const warmAlbum = (id: string) => void albumDetail(id);

const REST_MS = 250;
function warmFrom(target: EventTarget | null, full: boolean) {
  const link = target instanceof Element ? target.closest<HTMLElement>('[data-warm]') : null;
  const [kind, ...rest] = link?.dataset.warm?.split(':') ?? [];
  const id = rest.join(':');
  if (!id) return;
  if (kind === 'artist') warmArtist(id, full);
  else if (kind === 'album') warmAlbum(id);
}
let started = false;
export function startWarming() {
  if (started) return;
  started = true;
  let resting: ReturnType<typeof setTimeout> | undefined;
  // A mouse passing over on its way elsewhere, or focus passing through a list, asks for nothing.
  const rest = (target: EventTarget | null) => { clearTimeout(resting); resting = setTimeout(() => warmFrom(target, false), REST_MS); };
  addEventListener('pointerdown', event => warmFrom(event.target, true), { capture: true, passive: true });
  addEventListener('pointerover', event => { if (event.pointerType === 'mouse') rest(event.target); else clearTimeout(resting); }, { passive: true });
  addEventListener('focusin', event => rest(event.target));
}
