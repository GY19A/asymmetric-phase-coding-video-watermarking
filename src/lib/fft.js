/**
 * Radix-2 complex FFT (1D in place, 2D row-column) on Float64Array pairs.
 * Forward transform uses exp(-2 pi i k t / n) without scaling; the inverse
 * uses exp(+2 pi i k t / n) and divides by n, matching numpy and torch.
 * Only power-of-two sizes are supported.
 * @module fft
 */

/** @param {number} n */
export function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

const tableCache = new Map();

function tables(n) {
  let t = tableCache.get(n);
  if (t) return t;
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  t = { rev, cos, sin };
  tableCache.set(n, t);
  return t;
}

/**
 * In-place 1D FFT.
 * @param {Float64Array} re
 * @param {Float64Array} im
 * @param {boolean} [inverse]
 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (im.length !== n) throw new RangeError('fft: re and im must have the same length');
  if (!isPowerOfTwo(n)) throw new RangeError('fft: length must be a power of two');
  if (n === 1) return;
  const { rev, cos, sin } = tables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >>> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = cos[t];
        const wi = sign * sin[t];
        const a = start + k;
        const b = a + half;
        const xr = re[b];
        const xi = im[b];
        const tr = xr * wr - xi * wi;
        const ti = xr * wi + xi * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) {
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= inv;
      im[i] *= inv;
    }
  }
}

/**
 * In-place 2D FFT of a row-major plane (index = y * width + x).
 * @param {Float64Array} re
 * @param {Float64Array} im
 * @param {number} width
 * @param {number} height
 * @param {boolean} [inverse]
 */
export function fft2d(re, im, width, height, inverse = false) {
  if (!isPowerOfTwo(width) || !isPowerOfTwo(height)) {
    throw new RangeError('fft2d: width and height must each be a power of two');
  }
  if (re.length !== width * height || im.length !== re.length) {
    throw new RangeError('fft2d: plane length must equal width * height');
  }
  for (let y = 0; y < height; y++) {
    const off = y * width;
    fft(re.subarray(off, off + width), im.subarray(off, off + width), inverse);
  }
  const colRe = new Float64Array(height);
  const colIm = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      colRe[y] = re[y * width + x];
      colIm[y] = im[y * width + x];
    }
    fft(colRe, colIm, inverse);
    for (let y = 0; y < height; y++) {
      re[y * width + x] = colRe[y];
      im[y * width + x] = colIm[y];
    }
  }
}
