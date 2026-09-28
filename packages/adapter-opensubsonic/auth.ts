// Subsonic token authentication sends t = md5(password + salt) and s = salt. Web Crypto has no
// MD5, so this small implementation serves every build: the desktop, the browser build's host,
// and the Android app, where the connector runs inside the WebView.

const shifts = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/** MD5 of the text's UTF-8 bytes, as 32 lowercase hex digits (what Node's createHash('md5') gives). */
export function md5Hex(text: string): string {
  const input = new TextEncoder().encode(text);
  // Pad to 56 bytes mod 64 with 0x80 then zeros, and end with the bit length, little-endian.
  const length = (((input.length + 8) >>> 6) + 1) * 64;
  const bytes = new Uint8Array(length);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bits = input.length * 8;
  view.setUint32(length - 8, bits >>> 0, true);
  view.setUint32(length - 4, Math.floor(bits / 2 ** 32), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const words = new Uint32Array(16);
  for (let block = 0; block < length; block += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(block + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const sum = (a + f + constants[i] + words[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((sum << shifts[i]) | (sum >>> (32 - shifts[i])))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((word, i) => out.setUint32(i * 4, word, true));
  return hex(new Uint8Array(out.buffer));
}

/** A fresh salt: 16 random bytes as hex, from the platform's cryptographic generator. */
export function randomSalt(): string {
  return hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
