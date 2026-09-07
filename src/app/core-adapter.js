// Thin adapter over the real core library in src/lib/index.js.
// It does not implement any algorithm. It resolves the documented export
// names, fails loudly when one is missing, and normalizes return shapes for
// display. Both the worker and the main thread import it.
import * as core from "../lib/index.js";

/** Documented roles and the export names accepted for each, in priority order. */
const ROLE_NAMES = Object.freeze({
  generateIdentity: ["generateIdentity", "generateKeyPair"],
  createPayload: ["createPayload", "encodePayload"],
  createLayout: ["createLayout", "buildLayout"],
  createCarriers: ["createCarriers", "buildCarriers"],
  embedFrame: ["embedFrame"],
  extractFrameEvidence: ["extractFrameEvidence", "extractEvidence"],
  verifyEvidence: ["verifyEvidence"],
  spectrumPreview: ["spectrumPreview", "spectrum"],
});

export const ROLES = Object.freeze(Object.keys(ROLE_NAMES));

/** The raw library namespace, exposed for the widget and the code pane. */
export const sdk = core;

function resolve(role) {
  for (const name of ROLE_NAMES[role]) {
    if (typeof core[name] === "function") return name;
  }
  return null;
}

/** Map of role to the export name that actually exists, or null. */
export function resolvedNames() {
  const out = {};
  for (const role of ROLES) out[role] = resolve(role);
  return out;
}

export function availableApi() {
  const out = {};
  for (const role of ROLES) out[role] = resolve(role) !== null;
  return out;
}

function need(role) {
  const name = resolve(role);
  if (!name) {
    throw new Error(`The core library does not export ${role}(). The UI cannot substitute a mock. See docs/API.md.`);
  }
  return core[name];
}

export const LAYOUT_VERSION = typeof core.LAYOUT_VERSION === "string" ? core.LAYOUT_VERSION : "apcvw-js-v1";
export const CORE_MAX_MESSAGE_BYTES = Number.isInteger(core.MAX_MESSAGE_BYTES) ? core.MAX_MESSAGE_BYTES : null;
export const CORE_VERSION = typeof core.VERSION === "string" ? core.VERSION : null;
export const CORE_DEFAULT_MESSAGE = typeof core.DEFAULT_SAMPLE_MESSAGE === "string" ? core.DEFAULT_SAMPLE_MESSAGE : null;

/** Accept [lo, hi] or {lo, hi} and return {lo, hi} or null. */
export function normalizeBand(band) {
  if (Array.isArray(band) && band.length >= 2 && Number.isFinite(band[0]) && Number.isFinite(band[1])) return { lo: band[0], hi: band[1] };
  if (band && Number.isFinite(band.lo) && Number.isFinite(band.hi)) return { lo: band.lo, hi: band.hi };
  return null;
}

export async function generateIdentity() {
  const id = await need("generateIdentity")();
  if (!(id?.publicKey instanceof Uint8Array) || !(id?.privateKey instanceof Uint8Array)) {
    throw new Error("generateIdentity() did not return Uint8Array publicKey and privateKey.");
  }
  return id;
}

export async function createPayload(message, privateKey) {
  const p = await need("createPayload")(message, privateKey);
  if (!(p?.bits instanceof Uint8Array) || !(p?.signature instanceof Uint8Array)) {
    throw new Error("createPayload() did not return Uint8Array bits and signature.");
  }
  return p;
}

export async function createLayout(params) {
  return need("createLayout")(params);
}

export async function createCarriers(layout, bits, psnrTarget) {
  const c = await need("createCarriers")(layout, bits, psnrTarget);
  return normalizePlanes(c);
}

export function embedFrame(rgba, width, height, carrier) {
  const out = need("embedFrame")(rgba, width, height, carrier);
  if (out instanceof Uint8ClampedArray) return out;
  if (out instanceof Uint8Array) return new Uint8ClampedArray(out.buffer, out.byteOffset, out.length);
  if (out?.data instanceof Uint8ClampedArray) return out.data;
  throw new Error("embedFrame() did not return an RGBA byte array.");
}

export function extractFrameEvidence(rgba, width, height, layout) {
  return need("extractFrameEvidence")(rgba, width, height, layout);
}

export async function verifyEvidence(rows, layout, publicKey) {
  return need("verifyEvidence")(rows, layout, publicKey);
}

export function spectrumPreview(rgba, width, height, options) {
  return need("spectrumPreview")(rgba, width, height, options);
}

/** Accept an array of planes or an object carrying one, and return Float32Array[]. */
function normalizePlanes(c) {
  const planes = Array.isArray(c) ? c : Array.isArray(c?.planes) ? c.planes : Array.isArray(c?.carriers) ? c.carriers : null;
  if (!planes || planes.length === 0) throw new Error("createCarriers() did not return an array of carrier planes.");
  const out = planes.map((p) => {
    if (p instanceof Float32Array) return p;
    if (p instanceof Float64Array) return Float32Array.from(p);
    if (p?.data instanceof Float32Array) return p.data;
    if (p?.plane instanceof Float32Array) return p.plane;
    throw new Error("A carrier plane was not a Float32Array.");
  });
  out.meta = typeof c === "object" && !Array.isArray(c) ? { alpha: c.alpha, psnrTarget: c.psnrTarget } : {};
  return out;
}

function flattenBins(bins) {
  if (!bins) return null;
  if (ArrayBuffer.isView(bins)) return Int32Array.from(bins);
  if (Array.isArray(bins)) {
    if (bins.length === 0) return new Int32Array(0);
    if (Array.isArray(bins[0]) || ArrayBuffer.isView(bins[0])) {
      const out = new Int32Array(bins.length * 2);
      for (let i = 0; i < bins.length; i++) {
        out[2 * i] = bins[i][0];
        out[2 * i + 1] = bins[i][1];
      }
      return out;
    }
    if (typeof bins[0] === "number") return Int32Array.from(bins);
    if (typeof bins[0] === "object" && "ky" in bins[0]) {
      const out = new Int32Array(bins.length * 2);
      for (let i = 0; i < bins.length; i++) {
        out[2 * i] = bins[i].ky;
        out[2 * i + 1] = bins[i].kx;
      }
      return out;
    }
  }
  if (bins.ky && bins.kx) {
    const n = bins.ky.length;
    const out = new Int32Array(n * 2);
    for (let i = 0; i < n; i++) {
      out[2 * i] = bins.ky[i];
      out[2 * i + 1] = bins.kx[i];
    }
    return out;
  }
  return null;
}

/**
 * A display summary of a layout. Bin positions are included when the core
 * exposes them so the inspector can draw the actual carrier bins. Nothing here
 * is used for verification.
 */
export function layoutSummary(layout) {
  const groups = Array.isArray(layout?.groups) ? layout.groups : Array.isArray(layout?.layouts) ? layout.layouts : null;
  const groupBins = groups ? groups.map((g) => flattenBins(g?.bins ?? g)) : null;
  const binsPerGroup = groupBins ? groupBins.map((f) => (f ? f.length / 2 : null)) : null;
  return {
    version: layout?.version ?? layout?.layoutVersion ?? LAYOUT_VERSION,
    width: layout?.width ?? null,
    height: layout?.height ?? null,
    nonce: layout?.nonce ?? null,
    bitCount: layout?.bitCount ?? null,
    groups: groups ? groups.length : (layout?.groupCount ?? null),
    runLength: layout?.runLength ?? layout?.K ?? null,
    band: normalizeBand(layout?.band) ?? (Number.isFinite(layout?.bandLow) ? { lo: layout.bandLow, hi: layout.bandHigh } : null),
    poolSize: Number.isInteger(layout?.poolSize) ? layout.poolSize : (layout?.pool ? flattenBins(layout.pool)?.length / 2 : null),
    binsPerGroup,
    bins: groupBins,
  };
}

function argmax(arr) {
  let best = -1;
  let bestV = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > bestV) {
      bestV = arr[i];
      best = i;
    }
  }
  return best;
}

/** A display summary of one evidence row: the correlation-based group guess and its scores. */
export function rowSummary(row) {
  if (!row || typeof row !== "object") return { group: null, scores: null };
  const scores = row.groupScores ?? row.scores ?? row.groupEnergy ?? null;
  const arr = scores && typeof scores.length === "number" ? Array.from(scores) : null;
  let group = Number.isInteger(row.group) ? row.group : Number.isInteger(row.bestGroup) ? row.bestGroup : null;
  if (group === null && arr) group = argmax(arr);
  return { group, scores: arr };
}

/** Reduce a library verify result to clone-safe fields. Nothing is invented. */
export function sanitizeVerifyResult(r) {
  if (!r || typeof r !== "object") return { verified: false, reason: "verifyEvidence() returned no result object." };
  const bytes = (v) => (v instanceof Uint8Array ? v : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : undefined);
  return {
    verified: r.verified === true,
    reason: typeof r.reason === "string" ? r.reason : undefined,
    message: typeof r.message === "string" ? r.message : undefined,
    messageBytes: bytes(r.messageBytes),
    signature: bytes(r.signature),
    correctedSymbols: Number.isInteger(r.correctedSymbols) ? r.correctedSymbols : r.correctedSymbols === null ? null : undefined,
    extractedBits: bytes(r.extractedBits),
    groupCounts: r.groupCounts && typeof r.groupCounts.length === "number" ? Array.from(r.groupCounts) : undefined,
    bitAccuracy: Number.isFinite(r.bitAccuracy) ? r.bitAccuracy : undefined,
  };
}
