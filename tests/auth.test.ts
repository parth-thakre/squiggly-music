import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5Hex, randomSalt } from '../packages/adapter-opensubsonic/auth';

const nodeMd5 = (text: string) => createHash('md5').update(text).digest('hex');

describe('token authentication hashing', () => {
  it('matches the published MD5 test vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });
  it('agrees with Node for every padding boundary and for text beyond ASCII', () => {
    // 0 to 200 bytes crosses the 55/56 and 119/120 byte padding edges; the suffixes add
    // two-, three-, and four-byte UTF-8 sequences, as passwords may.
    for (let length = 0; length <= 200; length++) {
      const text = randomBytes(length).toString('latin1') + ['', 'é', '€', '😀'][length % 4];
      expect(md5Hex(text)).toBe(nodeMd5(text));
    }
    const password = 'pässwörd-日本語-🎧', salt = randomSalt();
    expect(md5Hex(password + salt)).toBe(nodeMd5(password + salt));
  });
  it('makes a fresh 16-byte hex salt each time', () => {
    const salts = new Set(Array.from({ length: 20 }, randomSalt));
    expect(salts.size).toBe(20);
    for (const salt of salts) expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });
});
