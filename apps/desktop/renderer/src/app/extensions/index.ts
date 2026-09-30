// The renderer side of extensions. See docs/extensions.md.
//
// Wiring: startExtensions() in main.tsx (both windows), <ExtensionNotices /> in the room and the
// mini player, <ExtensionsSettings /> on the Settings page, <ExtensionPage id /> for the route
// { view: 'extension', id }, <DeckSlots /> in the deck and the mini player, and
// <ExtensionSections /> on the Playlists page.
import './extensions.css';

export { startExtensions } from './runtime';
export { ExtensionsSettings } from './ExtensionsSettings';
export { ExtensionPage } from './pages';
export { ExtensionNotices } from './notices';
export { DeckSlots, ExtensionSections } from './slots';
