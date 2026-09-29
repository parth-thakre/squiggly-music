// The mark on a kept song's row and a kept record's or playlist's sleeve (see kept.tsx).
// `decorative`: inside a control whose own text already says it.
export function KeptMark({ className = '', decorative = false }: { className?: string; decorative?: boolean }) {
  return <span className={`kept-mark ${className}`.trim()} {...decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': 'Kept on this device', title: 'Kept on this device' }}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
  </span>;
}
