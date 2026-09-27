// Filtering the palette's few dozen commands. The query, ignoring case, must appear in the
// title, or failing that in the category. Titles that start with it come first, then titles
// where it starts a word, then the rest by where it appears. Ties go to the most recently used
// command, then to registration order.
export interface Filterable { id: string; title: string; category?: string }

function place(text: string, query: string): { tier: number; at: number } | null {
  let first = -1;
  for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + 1)) {
    if (at === 0) return { tier: 0, at };
    if (/[\s\-–:,.(]/.test(text[at - 1])) return { tier: 1, at };
    if (first < 0) first = at;
  }
  return first < 0 ? null : { tier: 2, at: first };
}

export function filterCommands<T extends Filterable>(query: string, commands: readonly T[], recent: readonly string[] = []): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  const seen = (id: string) => { const at = recent.indexOf(id); return at < 0 ? Infinity : at; };
  return commands.flatMap((command, order) => {
    const found = place(command.title.toLowerCase(), q) ?? (command.category?.toLowerCase().includes(q) ? { tier: 3, at: 0 } : null);
    return found ? [{ command, ...found, recent: seen(command.id), order }] : [];
  }).sort((a, b) => a.tier - b.tier || a.at - b.at || a.recent - b.recent || a.order - b.order).map(match => match.command);
}
