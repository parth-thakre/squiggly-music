import { describe, expect, it } from 'vitest';
import { cueWords, structuredLyrics } from '../packages/adapter-opensubsonic/lyrics';
import { parseLrc } from '../packages/lyrics/lrclib';
import { MAX_LINE_SECONDS, estimateWords, lineSpan, splitWords, timeWords, weightOf } from '../packages/lyrics/words';

const joined = (words: { text: string }[] | undefined) => (words ?? []).map(word => word.text).join('');
// Inclusive UTF-8 byte range of `part` (the nth occurrence) inside `value`, counted independently with Buffer.
function bytes(value: string, part: string, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = value.indexOf(part, at + 1);
  const byteStart = Buffer.byteLength(value.slice(0, at));
  return { byteStart, byteEnd: byteStart + Buffer.byteLength(part) - 1 };
}

describe('word estimates', () => {
  it('splits words with the space after each, and joins back to the text', () => {
    expect(splitWords('Hello,  big world ')).toEqual(['Hello,  ', 'big ', 'world ']);
    for (const text of ['तुम ही हो', 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਜੀ', 'Fire 🔥🔥 fire', '夜空に光る星', '  lead']) expect(splitWords(text).join('')).toBe(text);
    // Scripts without spaces are split into words too.
    expect(splitWords('夜空に光る星').length).toBeGreaterThan(1);
  });
  it('weighs words by the letters a reader sees', () => {
    expect([weightOf('I '), weightOf('love, '), weightOf('you!')]).toEqual([1, 4, 3]);
    // A Devanagari consonant with its vowel sign is one letter; emoji and punctuation weigh the minimum.
    expect([weightOf('तुम '), weightOf('ही '), weightOf('हो')]).toEqual([2, 1, 1]);
    expect([weightOf('🔥🔥 '), weightOf('— ')]).toEqual([1, 1]);
  });
  it('spreads a line to shortly before the next, within the caps', () => {
    // A tenth of the time to the next line is left free, at most half a second.
    expect(lineSpan(10, 13, 30)).toBeCloseTo(2.7);
    expect(lineSpan(10, 11, 30)).toBeCloseTo(.9);
    // Never more than 8 s, even before a long break or on the last line.
    expect(lineSpan(10, 70, 40)).toBe(MAX_LINE_SECONDS);
    expect(lineSpan(10, null, 40)).toBe(MAX_LINE_SECONDS);
    // At most .35 s a letter, but at least 1.5 s.
    expect(lineSpan(0, 60, 10)).toBeCloseTo(3.5);
    expect(lineSpan(0, 60, 2)).toBe(1.5);
    expect(lineSpan(5, 5, 10)).toBe(0);
  });
  it('gives each word a share of the line by weight', () => {
    expect(estimateWords('So very long', 0, 3.5)).toEqual([
      { start: 0, end: .7, text: 'So ' }, { start: .7, end: 2.1, text: 'very ' }, { start: 2.1, end: 3.5, text: 'long' },
    ]);
    const hindi = estimateWords('तुम ही हो', 10, 12);
    expect(hindi.map(word => [word.start, word.end])).toEqual([[10, 11], [11, 11.5], [11.5, 12]]);
  });
  it('completes synced lyrics: estimates, ends, blank lines and lines sharing a stamp', () => {
    const timed = timeWords({ synced: true, lines: [
      { start: 1, text: 'So very long' }, { start: 1, text: 'Echo' }, { start: 20, text: '' }, { start: 21, text: 'The last line of this song goes on a while' },
    ] });
    expect(timed.wordTiming).toBe('estimated');
    // Both lines at 1 s run toward the next later line (20 s), under the letter cap.
    expect(timed.lines[0]).toMatchObject({ start: 1, end: 4.5 });
    expect(timed.lines[1]).toMatchObject({ start: 1, end: 2.5, words: [{ start: 1, end: 2.5, text: 'Echo' }] });
    expect(timed.lines[2]).toEqual({ start: 20, text: '' });
    expect(timed.lines[3].end).toBe(21 + MAX_LINE_SECONDS);
    for (const line of timed.lines) if (line.text) expect(joined(line.words)).toBe(line.text);
  });
  it('keeps exact words, reports mixed lyrics as estimated, and leaves unsynced lyrics without words', () => {
    const exact = { start: 1, text: 'Hi you', words: [{ start: 1, end: 1.2, text: 'Hi ' }, { start: 1.6, end: 2, text: 'you' }] };
    expect(timeWords({ synced: true, lines: [exact] })).toEqual({ synced: true, wordTiming: 'exact', lines: [{ ...exact, end: 2 }] });
    expect(timeWords({ synced: true, lines: [exact, { start: 3, text: 'Then this' }] }).wordTiming).toBe('estimated');
    expect(timeWords({ synced: false, lines: [{ start: null, text: 'Plain' }] })).toEqual({ synced: false, wordTiming: null, lines: [{ start: null, text: 'Plain' }] });
  });
});

describe('enhanced LRC', () => {
  it('reads word stamps, a closing stamp and spaces on either side of a stamp', () => {
    expect(parseLrc('[00:12.00]<00:12.00>Hello <00:12.40> world<00:12.90>\n[00:14.00]Next')).toEqual({ synced: true, lines: [
      { start: 12, text: 'Hello world', words: [{ start: 12, end: 12.4, text: 'Hello ' }, { start: 12.4, end: 12.9, text: 'world' }] },
      { start: 14, text: 'Next' },
    ] });
  });
  it('ends an unclosed last word by estimate before the next line, and starts leading text with the line', () => {
    const parsed = parseLrc('[00:01.00]Oh <00:01.50>long <00:02.00>road\n[00:03.00]Next')!;
    expect(parsed.lines[0].words).toEqual([
      { start: 1, end: 1.5, text: 'Oh ' }, { start: 1.5, end: 2, text: 'long ' }, { start: 2, end: 2.9, text: 'road' },
    ]);
  });
  it('applies the offset to words and moves word stamps with a repeated line stamp', () => {
    const parsed = parseLrc('[offset:+500]\n[00:10.00][00:30.00]<00:10.00>Chorus <00:10.80>here<00:11.50>')!;
    expect(parsed.lines.map(line => line.words?.map(word => [word.start, word.end]))).toEqual([
      [[9.5, 10.3], [10.3, 11]], [[29.5, 30.3], [30.3, 31]],
    ]);
  });
  it('reads non-Latin text and emoji between stamps', () => {
    const parsed = parseLrc('[00:05.00]<00:05.00>तुम <00:05.60>ही <00:06.00>हो 🔥<00:07.00>')!;
    expect(parsed.lines[0]).toEqual({ start: 5, text: 'तुम ही हो 🔥', words: [
      { start: 5, end: 5.6, text: 'तुम ' }, { start: 5.6, end: 6, text: 'ही ' }, { start: 6, end: 7, text: 'हो 🔥' },
    ] });
    expect(timeWords(parsed).wordTiming).toBe('exact');
  });
});

describe('OpenSubsonic word cues', () => {
  const cueLine = (value: string, cues: { part: string; start: number; end?: number; nth?: number }[], extra: object = {}) => ({
    index: 0, start: cues[0].start, end: 9000, value, ...extra,
    cue: cues.map(({ part, start, end, nth }) => ({ start, ...(end === undefined ? {} : { end }), value: part, ...bytes(value, part, nth) })),
  });

  it('cuts words by UTF-8 byte ranges in Hindi, Punjabi and emoji text', () => {
    const hindi = 'तुम ही हो';
    expect(cueWords(hindi, cueLine(hindi, [{ part: 'तुम', start: 1000, end: 1500 }, { part: 'ही', start: 1600, end: 1800 }, { part: 'हो', start: 1900, end: 2600 }]), 0)).toEqual([
      { start: 1, end: 1.5, text: 'तुम ' }, { start: 1.6, end: 1.8, text: 'ही ' }, { start: 1.9, end: 2.6, text: 'हो' },
    ]);
    // Byte offsets are inclusive: 'तुम' is three characters, nine bytes, 0 to 8.
    expect(bytes(hindi, 'तुम')).toEqual({ byteStart: 0, byteEnd: 8 });
    const punjabi = 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ';
    const words = cueWords(punjabi, cueLine(punjabi, [{ part: 'ਸਤ', start: 0, end: 400 }, { part: 'ਸ੍ਰੀ', start: 400, end: 900 }, { part: 'ਅਕਾਲ', start: 900, end: 2000 }]), 0);
    expect(words?.map(word => word.text)).toEqual(['ਸਤ ', 'ਸ੍ਰੀ ', 'ਅਕਾਲ']);
    const fire = 'Fire 🔥 fire';
    expect(cueWords(fire, cueLine(fire, [{ part: 'Fire', start: 0, end: 300 }, { part: '🔥', start: 300, end: 500 }, { part: 'fire', start: 500, end: 900 }]), 0)?.map(word => word.text))
      .toEqual(['Fire ', '🔥 ', 'fire']);
  });
  it('times syllables, fills missing ends, and keeps untimed text with the word before', () => {
    const value = 'Beau-ti-ful (ah) day';
    expect(cueWords(value, cueLine(value, [{ part: 'Beau-', start: 1000 }, { part: 'ti-', start: 1300 }, { part: 'ful', start: 1500 }, { part: 'day', start: 2500 }]), 200)).toEqual([
      { start: .8, end: 1.1, text: 'Beau-' }, { start: 1.1, end: 1.3, text: 'ti-' }, { start: 1.3, end: 2.3, text: 'ful (ah) ' }, { start: 2.3, end: 8.8, text: 'day' },
    ]);
  });
  it('falls back to the cue values when byte ranges are off, and gives up when neither fits', () => {
    const value = 'तुम ही हो';
    // UTF-16 offsets by mistake: the ranges split characters.
    const utf16 = { index: 0, start: 0, end: 3000, value, cue: [
      { start: 0, end: 500, value: 'तुम', byteStart: 0, byteEnd: 2 }, { start: 500, end: 900, value: 'ही', byteStart: 4, byteEnd: 5 }, { start: 900, end: 1500, value: 'हो', byteStart: 7, byteEnd: 8 },
    ] };
    expect(cueWords(value, utf16, 0)?.map(word => word.text)).toEqual(['तुम ', 'ही ', 'हो']);
    const overlapping = { ...utf16, cue: [{ start: 0, value: 'x', byteStart: 0, byteEnd: 8 }, { start: 1, value: 'y', byteStart: 5, byteEnd: 9 }] };
    expect(cueWords(value, overlapping, 0)).toBeNull();
    expect(cueWords(value, { ...utf16, cue: [{ start: 0, byteStart: 0, byteEnd: 99 }] }, 0)).toBeNull();
    expect(cueWords(value, { ...utf16, cue: [] }, 0)).toBeNull();
  });

  const entry = (extra: object) => ({ kind: 'main', synced: true, line: [{ start: 1000, value: 'Hold on (hold on)' }, { start: 5000, value: 'Let go' }], ...extra });
  const main = cueLine('Hold on', [{ part: 'Hold', start: 1000, end: 1400 }, { part: 'on', start: 1500, end: 2000 }], { agentId: 'lead', end: 2000 });
  const backing = cueLine('(hold on)', [{ part: '(hold on)', start: 2000, end: 2600 }], { agentId: 'bg' });

  it('uses the main agent for word times and keeps line[] as the lines', () => {
    const lyrics = structuredLyrics([entry({ agents: [{ id: 'bg', role: 'bg' }, { id: 'lead', role: 'main' }], cueLine: [backing, main] })])!;
    expect(lyrics.wordTiming).toBe('estimated');
    expect(lyrics.lines[0]).toEqual({ start: 1, end: 2, text: 'Hold on (hold on)', words: [
      { start: 1, end: 1.4, text: 'Hold ' }, { start: 1.5, end: 2, text: 'on ' }, { start: 2, end: 2, text: '(hold on)' },
    ] });
    expect(lyrics.lines[1]).toMatchObject({ start: 5, text: 'Let go' });
    const second = { ...cueLine('Let go', [{ part: 'Let', start: 5000, end: 5200 }, { part: 'go', start: 5300, end: 6000 }], { agentId: 'lead' }), index: 1 };
    expect(structuredLyrics([entry({ agents: [{ id: 'lead', role: 'main' }], cueLine: [main, second] })])!.wordTiming).toBe('exact');
  });
  it('ignores cues that break the agent rules, and never loses the lines to bad cue data', () => {
    const estimated = (extra: object) => {
      const lyrics = structuredLyrics([entry(extra)])!;
      expect(lyrics.lines.map(line => line.text)).toEqual(['Hold on (hold on)', 'Let go']);
      return lyrics.lines[0].words?.map(word => word.end - word.start);
    };
    const spread = estimated({});
    // No main agent, agent ids without agents, a malformed cue, too many cues in a line.
    expect(estimated({ agents: [{ id: 'lead', role: 'bg' }], cueLine: [main] })).toEqual(spread);
    expect(estimated({ cueLine: [main] })).toEqual(spread);
    expect(estimated({ cueLine: [{ ...main, agentId: undefined, cue: [{ start: 'soon', byteStart: -1, byteEnd: 2 }] }] })).toEqual(spread);
    expect(estimated({ cueLine: [{ ...main, agentId: undefined, cue: Array.from({ length: 501 }, () => main.cue[0]) }] })).toEqual(spread);
    expect(estimated({ cueLine: 'nonsense', agents: 7 })).toEqual(spread);
  });
  it('estimates within the cue line when its text is not in the line', () => {
    const lyrics = structuredLyrics([entry({ cueLine: [{ ...cueLine('Something else', [{ part: 'Something', start: 1000, end: 1500 }]), end: 3000 }] })])!;
    expect(lyrics.lines[0]).toMatchObject({ start: 1, end: 3 });
    expect(lyrics.lines[0].words?.at(-1)?.end).toBe(3);
  });
  it('skips translations and pronunciations', () => {
    const lyrics = structuredLyrics([
      { kind: 'translation', synced: true, line: Array.from({ length: 9 }, (_, i) => ({ start: i * 1000, value: 'Übersetzung' })) },
      entry({}),
    ])!;
    expect(lyrics.lines.map(line => line.text)).toEqual(['Hold on (hold on)', 'Let go']);
  });
});
