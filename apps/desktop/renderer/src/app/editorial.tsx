import { ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { Track } from '../../../../../packages/core/contracts';
import { kHz } from './ui';

// Shared editorial helpers and primitives: the hand-drawn organic squiggle geometry (for both the
// seek bar and section divider rule), dynamic display-title sizing, inline sort dropdown, and
// liner-notes formatting.

export interface SquigglePoint { x: number; y: number; lean: number }

function stream(seed: string) {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619); }
  return () => {
    h = (h + 0x6D2B79F5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Turning points along a hand-drawn wave: loud passages swing wide and tighter, quiet ones stay
// close to the baseline. Deterministic per seed so a song or rule keeps its own shape.
export function squiggleTurns(width: number, seed: string, pace = 8.5): SquigglePoint[] {
  const w = Math.max(8, width);
  const rand = stream(seed);
  const passages = Math.max(5, Math.round(w / 30));
  const level: number[] = [];
  let quiet = rand() < 0.5;
  for (let i = 0; i <= passages; i++) {
    level.push(quiet ? 0.04 + 0.3 * rand() : 0.56 + 0.44 * rand());
    if (rand() < 0.68) quiet = !quiet;
  }
  const loud = (x: number) => {
    const p = Math.min(Math.max(x / w, 0), 1) * passages;
    const i = Math.min(Math.floor(p), passages - 1);
    const f = p - i;
    return level[i] + (level[i + 1] - level[i]) * f * f * (3 - 2 * f);
  };
  const points: SquigglePoint[] = [];
  let x = 0, side = rand() < 0.5 ? 1 : -1, wander = 0;
  while (x < w) {
    const l = loud(x);
    const swing = (0.1 + 0.9 * l) * (0.58 + 0.62 * rand()) * (side > 0 ? 1.08 : 0.92);
    wander = wander * 0.6 + (rand() - 0.5) * 0.16;
    points.push({ x, y: side * swing + wander, lean: 0.26 + 0.42 * rand() });
    x += pace * (0.58 + 0.84 * rand()) * (1.22 - 0.42 * l);
    side = -side;
  }
  points.push({ x: w, y: side * 0.15, lean: 0.45 });
  return points;
}

export function squiggleSvgPath(points: readonly SquigglePoint[], mid: number, amp: number): string {
  const n = (v: number) => +v.toFixed(2);
  let d = `M${n(points[0].x)} ${n(mid - points[0].y * amp)}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = b.x - a.x;
    d += `C${n(a.x + dx * a.lean)} ${n(mid - a.y * amp)} ${n(b.x - dx * b.lean)} ${n(mid - b.y * amp)} ${n(b.x)} ${n(mid - b.y * amp)}`;
  }
  return d;
}

// One hand-drawn section divider rule per page (between songs and credits, or between shelves).
export function SquiggleRule({ seed, width = 148, height = 14, amp = 5, pace = 9.5, className }: {
  seed: string; width?: number; height?: number; amp?: number; pace?: number; className?: string;
}) {
  const d = useMemo(() => squiggleSvgPath(squiggleTurns(width, seed, pace), height / 2, amp), [width, seed, pace, height, amp]);
  return <div className={`squiggle-break${className ? ` ${className}` : ''}`} aria-hidden="true">
    <svg className="squiggle-rule" width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path className="sq-line" d={d} />
    </svg>
  </div>;
}

// Sizes a display heading to the largest step that fits on one line (from `sizes`), or else balanced
// across up to `maxLines` lines (from `wrapped`). Runs cleanly on mount, resize, and font load.
// It is the page's <h1> unless `level` says otherwise: Home and Queue lead with a record or a song,
// under a hidden <h1> that names the place.
export function FitTitle({ children, className, sizes = [110, 96, 84, 72], wrapped = [84, 72, 64, 56, 48, 40], maxLines = 2, maxHeightOf, title, level = 1 }: {
  children: ReactNode;
  level?: 1 | 2;
  className?: string;
  sizes?: readonly number[];
  wrapped?: readonly number[];
  maxLines?: number;
  // Optional element whose height the title's container should stay within when a size allows it.
  maxHeightOf?: () => { box: HTMLElement | null; limit: HTMLElement | null };
  title?: string;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  const latest = useRef({ sizes, wrapped, maxHeightOf });
  latest.current = { sizes, wrapped, maxHeightOf };
  const sizeKey = sizes.join(',');
  const wrappedKey = wrapped.join(',');
  const textKey = title ?? (typeof children === 'string' || typeof children === 'number' ? String(children) : '');
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    let lastWidth = -1, lastLimit = -1;
    const fit = (force = false) => {
      // On narrow phones let the responsive CSS handle sizing.
      if (typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches) {
        node.style.fontSize = '';
        node.style.whiteSpace = '';
        lastWidth = -1; lastLimit = -1;
        return;
      }
      const { sizes: oneLine, wrapped: multiLine, maxHeightOf: heightOf } = latest.current;
      const bounds = heightOf?.();
      const limitHeight = bounds?.limit?.offsetHeight ?? -1;
      const width = (node.parentElement ?? node).clientWidth;
      if (!force && width === lastWidth && limitHeight === lastLimit) return;
      lastWidth = width; lastLimit = limitHeight;
      const box = bounds?.box ?? null;
      const fitsHeight = () => !box || limitHeight < 0 || box.offsetHeight <= limitHeight + 2;
      // Measure the line-height ratio once instead of calling getComputedStyle on every step.
      const computed = getComputedStyle(node);
      const baseFont = parseFloat(computed.fontSize) || 1;
      const lhRatio = (parseFloat(computed.lineHeight) || baseFont) / baseFont;
      const tryOne = (checkHeight: boolean) => {
        node.style.whiteSpace = 'nowrap';
        for (const px of oneLine) {
          node.style.fontSize = `${px}px`;
          if (node.scrollWidth <= node.clientWidth + 1 && (!checkHeight || fitsHeight())) return true;
        }
        node.style.whiteSpace = '';
        for (let lines = 2; lines <= maxLines; lines++) {
          for (const px of multiLine) {
            node.style.fontSize = `${px}px`;
            const lh = px * lhRatio;
            if (node.scrollWidth <= node.clientWidth + 1 && node.offsetHeight <= lh * lines + 3 && (!checkHeight || fitsHeight())) return true;
          }
        }
        return false;
      };
      if (!tryOne(true) && heightOf) tryOne(false);
    };
    fit(true);
    const observer = new ResizeObserver(() => fit(false));
    observer.observe(node.parentElement ?? node);
    let live = true;
    document.fonts?.ready.then(() => { if (live) fit(true); }, () => undefined);
    return () => { live = false; observer.disconnect(); };
  }, [textKey, sizeKey, wrappedKey, maxLines]);
  const Heading = level === 1 ? 'h1' : 'h2';
  return <Heading ref={ref} className={`display${className ? ` ${className}` : ''}`} title={title}>{children}</Heading>;
}

// Inline sort/order dropdown ("newest first v", "A to Z v"). Opens a clean menu anchored below the
// trigger, keeping the page free of seven competing sort pills.
export interface OrderOption<T extends string> { value: T; label: string; triggerLabel?: string }
// `value` is null when the list is in an order the menu doesn't offer (Records by decade, which
// lists by year); the trigger then says `otherwise` and no option is checked.
export function OrderMenu<T extends string>({ value, options, onSelect, ariaLabel, className, extra, otherwise }: {
  value: T | null;
  otherwise?: string;
  options: readonly OrderOption<T>[];
  onSelect(value: T): void;
  ariaLabel: string;
  className?: string;
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);
  const close = (refocus: boolean) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    // Focus goes to the order in use, as a menu's would.
    (popover.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? popover.current?.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus();
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(true); } };
    addEventListener('pointerdown', onPointer, true);
    addEventListener('keydown', onKey, true);
    return () => { removeEventListener('pointerdown', onPointer, true); removeEventListener('keydown', onKey, true); };
  }, [open]);
  // Up and Down step through the orders, Home and End go to either end, and Tab leaves the menu.
  const step = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to = event.key === 'ArrowDown' ? (at + 1) % items.length : event.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
    if (event.key === 'Tab') { setOpen(false); return; }
    if (to === null || !items.length) return;
    event.preventDefault();
    items[to].focus();
  };
  const shown = current ? current.triggerLabel ?? current.label : otherwise ?? options[0].label;
  return <span ref={root} className={`order-menu${className ? ` ${className}` : ''}`}>
    {/* Named by what it shows, so the words on screen are the words to say to it. */}
    <button ref={trigger} type="button" className="order-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`${ariaLabel}: ${shown}`}
      onClick={() => setOpen(v => !v)}>
      <span>{shown}</span>
      <ChevronDown className="order-chevron" aria-hidden="true" />
    </button>
    {open && <div ref={popover} className="order-popover" role="menu" aria-label={ariaLabel} onKeyDown={step}>
      {options.map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={option.value === value} tabIndex={-1}
        className={`order-option${option.value === value ? ' active' : ''}`}
        onClick={() => { close(true); onSelect(option.value); }}>{option.label}</button>)}
      {extra}
    </div>}
  </span>;
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  const mb = n / 1e6;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

// Honest file spec from Navidrome's reported metadata. Unknown stays unknown.
export function formatTrackSpec(track: Pick<Track, 'sourceFormat' | 'sourceBitDepth' | 'sourceSampleRate'>): string {
  return [
    track.sourceFormat?.toUpperCase(),
    track.sourceBitDepth ? `${track.sourceBitDepth}-bit` : null,
    kHz(track.sourceSampleRate),
  ].filter(Boolean).join(', ');
}

// Initial index letter for the Tracks book-index: figures file under "#" so a serif "1" isn't read as "I".
export function trackInitial(text: string): string {
  const first = Array.from(text.replace(/^[^\p{L}\p{N}]+/u, ''))[0] || '';
  if (!first) return '#';
  if (/\p{N}/u.test(first)) return '#';
  const plain = first.normalize('NFD')[0];
  return (/\p{Script=Latin}/u.test(plain) ? plain : first).toLocaleUpperCase('en');
}
