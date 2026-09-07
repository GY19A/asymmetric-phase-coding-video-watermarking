/**
 * Ed25519 identity and signature helpers.
 *
 * Signing uses the audited @noble/ed25519 implementation with synchronous
 * SHA-512 from @noble/hashes, so it works where crypto.subtle is unavailable
 * (for example plain HTTP on a private address). Randomness comes from
 * crypto.getRandomValues, which browsers expose in every context.
 * The private key is the 32-byte RFC 8032 seed. Nothing here stores keys.
 * @module identity
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

function assertBytes(value, length, name) {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${name} must be a Uint8Array of ${length} bytes`);
  }
}

/**
 * Generate a fresh random Ed25519 identity. No network, no storage.
 * @returns {Promise<{privateKey: Uint8Array, publicKey: Uint8Array}>}
 */
export async function generateIdentity() {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is not available in this runtime');
  }
  const privateKey = c.getRandomValues(new Uint8Array(32));
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Derive the 32-byte public key from a 32-byte seed.
 * @param {Uint8Array} privateKey
 * @returns {Uint8Array}
 */
export function publicKeyFromPrivate(privateKey) {
  assertBytes(privateKey, 32, 'privateKey');
  return ed.getPublicKey(privateKey);
}

/**
 * Sign bytes. Returns the 64-byte Ed25519 signature.
 * @param {Uint8Array} messageBytes
 * @param {Uint8Array} privateKey
 * @returns {Uint8Array}
 */
export function signMessage(messageBytes, privateKey) {
  assertBytes(privateKey, 32, 'privateKey');
  if (!(messageBytes instanceof Uint8Array)) throw new TypeError('messageBytes must be a Uint8Array');
  return ed.sign(messageBytes, privateKey);
}

/**
 * Verify a signature. Returns false for any malformed or invalid signature;
 * never throws for signature content. Throws only for a malformed public key
 * or message type, which are programming errors.
 * @param {Uint8Array} signature
 * @param {Uint8Array} messageBytes
 * @param {Uint8Array} publicKey
 * @returns {boolean}
 */
export function verifySignature(signature, messageBytes, publicKey) {
  assertBytes(publicKey, 32, 'publicKey');
  if (!(messageBytes instanceof Uint8Array)) throw new TypeError('messageBytes must be a Uint8Array');
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
  try {
    return ed.verify(signature, messageBytes, publicKey, { zip215: true }) === true;
  } catch {
    return false;
  }
}
