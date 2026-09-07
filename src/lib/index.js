/**
 * apcvw-js public API: numerical and cryptographic core.
 * See docs/API.md for the exact contract of every export.
 * @module apcvw-js
 */
export const LIBRARY_VERSION = '0.1.0';

export { toHex, fromHex } from './hex.js';
export { generateIdentity, publicKeyFromPrivate, signMessage, verifySignature } from './identity.js';
export {
  createPayload, decodePayloadBits, payloadBitCount, messageLengthFromBitCount, bytesToBits, bitsToBytes,
  MAX_MESSAGE_BYTES, DEFAULT_SAMPLE_MESSAGE, FRAME_OVERHEAD_BYTES, SIGNATURE_BYTES,
} from './payload.js';
export { RS_PARITY, ReedSolomonError } from './rs.js';
export { createLayout, gridBins, assertLayoutMatches, GROUPS, RUN_LENGTH, BAND, MIN_DIMENSION, MAX_DIMENSION } from './layout.js';
export { LAYOUT_VERSION } from './prng.js';
export { createCarriers, carrierAlpha, groupForFrame } from './carrier.js';
export { embedFrame } from './embed.js';
export { crPlane, rgbaToYCrCb, yCrCbToRgba } from './color.js';
export { extractFrameEvidence, evidenceFromPlane, smoothGroups, verifyEvidence } from './evidence.js';
export { spectrumPreview, residualPlane } from './spectrum.js';
export { fft, fft2d, isPowerOfTwo } from './fft.js';
