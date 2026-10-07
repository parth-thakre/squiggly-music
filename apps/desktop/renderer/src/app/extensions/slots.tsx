import { Component, createElement, useId, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react';
import type { Track } from '../../../../../../packages/core/contracts';
import { registry, type DeckPlacement, type Section } from '../registry';
import { openExtensionPage, reportExtensionError, useExtensionPages } from './pages';
import { useExtensionList } from './runtime';

// Where extensions show up outside their own pages: slots in the deck (ctx.deck.register), and
// sections on the Playlists page (ctx.navigation.registerSection), with every extension page
// listed under them. The deck (App.tsx) and the mini player (Mini.tsx) render <DeckSlots />;
// the Playlists page renders <ExtensionSections />.

const useDeckSlots = () => useSyncExternalStore(registry.deck.subscribe, registry.deck.all);
const useSections = () => useSyncExternalStore(registry.sections.subscribe, registry.sections.all);

// One slot's failure hides that slot, or puts a line in the section's place, and is reported in
// Settings › Extensions. The rest of the deck carries on.
class SlotBoundary extends Component<{ owner: string; what: string; fallback?(error: string): ReactNode; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) }; }
  componentDidCatch(error: unknown, _info: ErrorInfo) {
    reportExtensionError(this.props.owner, `${this.props.what} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  render() {
    if (this.state.error !== null) return this.props.fallback?.(this.state.error) ?? null;
    return this.props.children;
  }
}
export { SlotBoundary as ExtensionSlotBoundary };

// Every slot at one placement. The CSS bounds each box: one line for the quiet line, a few
// lines' height for the others, with anything beyond hidden. Keyed by registration, so a
// reloaded extension's slot starts fresh.
export function DeckSlots({ placement, track }: { placement: DeckPlacement; track: Track | null | undefined }) {
  const slots = useDeckSlots();
  if (!track) return null;
  const here = slots.filter(slot => slot.placement === placement);
  if (!here.length) return null;
  return <>{here.map(slot => <div key={slot.serial} className={`deck-slot ${placement}`} data-slot={slot.id}>
    <SlotBoundary owner={slot.owner ?? 'builtin'} what={`The deck slot “${slot.id}”`}>{createElement(slot.component, { track })}</SlotBoundary>
  </div>)}</>;
}

function ExtensionSection({ section }: { section: Section }) {
  const heading = useId();
  return <section className="shelf-section extension-section" aria-labelledby={heading} data-section={section.id}>
    <h2 id={heading}>{section.title}</h2>
    <SlotBoundary owner={section.owner ?? 'builtin'} what={`The section “${section.title}”`}
      fallback={error => <p className="note" role="alert">This section stopped working: {error}</p>}>
      {createElement(section.component)}
    </SlotBoundary>
  </section>;
}

// Sections extensions add, then their pages, so a page is reachable without Settings.
export function ExtensionSections() {
  const sections = useSections();
  const pages = useExtensionPages();
  const names = new Map(useExtensionList().map(info => [info.id, info.name]));
  return <>
    {sections.map(section => <ExtensionSection key={section.serial} section={section} />)}
    {pages.length > 0 && <section className="shelf-section" aria-labelledby="extension-pages">
      <h2 id="extension-pages">Extensions</h2>
      <p className="section-note">Pages that extensions add.</p>
      <ul className="rows extension-pages">
        {pages.map(page => <li key={page.id}>
          <button type="button" onClick={() => openExtensionPage(page.id)}>
            <span className="row-text"><span className="row-name">{page.title}</span><span className="row-sub">From {names.get(page.owner) ?? page.owner}</span></span>
          </button>
        </li>)}
      </ul>
    </section>}
  </>;
}
