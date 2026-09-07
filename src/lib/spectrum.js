/**
 * Real log-magnitude spectrum for visualization.
 *
 * magnitude[v, u] = log10(1 + |F[v, u]|) of the 2D FFT of the Cr plane (RGBA
 * input) or of a supplied numeric plane (carrier or residual). With
 * shift = true (default) the DC bin sits at (height/2, width/2). The RGBA
 * output maps [min, max] linearly to gray 0..255 with alpha 255. This is a
 * plot of the computed spectrum, not a verification signal.
 * @module spectrum
 */
import { fft2d, isPowerOfTwo } from './fft.js';
import { crPlane, validateRgba } from './color.js';

/**
 * @param {Uint8ClampedArray|Uint8Array|Float32Array|Float64Array} source RGBA frame or real plane
 * @param {number} width
 * @param {number} height
 * @param {{shift?: boolean}} [options]
 * @returns {{width: number, height: number, shifted: boolean, magnitude: Float32Array, rgba: Uint8ClampedArray, min: number, max: number}}
 */
export function spectrumPreview(source, width, height, options = {}) {
  const shift = options.shift !== false;
  const isRgba = source instanceof Uint8ClampedArray || source instanceof Uint8Array;
  const isPlane = source instanceof Float32Array || source instanceof Float64Array;
  if (!isRgba && !isPlane) {
    throw new TypeError('source must be an RGBA Uint8ClampedArray or a Float32Array/Float64Array plane');
  }
  if (!isPowerOfTwo(width) || !isPowerOfTwo(height)) {
    throw new RangeError('width and height must each be a power of two');
  }
  let plane;
  if (isRgba) {
    validateRgba(source, width, height);
    plane = crPlane(source, width, height);
  } else {
    if (source.length !== width * height) throw new RangeError(`plane length ${source.length} does not equal width*height ${width * height}`);
    plane = source;
  }
  const n = width * height;
  const re = Float64Array.from(plane);
  const im = new Float64Array(n);
  fft2d(re, im, width, height, false);
  const magnitude = new Float32Array(n);
  let min = Infinity;
  let max = -Infinity;
  const halfW = width / 2;
  const halfH = height / 2;
  for (let v = 0; v < height; v++) {
    const dv = shift ? (v + halfH) % height : v;
    for (let u = 0; u < width; u++) {
      const src = v * width + u;
      const du = shift ? (u + halfW) % width : u;
      const dst = dv * width + du;
      magnitude[dst] = Math.log10(1 + Math.sqrt(re[src] * re[src] + im[src] * im[src]));
      const m = magnitude[dst];
      if (m < min) min = m;
      if (m > max) max = m;
    }
  }
  const rgba = new Uint8ClampedArray(n * 4);
  const range = max - min || 1;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = Math.round((255 * (magnitude[i] - min)) / range);
    rgba[p] = v;
    rgba[p + 1] = v;
    rgba[p + 2] = v;
    rgba[p + 3] = 255;
  }
  return { width, height, shifted: shift, magnitude, rgba, min, max };
}

/**
 * Cr(marked) - Cr(source): the actual embedded modification plus rounding noise.
 * @param {Uint8ClampedArray|Uint8Array} markedRgba
 * @param {Uint8ClampedArray|Uint8Array} sourceRgba
 * @param {number} width
 * @param {number} height
 * @returns {Float64Array}
 */
export function residualPlane(markedRgba, sourceRgba, width, height) {
  const a = crPlane(markedRgba, width, height);
  const b = crPlane(sourceRgba, width, height);
  const out = new Float64Array(a.length);
  for (let i = 0; i < out.length; i++) out[i] = a[i] - b[i];
  return out;
}
