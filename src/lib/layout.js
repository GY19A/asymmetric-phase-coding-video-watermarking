/**
 * Public carrier layout: frozen band, run-length groups, nonce-derived bins.
 *
 * The bin pool follows the reference grid_bins exactly: ky in [1, H/2),
 * kx in (-W/2, W/2), radius sqrt((ky/(H/2))^2 + (kx/(W/2))^2) in [0.05, 0.12).
 * The payload is split into G = 4 equal contiguous bit groups. Group g holds
 * bits [g*B/4, (g+1)*B/4). Each group draws one bin and one phase per bit.
 * The four groups draw DISJOINT bins (the paper states this orthogonality;
 * the Python reference samples each group independently from the full pool
 * and may overlap). Frames cycle through the groups in runs of K = 30.
 *
 * Bin selection and phases come from the apcvw-js-v1 SHA-256 counter PRNG in
 * prng.js. They are NOT byte-compatible with Python nonce layouts.
 * @module layout
 */
import { layoutSeed, CounterPrng, LAYOUT_VERSION } from './prng.js';
import { isPowerOfTwo } from './fft.js';
import { messageLengthFromBitCount } from './payload.js';

export const GROUPS = 4;
export const RUN_LENGTH = 30;
export const BAND = [0.05, 0.12];
export const MIN_DIMENSION = 64;
export const MAX_DIMENSION = 8192;
export { LAYOUT_VERSION };

/**
 * Carrier band bins on the DFT grid, in the reference order (ky outer, kx inner).
 * @param {number} width
 * @param {number} height
 * @param {number} [lo]
 * @param {number} [hi]
 * @returns {{ky: Int32Array, kx: Int32Array}}
 */
export function gridBins(width, height, lo = BAND[0], hi = BAND[1]) {
  const halfH = height / 2;
  const halfW = width / 2;
  const kyOut = [];
  const kxOut = [];
  const kyMax = Math.floor(height / 2);
  const kxMax = Math.floor(width / 2);
  for (let ky = 1; ky < kyMax; ky++) {
    const a = ky / halfH;
    for (let kx = -kxMax + 1; kx < kxMax; kx++) {
      const b = kx / halfW;
      const r = Math.sqrt(a * a + b * b);
      if (r >= lo && r < hi) {
        kyOut.push(ky);
        kxOut.push(kx);
      }
    }
  }
  return { ky: Int32Array.from(kyOut), kx: Int32Array.from(kxOut) };
}

/**
 * Deterministic public layout for one video.
 * @param {{width: number, height: number, nonce: string, bitCount: number}} params
 * @returns {Promise<Layout>}
 */
export async function createLayout({ width, height, nonce, bitCount } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new TypeError('width and height must be integers');
  if (!isPowerOfTwo(width) || !isPowerOfTwo(height)) {
    throw new RangeError(`each frame dimension must be a power of two (got ${width}x${height})`);
  }
  if (width < MIN_DIMENSION || height < MIN_DIMENSION || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new RangeError(`frame dimensions must be between ${MIN_DIMENSION} and ${MAX_DIMENSION} (got ${width}x${height})`);
  }
  if (typeof nonce !== 'string' || nonce.length === 0) throw new TypeError('nonce must be a non-empty string');
  messageLengthFromBitCount(bitCount);
  const per = bitCount / GROUPS;
  const pool = gridBins(width, height);
  const poolSize = pool.ky.length;
  const need = GROUPS * per;
  if (need > poolSize) {
    throw new RangeError(`layout needs ${need} disjoint carrier bins but the ${width}x${height} band pool has only ${poolSize} bins`);
  }
  const prng = new CounterPrng(layoutSeed(nonce));
  const idx = new Uint32Array(poolSize);
  for (let i = 0; i < poolSize; i++) idx[i] = i;
  for (let i = 0; i < need; i++) {
    const j = i + prng.nextBelow(poolSize - i);
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  const groups = [];
  for (let g = 0; g < GROUPS; g++) {
    const ky = new Int32Array(per);
    const kx = new Int32Array(per);
    const phases = new Float64Array(per);
    const bits = new Uint32Array(per);
    for (let j = 0; j < per; j++) {
      const p = idx[g * per + j];
      ky[j] = pool.ky[p];
      kx[j] = pool.kx[p];
      bits[j] = g * per + j;
    }
    for (let j = 0; j < per; j++) phases[j] = prng.nextFloat() * 2 * Math.PI;
    groups.push({ ky, kx, phases, bits, bitStart: g * per, bitEnd: (g + 1) * per });
  }
  return {
    version: LAYOUT_VERSION,
    width,
    height,
    nonce,
    bitCount,
    groupCount: GROUPS,
    runLength: RUN_LENGTH,
    band: [BAND[0], BAND[1]],
    poolSize,
    groups,
  };
}

/**
 * @typedef {object} LayoutGroup
 * @property {Int32Array} ky vertical DFT bin index, 1 <= ky < height/2
 * @property {Int32Array} kx horizontal DFT bin index, -width/2 < kx < width/2
 * @property {Float64Array} phases carrier phase per bin in [0, 2pi)
 * @property {Uint32Array} bits payload bit index carried by each bin
 * @property {number} bitStart
 * @property {number} bitEnd
 */

/**
 * @typedef {object} Layout
 * @property {string} version 'apcvw-js-v1'
 * @property {number} width
 * @property {number} height
 * @property {string} nonce
 * @property {number} bitCount
 * @property {number} groupCount 4
 * @property {number} runLength 30
 * @property {number[]} band [0.05, 0.12]
 * @property {number} poolSize
 * @property {LayoutGroup[]} groups
 */

/**
 * Throw when a layout does not match a frame size.
 * @param {Layout} layout
 * @param {number} width
 * @param {number} height
 */
export function assertLayoutMatches(layout, width, height) {
  if (!layout || layout.version !== LAYOUT_VERSION) throw new TypeError(`layout must be an ${LAYOUT_VERSION} layout object`);
  if (layout.width !== width || layout.height !== height) {
    throw new RangeError(`layout is ${layout.width}x${layout.height} but the frame is ${width}x${height}`);
  }
}
