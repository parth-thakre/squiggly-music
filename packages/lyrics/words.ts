import type { LyricLine, LyricWord, Lyrics } from '../core/contracts';

// Word timing shared by every source, so the desktop and the browser light the same words at
// the same moments. Exact times (OpenSubsonic cues, enhanced LRC) are kept; lines without them
// are spread across their words by length.

export type LyricLines = Pick<Lyrics, 'synced' | 'lines'>;

// An estimated line is sung within this long at most, however far away the next line is.
export const MAX_LINE_SECONDS = 8;
// ...and at most this long per letter, so a short line before a long break doesn't crawl.
export const SECONDS_PER_LETTER = .35;
// Short lines still get this long.
export const MIN_LINE_SECONDS = 1.5;
// The line finishes a little before the next one starts: a tenth of the time to it, at most this.
export const MAX_GAP_SECONDS = .5;
// Lines longer than this are left as one word; nothing sung is that long.
const MAX_WORDS = 500;

export const round = (seconds: number) => Math.max(0, Math.round(seconds * 1000) / 1000);

const segmenter = (granularity: 'word' | 'grapheme') => typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity }) : null;
const words = segmenter('word'), graphemes = segmenter('grapheme');
// Scripts written without spaces between words.
const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const letter = /[\p{L}\p{N}]/u;

// Moves whitespace at the start of each piece onto the end of the piece before it, and drops
// pieces left empty. The joined text never changes.
export function attachSpaces<T extends { text: string }>(pieces: T[]): T[] {
  const out: T[] = [];
  for (const piece of pieces) {
    const lead = /^\s+/.exec(piece.text)?.[0] ?? '';
    const previous = out[out.length - 1];
    if (lead && previous) { previous.text += lead; piece.text = piece.text.slice(lead.length); }
    if (piece.text) out.push(piece);
  }
  return out;
}

// The words of a line, each with the space after it. Joined, they are the text again.
export function splitWords(text: string): string[] {
  const tokens = text.match(/\s*\S+\s*/g) ?? [];
  if (!tokens.length) return [];
  const out: string[] = [];
  for (const token of tokens) {
    if (!words || !unspaced.test(token)) { out.push(token); continue; }
    // Chinese, Japanese, Thai and the like: split the run into words, keeping punctuation and
    // spaces with the word before (or, at the very start, with the word after).
    let pending = '';
    for (const part of words.segment(token)) {
      if (part.isWordLike) { out.push(pending + part.segment); pending = ''; }
      else if (out.length) out[out.length - 1] += part.segment;
      else pending += part.segment;
    }
    if (pending) out.push(pending);
  }
  return out.length > MAX_WORDS ? [text] : out;
}

// How much singing a word holds: its letters and digits, counted as the reader sees them
// (a Devanagari syllable with its vowel sign is one), and at least one.
export function weightOf(word: string): number {
  let count = 0;
  if (graphemes) { for (const { segment } of graphemes.segment(word)) if (letter.test(segment)) count++; }
  else for (const char of word) if (letter.test(char)) count++;
  return Math.max(1, count);
}

// How long an estimated line is sung: until shortly before the next line, within the caps above.
export function lineSpan(start: number, nextStart: number | null, letters: number): number {
  const available = nextStart === null ? MAX_LINE_SECONDS : Math.max(0, nextStart - start);
  const gap = nextStart === null ? 0 : Math.min(MAX_GAP_SECONDS, available * .1);
  return Math.max(0, Math.min(available - gap, MAX_LINE_SECONDS, Math.max(MIN_LINE_SECONDS, letters * SECONDS_PER_LETTER)));
}

// Spreads the line from start to end across its words, in proportion to their weight.
export function estimateWords(text: string, start: number, end: number): LyricWord[] {
  const pieces = splitWords(text);
  const weights = pieces.map(weightOf);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let before = 0;
  return pieces.map((piece, i) => {
    const from = start + (end - start) * before / total;
    before += weights[i];
    return { start: round(from), end: round(start + (end - start) * before / total), text: piece };
  });
}

// Completes synced lyrics: lines without word times get estimated ones, and every sung line gets
// an end. Unsynced lyrics come back without words. Lines must be in time order.
export function timeWords(lyrics: LyricLines): LyricLines & Pick<Lyrics, 'wordTiming'> {
  if (!lyrics.synced) return { synced: false, lines: lyrics.lines.map(line => ({ start: null, text: line.text })), wordTiming: null };
  let exact = 0, estimated = 0;
  const lines = lyrics.lines.map((line, i): LyricLine => {
    const start = line.start ?? 0;
    if (!line.text.trim()) return { start, text: line.text };
    if (line.words?.length) {
      exact++;
      return { start, end: line.end ?? Math.max(...line.words.map(word => word.end)), text: line.text, words: line.words };
    }
    estimated++;
    // The next line that starts later: lines sharing a stamp (a chorus and its echo) sing together.
    let next: number | null = null;
    for (let k = i + 1; k < lyrics.lines.length; k++) {
      const at = lyrics.lines[k].start;
      if (at !== null && at > start) { next = at; break; }
    }
    const end = line.end != null && line.end > start ? line.end
      : round(start + lineSpan(start, next, splitWords(line.text).reduce((sum, word) => sum + weightOf(word), 0)));
    return { start, end, text: line.text, words: estimateWords(line.text, start, end) };
  });
  return { synced: true, lines, wordTiming: estimated ? 'estimated' : exact ? 'exact' : null };
}
