// The renderer side of extensions. See docs/extensions.md.
//
// Wiring: startExtensions() in main.tsx (main window only), <ExtensionNotices /> in the room,
// <ExtensionsSettings /> on the Settings page, and <ExtensionPage id /> for the route
// { view: 'extension', id }.
import './extensions.css';

export { startExtensions } from './runtime';
export { ExtensionsSettings } from './ExtensionsSettings';
export { ExtensionPage } from './pages';
export { ExtensionNotices } from './notices';
