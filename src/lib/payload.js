/**
 * Payload framing, exactly as the reference unbound branch of encode_payload:
 *
 *   body  = 0x00 || len(message) as 2-byte big-endian || message || Ed25519 signature (64 bytes)
 *   coded = body || RS(30) parity
 *   bits  = coded unpacked MSB first
 *
 * A 31-byte message gives 1024 bits, a 32-byte message 1032 bits. Only a
 * single RS codeword is supported, so the message is 1 to 158 UTF-8 bytes.
 * Messages are never truncated; unsupported lengths throw.
 * @module payload
 */
import { rsEncode, rsDecode, ReedSolomonError, RS_PARITY } from './rs.js';
import { signMessage, verifySignature } from './identity.js';

export const FLAG_UNBOUND = 0;
export const SIGNATURE_BYTES = 64;
export const FRAME_OVERHEAD_BYTES = 1 + 2 + SIGNATURE_BYTES;
export const MAX_MESSAGE_BYTES = 255 - RS_PARITY - FRAME_OVERHEAD_BYTES;
/** 31 ASCII bytes. Tests measure the length instead of assuming it. */
export const DEFAULT_SAMPLE_MESSAGE = 'APCVW browser demo, signed 2026';

/**
 * Coded payload size in bits for a message of `messageByteLength` UTF-8 bytes.
 * @param {number} messageByteLength
 * @returns {number}
 */
export function payloadBitCount(messageByteLength) {
  if (!Number.isInteger(messageByteLength) || messageByteLength < 1) {
    throw new RangeError('message length must be an integer of at least 1 byte');
  }
  if (messageByteLength > MAX_MESSAGE_BYTES) {
    throw new RangeError(`message length must be at most ${MAX_MESSAGE_BYTES} bytes (single RS codeword)`);
  }
  return (FRAME_OVERHEAD_BYTES + messageByteLength + RS_PARITY) * 8;
}

/**
 * Inverse of payloadBitCount. Throws when the bit count is not a supported payload size.
 * @param {number} bitCount
 * @returns {number} message length in bytes
 */
export function messageLengthFromBitCount(bitCount) {
  if (!Number.isInteger(bitCount) || bitCount <= 0 || bitCount % 8 !== 0) {
    throw new RangeError('bit count must be a positive multiple of 8');
  }
  const n = bitCount / 8 - RS_PARITY - FRAME_OVERHEAD_BYTES;
  if (n < 1 || n > MAX_MESSAGE_BYTES) {
    throw new RangeError(`bit count ${bitCount} does not correspond to a supported message length (1 to ${MAX_MESSAGE_BYTES} bytes)`);
  }
  return n;
}

/**
 * Unpack bytes to bits, most significant bit first.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} values 0 or 1
 */
export function bytesToBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    for (let k = 0; k < 8; k++) bits[i * 8 + k] = (b >> (7 - k)) & 1;
  }
  return bits;
}

/**
 * Pack bits (MSB first) to bytes. Any nonzero entry counts as 1.
 * @param {ArrayLike<number>} bits
 * @returns {Uint8Array}
 */
export function bitsToBytes(bits) {
  if (bits.length % 8 !== 0) throw new RangeError('bit array length must be a multiple of 8');
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | (bits[i * 8 + k] ? 1 : 0);
    out[i] = b;
  }
  return out;
}

/**
 * Build the framed body: flag, length, message, signature.
 * @param {Uint8Array} messageBytes
 * @param {Uint8Array} signature
 * @returns {Uint8Array}
 */
export function frameBody(messageBytes, signature) {
  const n = messageBytes.length;
  if (n < 1 || n > MAX_MESSAGE_BYTES) throw new RangeError(`message must be 1 to ${MAX_MESSAGE_BYTES} bytes`);
  if (signature.length !== SIGNATURE_BYTES) throw new RangeError('signature must be 64 bytes');
  const body = new Uint8Array(FRAME_OVERHEAD_BYTES + n);
  body[0] = FLAG_UNBOUND;
  body[1] = (n >> 8) & 0xff;
  body[2] = n & 0xff;
  body.set(messageBytes, 3);
  body.set(signature, 3 + n);
  return body;
}

/**
 * Sign a UTF-8 message and produce the coded payload bits.
 * @param {string} message 1 to 158 UTF-8 bytes
 * @param {Uint8Array} privateKey 32-byte Ed25519 seed
 * @returns {Promise<{bits: Uint8Array, signature: Uint8Array, messageBytes: Uint8Array, codedBytes: Uint8Array, bitCount: number}>}
 */
export async function createPayload(message, privateKey) {
  if (typeof message !== 'string') throw new TypeError('message must be a string');
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw new TypeError('privateKey must be a 32-byte Uint8Array (Ed25519 seed)');
  }
  const messageBytes = new TextEncoder().encode(message);
  if (messageBytes.length < 1) throw new RangeError('message must not be empty (at least 1 UTF-8 byte)');
  if (messageBytes.length > MAX_MESSAGE_BYTES) {
    throw new RangeError(`message is ${messageBytes.length} UTF-8 bytes; at most ${MAX_MESSAGE_BYTES} bytes fit a single RS codeword`);
  }
  const signature = signMessage(messageBytes, privateKey);
  const codedBytes = rsEncode(frameBody(messageBytes, signature));
  const bits = bytesToBits(codedBytes);
  return { bits, signature, messageBytes, codedBytes, bitCount: bits.length };
}

/**
 * Decode hard payload bits and verify the signature using only recovered
 * bytes. Never accepts an expected message or signature. Returns a rejection
 * reason instead of throwing for any content problem; throws only for
 * programming errors (unsupported bit count, malformed key).
 * @param {Uint8Array} bits
 * @param {Uint8Array} publicKey
 * @returns {{verified: boolean, reason: string, message: string|null, messageBytes: Uint8Array|null, signature: Uint8Array|null, correctedSymbols: number|null}}
 */
export function decodePayloadBits(bits, publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new TypeError('publicKey must be a 32-byte Uint8Array');
  }
  if (!(bits instanceof Uint8Array)) throw new TypeError('bits must be a Uint8Array of 0/1 values');
  const expectedLength = messageLengthFromBitCount(bits.length);
  const rejected = (reason, correctedSymbols = null) => ({
    verified: false, reason, message: null, messageBytes: null, signature: null, correctedSymbols,
  });
  let decoded;
  try {
    decoded = rsDecode(bitsToBytes(bits));
  } catch (err) {
    if (err instanceof ReedSolomonError) return rejected(`RS decode failed (${err.message})`);
    throw err;
  }
  const dec = decoded.data;
  if (dec.length < 3) return rejected('payload truncated', decoded.corrected);
  const flag = dec[0];
  if (flag === 1) return rejected('content-bound payload not supported', decoded.corrected);
  if (flag !== FLAG_UNBOUND) return rejected(`bad flag byte (${flag})`, decoded.corrected);
  const n = (dec[1] << 8) | dec[2];
  if (n <= 0 || n !== expectedLength || 3 + n + SIGNATURE_BYTES !== dec.length) {
    return rejected(`bad length header (${n})`, decoded.corrected);
  }
  const messageBytes = dec.slice(3, 3 + n);
  const signature = dec.slice(3 + n, 3 + n + SIGNATURE_BYTES);
  if (!verifySignature(signature, messageBytes, publicKey)) return rejected('signature invalid', decoded.corrected);
  return {
    verified: true,
    reason: 'ok',
    message: new TextDecoder('utf-8').decode(messageBytes),
    messageBytes,
    signature,
    correctedSymbols: decoded.corrected,
  };
}
