/**
 * Hex helpers for keys, signatures, and payload bytes.
 * @module hex
 */

/**
 * Encode bytes as lowercase hexadecimal.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toHex(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('toHex expects a Uint8Array');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * Decode a hexadecimal string (either case) into bytes.
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function fromHex(hex) {
  if (typeof hex !== 'string') throw new TypeError('fromHex expects a string');
  if (hex.length % 2 !== 0) throw new Error('fromHex: hex string must have even length');
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error('fromHex: string contains non-hex characters');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
