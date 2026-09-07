/**
 * RGBA <-> YCrCb conversion.
 *
 * Forward (OpenCV's documented 8-bit YCrCb constants, applied in float64):
 *   Y  = 0.299 R + 0.587 G + 0.114 B
 *   Cr = 0.713 (R - Y) + 128
 *   Cb = 0.564 (B - Y) + 128
 * Inverse is the exact algebraic inverse of the forward transform (not
 * OpenCV's rounded 3-decimal constants), so a zero modification reproduces
 * the input exactly after rounding:
 *   R = Y + (Cr - 128) / 0.713
 *   B = Y + (Cb - 128) / 0.564
 *   G = (Y - 0.299 R - 0.114 B) / 0.587
 * Output channels are rounded half up with Math.round and clamped to [0, 255].
 * Alpha passes through unchanged.
 * @module color
 */

export const KR = 0.299;
export const KG = 0.587;
export const KB = 0.114;
export const CR_SCALE = 0.713;
export const CB_SCALE = 0.564;
export const CHROMA_OFFSET = 128;

/**
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 */
export function validateRgba(rgba, width, height) {
  if (!(rgba instanceof Uint8ClampedArray) && !(rgba instanceof Uint8Array)) {
    throw new TypeError('rgba must be a Uint8ClampedArray (or Uint8Array) of RGBA bytes');
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('width and height must be positive integers');
  }
  if (rgba.length !== width * height * 4) {
    throw new RangeError(`rgba length ${rgba.length} does not match ${width}x${height}x4`);
  }
}

/**
 * Cr plane of an RGBA frame as float64, row-major.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Float64Array}
 */
export function crPlane(rgba, width, height) {
  validateRgba(rgba, width, height);
  const n = width * height;
  const out = new Float64Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const y = KR * r + KG * g + KB * b;
    out[i] = CR_SCALE * (r - y) + CHROMA_OFFSET;
  }
  return out;
}

/**
 * Full float64 YCrCb decomposition.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {{y: Float64Array, cr: Float64Array, cb: Float64Array}}
 */
export function rgbaToYCrCb(rgba, width, height) {
  validateRgba(rgba, width, height);
  const n = width * height;
  const y = new Float64Array(n);
  const cr = new Float64Array(n);
  const cb = new Float64Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const yy = KR * r + KG * g + KB * b;
    y[i] = yy;
    cr[i] = CR_SCALE * (r - yy) + CHROMA_OFFSET;
    cb[i] = CB_SCALE * (b - yy) + CHROMA_OFFSET;
  }
  return { y, cr, cb };
}

/**
 * Exact inverse conversion with final rounding and clamping.
 * @param {Float64Array} y
 * @param {Float64Array} cr
 * @param {Float64Array} cb
 * @param {Uint8ClampedArray|Uint8Array|null} alphaSource RGBA array to copy alpha from, or null for 255
 * @param {number} width
 * @param {number} height
 * @returns {Uint8ClampedArray}
 */
export function yCrCbToRgba(y, cr, cb, alphaSource, width, height) {
  const n = width * height;
  if (y.length !== n || cr.length !== n || cb.length !== n) throw new RangeError('plane length must equal width * height');
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const dr = (cr[i] - CHROMA_OFFSET) / CR_SCALE;
    const db = (cb[i] - CHROMA_OFFSET) / CB_SCALE;
    const r = y[i] + dr;
    const b = y[i] + db;
    const g = (y[i] - KR * r - KB * b) / KG;
    out[p] = Math.round(r);
    out[p + 1] = Math.round(g);
    out[p + 2] = Math.round(b);
    out[p + 3] = alphaSource ? alphaSource[p + 3] : 255;
  }
  return out;
}
