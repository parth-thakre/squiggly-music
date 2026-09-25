import { Component, createElement, useSyncExternalStore, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { RegistryCollision } from '../registry';
import { nav } from '../route';

// Pages extensions add, shown at the route { view: 'extension', id: 'owner:page' }. The id
// rules follow registry.ts: namespaced by owner, collisions refused, disposers idempotent.

export interface PageContribution {
  id: string;
  title: string;
  // Rendered with the app's own React. Import React from "react" as usual; the app supplies it.
  component: ComponentType;
}
export interface ExtensionPageEntry { id: string; owner: string; title: string; component: ComponentType; serial: number }

const pages = new Map<string, ExtensionPageEntry>();
let list: ExtensionPageEntry[] = [];
const listeners = new Set<() => void>();
const emit = () => { list = [...pages.values()]; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

const ID = /^[a-z0-9][a-z0-9._-]*$/;
let serial = 0;
export function addPage(owner: string, page: PageContribution): { id: string; dispose: () => void } {
  if (!page || typeof page.id !== 'string' || !ID.test(page.id)) throw new Error(`The page id ${JSON.stringify(page?.id)} isn't usable. Use lowercase letters, digits, dots, dashes, or underscores.`);
  if (typeof page.component !== 'function' && typeof page.component !== 'object') throw new Error(`The page “${page.id}” needs a React component.`);
  const entry: ExtensionPageEntry = { id: `${owner}:${page.id}`, owner, title: String(page.title || page.id).slice(0, 80), component: page.component, serial: ++serial };
  const live = pages.get(entry.id);
  if (live) throw new RegistryCollision('page', entry.id, live.owner);
  pages.set(entry.id, entry);
  emit();
  return { id: entry.id, dispose: () => { if (pages.get(entry.id) === entry) { pages.delete(entry.id); emit(); } } };
}

export const getExtensionPages = () => list;
export const openExtensionPage = (id: string) => nav.go({ view: 'extension', id });
// For a sidebar or a menu of extension pages.
export const useExtensionPages = () => useSyncExternalStore(subscribe, () => list);

// A page that throws while rendering shows a message (and is reported on the Extensions page)
// instead of taking the window down.
class Boundary extends Component<{ owner: string; title: string; onError(owner: string, message: string): void; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) }; }
  componentDidCatch(error: unknown, _info: ErrorInfo) {
    this.props.onError(this.props.owner, `The page “${this.props.title}” failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  render() {
    if (this.state.error) return <section className="extension-page"><h1>{this.props.title}</h1>
      <p className="note" role="alert">This page stopped working: {this.state.error}</p>
      <p className="note">Fix the extension and save; it reloads by itself.</p>
    </section>;
    return this.props.children;
  }
}

let reportPageError: (owner: string, message: string) => void = () => {};
export const onPageError = (report: typeof reportPageError) => { reportPageError = report; };

export function ExtensionPage({ id }: { id: string }) {
  const page = useSyncExternalStore(subscribe, () => pages.get(id));
  if (!page) return <section className="extension-page"><h1>Page not available</h1>
    <p className="status">The extension that adds this page isn't loaded. It may be turned off, or still starting.</p>
  </section>;
  // Keyed by the entry, so a reloaded extension starts its page fresh.
  return <Boundary key={page.serial} owner={page.owner} title={page.title} onError={(owner, message) => reportPageError(owner, message)}>
    <div className="extension-page">{createElement(page.component)}</div>
  </Boundary>;
}
