/**
 * Chroma phase carrier planes.
 *
 * For group g with bins (ky_j, kx_j), phases phi_j, and signs s_j = 2*bit - 1:
 *   F[ky_j, kx_j mod W]           += s_j * alpha * N / 2 * exp(i phi_j)
 *   F[(-ky_j) mod H, (-kx_j) mod W] += conjugate of the same value
 *   carrier = Re(ifft2(F))
 * which equals sum_j s_j * alpha * cos(2 pi (ky_j y / H + kx_j x / W) + phi_j).
 * Amplitude follows the reference: alpha = sqrt(2 * 255^2 / (10^(PSNR/10) * bitsPerGroup)),
 * so the carrier power is bitsPerGroup * alpha^2 / 2 and the per-frame Cr PSNR
 * equals the target before rounding.
 *
 * createCarriers builds the four planes once per strength. Callers reuse them
 * for every frame; nothing is computed per frame here.
 * @module carrier
 */
import { fft2d } from './fft.js';

/**
 * Reference amplitude for a per-frame PSNR target.
 * @param {number} psnrTarget dB
 * @param {number} bitsPerGroup carriers per frame
 * @returns {number}
 */
export function carrierAlpha(psnrTarget, bitsPerGroup) {
  if (!Number.isFinite(psnrTarget) || psnrTarget <= 0) throw new RangeError('psnrTarget must be a positive finite number of dB');
  if (!Number.isInteger(bitsPerGroup) || bitsPerGroup < 1) throw new RangeError('bitsPerGroup must be a positive integer');
  return Math.sqrt((2 * 255 * 255) / (10 ** (psnrTarget / 10) * bitsPerGroup));
}

/**
 * Sparse conjugate-symmetric spectrum of one group carrier.
 * @param {import('./layout.js').Layout} layout
 * @param {number} group
 * @param {ArrayLike<number>} signs +1 / -1 per bin of the group
 * @param {number} alpha
 * @returns {{re: Float64Array, im: Float64Array}}
 */
export function buildCarrierSpectrum(layout, group, signs, alpha) {
  const W = layout.width;
  const H = layout.height;
  const N = W * H;
  const g = layout.groups[group];
  if (!g) throw new RangeError(`group ${group} does not exist`);
  if (signs.length !== g.ky.length) throw new RangeError('signs length must equal the group bin count');
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const amp = (alpha * N) / 2;
  for (let j = 0; j < g.ky.length; j++) {
    const v = signs[j] * amp;
    const c = v * Math.cos(g.phases[j]);
    const s = v * Math.sin(g.phases[j]);
    const ky = g.ky[j];
    const kx = ((g.kx[j] % W) + W) % W;
    const a = ky * W + kx;
    re[a] += c;
    im[a] += s;
    const b = ((H - ky) % H) * W + ((W - kx) % W);
    re[b] += c;
    im[b] -= s;
  }
  return { re, im };
}

/**
 * Real carrier plane of one group, row-major Float32Array of width*height.
 * @param {import('./layout.js').Layout} layout
 * @param {number} group
 * @param {ArrayLike<number>} signs
 * @param {number} alpha
 * @returns {Float32Array}
 */
export function buildCarrierPlane(layout, group, signs, alpha) {
  const { re, im } = buildCarrierSpectrum(layout, group, signs, alpha);
  fft2d(re, im, layout.width, layout.height, true);
  return Float32Array.from(re);
}

/**
 * Build the four group carrier planes for one payload at one strength.
 * @param {import('./layout.js').Layout} layout
 * @param {Uint8Array} bits payload bits, length layout.bitCount
 * @param {number} psnrTarget per-frame Cr PSNR target in dB
 * @returns {{version: string, psnrTarget: number, alpha: number, width: number, height: number, planes: Float32Array[]}}
 */
export function createCarriers(layout, bits, psnrTarget) {
  if (!layout || !Array.isArray(layout.groups)) throw new TypeError('layout must be a layout object');
  if (!(bits instanceof Uint8Array) || bits.length !== layout.bitCount) {
    throw new RangeError(`bits must be a Uint8Array of length ${layout.bitCount} (layout bit count)`);
  }
  const per = layout.groups[0].ky.length;
  const alpha = carrierAlpha(psnrTarget, per);
  const planes = layout.groups.map((g, gi) => {
    const signs = new Float64Array(g.ky.length);
    for (let j = 0; j < signs.length; j++) signs[j] = bits[g.bits[j]] ? 1 : -1;
    return buildCarrierPlane(layout, gi, signs, alpha);
  });
  return { version: layout.version, psnrTarget, alpha, width: layout.width, height: layout.height, planes };
}

/**
 * Embed-side only: which group a source frame index carries in the K=30 cycle.
 * The verifier never uses this; it identifies groups from the frame content.
 * @param {number} frameIndex
 * @param {import('./layout.js').Layout} layout
 * @returns {number}
 */
export function groupForFrame(frameIndex, layout) {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) throw new RangeError('frameIndex must be a non-negative integer');
  return Math.floor(frameIndex / layout.runLength) % layout.groupCount;
}
