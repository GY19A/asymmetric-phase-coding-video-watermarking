/**
 * Cr-only additive embedding of one carrier plane into one RGBA frame.
 *
 * Per pixel: convert RGB to float YCrCb (see color.js), add the carrier
 * sample to Cr, clamp Cr to [0, 255], convert back with the exact inverse,
 * round each RGB channel half up, clamp to [0, 255]. Y and Cb are untouched
 * except for the final integer rounding of RGB. Alpha is copied. The input
 * array is not modified. No LSB tricks, no drawn marks, no container fields.
 * @module embed
 */
import { validateRgba, KR, KG, KB, CR_SCALE, CB_SCALE, CHROMA_OFFSET } from './color.js';

/**
 * @param {Uint8ClampedArray|Uint8Array} rgba source frame, length width*height*4
 * @param {number} width
 * @param {number} height
 * @param {Float32Array|Float64Array} carrierPlane one group plane from createCarriers, length width*height
 * @returns {Uint8ClampedArray} new RGBA frame
 */
export function embedFrame(rgba, width, height, carrierPlane) {
  validateRgba(rgba, width, height);
  const n = width * height;
  if (!(carrierPlane instanceof Float32Array || carrierPlane instanceof Float64Array) || carrierPlane.length !== n) {
    throw new RangeError(`carrier plane must be a Float32Array or Float64Array of length ${n} (width*height)`);
  }
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const y = KR * r + KG * g + KB * b;
    const cb = CB_SCALE * (b - y) + CHROMA_OFFSET;
    let cr = CR_SCALE * (r - y) + CHROMA_OFFSET + carrierPlane[i];
    if (cr < 0) cr = 0;
    else if (cr > 255) cr = 255;
    const dr = (cr - CHROMA_OFFSET) / CR_SCALE;
    const db = (cb - CHROMA_OFFSET) / CB_SCALE;
    const R = y + dr;
    const B = y + db;
    const G = (y - KR * R - KB * B) / KG;
    out[p] = Math.round(R);
    out[p + 1] = Math.round(G);
    out[p + 2] = Math.round(B);
    out[p + 3] = rgba[p + 3];
  }
  return out;
}
