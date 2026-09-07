/**
 * Per-frame evidence extraction and public verification.
 *
 * Extraction (identity geometry only): FFT of the Cr plane, sample each
 * layout bin F[ky, kx], rotate by exp(-i phase). This equals the reference
 * `correlate` at scale 1 and zero shift. For the group present in the frame
 * the carrier energy lands on the real axis, so
 *   score_g = sum(Re^2) / max(sum(Im^2), 1e-30)
 * identifies the group from content alone. The frame index is never used.
 * Whitening weights follow local_host_energy: the RMS magnitude of the 7x7
 * spectral neighborhood minus the 3x3 center, normalized by the group median,
 * and soft values are divided by that ratio (floored at 1e-6).
 *
 * Verification: per-frame argmax group, mode smoothing over K = 30, per-bit
 * accumulation of Re * weight for the smoothed group, hard threshold at 0,
 * RS decode, framing checks, Ed25519 verification over recovered bytes only.
 * @module evidence
 */
import { fft2d } from './fft.js';
import { crPlane, validateRgba } from './color.js';
import { assertLayoutMatches, LAYOUT_VERSION } from './layout.js';
import { decodePayloadBits } from './payload.js';

const NEIGHBOR_COUNT = 40;

/**
 * @typedef {object} GroupEvidence
 * @property {Float32Array} re real part of the rotated correlation per bin (soft value before whitening)
 * @property {Float32Array} im imaginary part per bin
 * @property {Float32Array} weights whitening weight per bin; soft value = re * weight
 */

/**
 * @typedef {object} EvidenceRow
 * @property {string} version 'apcvw-js-v1'
 * @property {Float64Array} scores per-group sum(Re^2)/sum(Im^2)
 * @property {GroupEvidence[]} groups one entry per layout group
 */

/**
 * Evidence for one RGBA frame.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {import('./layout.js').Layout} layout
 * @returns {EvidenceRow}
 */
export function extractFrameEvidence(rgba, width, height, layout) {
  validateRgba(rgba, width, height);
  assertLayoutMatches(layout, width, height);
  return evidenceFromPlane(crPlane(rgba, width, height), width, height, layout);
}

/**
 * Evidence for a Cr plane (or any real plane, for controlled tests).
 * @param {Float64Array|Float32Array} plane row-major, length width*height
 * @param {number} width
 * @param {number} height
 * @param {import('./layout.js').Layout} layout
 * @returns {EvidenceRow}
 */
export function evidenceFromPlane(plane, width, height, layout) {
  assertLayoutMatches(layout, width, height);
  if (!(plane instanceof Float64Array || plane instanceof Float32Array) || plane.length !== width * height) {
    throw new RangeError(`plane must be a Float64Array or Float32Array of length ${width * height}`);
  }
  const re = Float64Array.from(plane);
  const im = new Float64Array(re.length);
  fft2d(re, im, width, height, false);
  return evidenceFromSpectrum(re, im, layout);
}

function median(values) {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
}

function evidenceFromSpectrum(re, im, layout) {
  const W = layout.width;
  const H = layout.height;
  const scores = new Float64Array(layout.groupCount);
  const groups = [];
  for (let g = 0; g < layout.groupCount; g++) {
    const grp = layout.groups[g];
    const per = grp.ky.length;
    const cRe = new Float32Array(per);
    const cIm = new Float32Array(per);
    const hostEnergy = new Float64Array(per);
    const weights = new Float32Array(per);
    let sumRe2 = 0;
    let sumIm2 = 0;
    for (let j = 0; j < per; j++) {
      const ky = grp.ky[j];
      const kx = ((grp.kx[j] % W) + W) % W;
      const idx = ky * W + kx;
      const c = Math.cos(grp.phases[j]);
      const s = Math.sin(grp.phases[j]);
      const fr = re[idx];
      const fi = im[idx];
      const rr = fr * c + fi * s;
      const ii = fi * c - fr * s;
      cRe[j] = rr;
      cIm[j] = ii;
      sumRe2 += rr * rr;
      sumIm2 += ii * ii;
      let acc = 0;
      for (let dy = -3; dy <= 3; dy++) {
        const yy = (((ky + dy) % H) + H) % H;
        for (let dx = -3; dx <= 3; dx++) {
          if (dy >= -1 && dy <= 1 && dx >= -1 && dx <= 1) continue;
          const xx = (((kx + dx) % W) + W) % W;
          const q = yy * W + xx;
          acc += re[q] * re[q] + im[q] * im[q];
        }
      }
      hostEnergy[j] = Math.sqrt(acc / NEIGHBOR_COUNT);
    }
    scores[g] = sumRe2 / Math.max(sumIm2, 1e-30);
    const med = Math.max(median(hostEnergy), 1e-30);
    for (let j = 0; j < per; j++) weights[j] = 1 / Math.max(hostEnergy[j] / med, 1e-6);
    groups.push({ re: cRe, im: cIm, weights });
  }
  return { version: LAYOUT_VERSION, scores, groups };
}

/**
 * Reference smooth_groups: mode over a window of +-floor(K/2), ties to the lowest index.
 * @param {ArrayLike<number>} picked per-frame group decisions
 * @param {number} runLength
 * @returns {number[]}
 */
export function smoothGroups(picked, runLength) {
  const n = picked.length;
  if (runLength <= 1) return Array.from(picked);
  const half = Math.max(1, Math.floor(runLength / 2));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    const counts = new Map();
    for (let k = lo; k < hi; k++) counts.set(picked[k], (counts.get(picked[k]) || 0) + 1);
    let best = -1;
    let bestCount = -1;
    for (const [value, count] of counts) {
      if (count > bestCount || (count === bestCount && value < best)) {
        best = value;
        bestCount = count;
      }
    }
    out[i] = best;
  }
  return out;
}

function argmax(scores) {
  let best = 0;
  let bestValue = Number.isNaN(scores[0]) ? -Infinity : scores[0];
  for (let g = 1; g < scores.length; g++) {
    const v = Number.isNaN(scores[g]) ? -Infinity : scores[g];
    if (v > bestValue) {
      best = g;
      bestValue = v;
    }
  }
  return best;
}

function validateRow(row, layout, t) {
  const G = layout.groupCount;
  if (!row || !row.scores || row.scores.length !== G || !Array.isArray(row.groups) || row.groups.length !== G) {
    throw new RangeError(`evidence row ${t} does not match the layout (expected ${G} groups)`);
  }
  for (let g = 0; g < G; g++) {
    const per = layout.groups[g].ky.length;
    const ev = row.groups[g];
    if (!ev || !ev.re || ev.re.length !== per || !ev.weights || ev.weights.length !== per) {
      throw new RangeError(`evidence row ${t} group ${g} does not match the layout (expected ${per} bins)`);
    }
  }
}

/**
 * Public verification from collected evidence rows.
 * @param {EvidenceRow[]} evidenceRows rows in received order
 * @param {import('./layout.js').Layout} layout
 * @param {Uint8Array} publicKey 32 bytes
 * @returns {Promise<VerifyResult>}
 */
export async function verifyEvidence(evidenceRows, layout, publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) throw new TypeError('publicKey must be a 32-byte Uint8Array');
  if (!layout || layout.version !== LAYOUT_VERSION) throw new TypeError(`layout must be an ${LAYOUT_VERSION} layout object`);
  if (!Array.isArray(evidenceRows)) throw new TypeError('evidenceRows must be an array');
  const G = layout.groupCount;
  const bitCount = layout.bitCount;
  const groupCounts = new Array(G).fill(0);
  if (evidenceRows.length === 0) {
    return {
      verified: false, reason: 'no evidence rows', message: null, messageBytes: null, signature: null,
      correctedSymbols: null, extractedBits: new Uint8Array(bitCount), groupCounts, frameCount: 0,
      softSums: new Float64Array(bitCount),
    };
  }
  const picked = new Array(evidenceRows.length);
  for (let t = 0; t < evidenceRows.length; t++) {
    validateRow(evidenceRows[t], layout, t);
    picked[t] = argmax(evidenceRows[t].scores);
  }
  const smoothed = smoothGroups(picked, layout.runLength);
  const softSums = new Float64Array(bitCount);
  for (let t = 0; t < evidenceRows.length; t++) {
    const g = smoothed[t];
    groupCounts[g]++;
    const grp = layout.groups[g];
    const ev = evidenceRows[t].groups[g];
    for (let j = 0; j < grp.bits.length; j++) softSums[grp.bits[j]] += ev.re[j] * ev.weights[j];
  }
  const extractedBits = new Uint8Array(bitCount);
  for (let i = 0; i < bitCount; i++) extractedBits[i] = softSums[i] > 0 ? 1 : 0;
  const decoded = decodePayloadBits(extractedBits, publicKey);
  return { ...decoded, extractedBits, groupCounts, frameCount: evidenceRows.length, softSums };
}

/**
 * @typedef {object} VerifyResult
 * @property {boolean} verified
 * @property {string} reason 'ok' or the rejection reason
 * @property {string|null} message UTF-8 decoded recovered message, only when verified
 * @property {Uint8Array|null} messageBytes recovered message bytes, only when verified
 * @property {Uint8Array|null} signature recovered 64-byte signature, only when verified
 * @property {number|null} correctedSymbols RS symbols corrected, null when RS decoding failed
 * @property {Uint8Array} extractedBits hard decisions, length layout.bitCount
 * @property {number[]} groupCounts frames assigned to each group after smoothing
 * @property {number} frameCount
 * @property {Float64Array} softSums accumulated whitened soft values per bit (diagnostic)
 */
