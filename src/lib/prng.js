/**
 * Reproducible layout PRNG, version apcvw-js-v1.
 *
 *   seed    = SHA-256( UTF8("apcvw-js-v1|layout|") || UTF8(nonce) )
 *   block_i = SHA-256( seed || BE32(i) ),  i = 0, 1, 2, ...
 *   stream  = the 8 big-endian uint32 words of block_0, then block_1, ...
 *
 * nextFloat() builds a 53-bit double from two words: ((a >>> 5) * 2^26 + (b >>> 6)) / 2^53.
 * nextBelow(n) uses masked rejection sampling, so it has no modulo bias.
 *
 * This stream is NOT byte-compatible with the Python reference, which seeds
 * numpy PCG64 from SHA-256("apvw-layout-v1" || nonce). Layouts made by this
 * module decode only what this module embedded. The version tag travels in
 * every layout object so the two schemes can never be confused.
 * @module prng
 */
import { sha256 } from '@noble/hashes/sha2.js';

export const LAYOUT_VERSION = 'apcvw-js-v1';
const DOMAIN = 'apcvw-js-v1|layout|';

/**
 * 32-byte layout seed from a public per-video nonce string.
 * @param {string} nonce
 * @returns {Uint8Array}
 */
export function layoutSeed(nonce) {
  if (typeof nonce !== 'string') throw new TypeError('nonce must be a string');
  const enc = new TextEncoder();
  const d = enc.encode(DOMAIN);
  const n = enc.encode(nonce);
  const buf = new Uint8Array(d.length + n.length);
  buf.set(d);
  buf.set(n, d.length);
  return sha256(buf);
}

export class CounterPrng {
  /** @param {Uint8Array} seed 32 bytes */
  constructor(seed) {
    if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new TypeError('seed must be a Uint8Array of 32 bytes');
    this.block = new Uint8Array(36);
    this.block.set(seed);
    this.counter = 0;
    this.words = new Uint32Array(8);
    this.pos = 8;
  }

  refill() {
    if (this.counter > 0xffffffff) throw new Error('CounterPrng: counter exhausted');
    const c = this.counter;
    const b = this.block;
    b[32] = (c >>> 24) & 0xff;
    b[33] = (c >>> 16) & 0xff;
    b[34] = (c >>> 8) & 0xff;
    b[35] = c & 0xff;
    const h = sha256(b);
    for (let i = 0; i < 8; i++) {
      this.words[i] = ((h[4 * i] << 24) | (h[4 * i + 1] << 16) | (h[4 * i + 2] << 8) | h[4 * i + 3]) >>> 0;
    }
    this.pos = 0;
    this.counter = c + 1;
  }

  /** @returns {number} uniform uint32 */
  nextUint32() {
    if (this.pos >= 8) this.refill();
    return this.words[this.pos++];
  }

  /** @returns {number} uniform double in [0, 1) with 53 random bits */
  nextFloat() {
    const a = this.nextUint32() >>> 5;
    const b = this.nextUint32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /**
   * Uniform integer in [0, n) without modulo bias.
   * @param {number} n integer in [1, 2^32]
   */
  nextBelow(n) {
    if (!Number.isInteger(n) || n < 1 || n > 4294967296) {
      throw new RangeError('nextBelow: n must be an integer in [1, 2^32]');
    }
    if (n === 1) return 0;
    const bits = 32 - Math.clz32(n - 1);
    const mask = bits >= 32 ? 0xffffffff : (1 << bits) - 1;
    for (;;) {
      const r = (this.nextUint32() & mask) >>> 0;
      if (r < n) return r;
    }
  }
}
