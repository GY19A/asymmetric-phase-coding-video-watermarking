// Numerical worker for the APCVW browser demo.
// All pixel work runs here: layout, carriers, embedding, evidence extraction,
// verification, spectrum previews, and residual images. The worker keeps
// bounded caches (layouts, carrier sets, evidence rows) and nothing else.
// Progress is reported by the caller from real per-frame round trips.
import * as adapter from "./app/core-adapter.js";

const layouts = new Map();
const carrierSets = new Map();
const evidenceSets = new Map();
const MAX_CARRIER_SETS = 6;

function hashBytes(bytes) {
  // FNV-1a over the payload bits, used only as a cache key.
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function getLayout(key) {
  const layout = layouts.get(key);
  if (!layout) throw new Error(`Layout ${key} is not cached in the worker. Create it first.`);
  return layout;
}

function rms(plane) {
  let acc = 0;
  for (let i = 0; i < plane.length; i++) acc += plane[i] * plane[i];
  return Math.sqrt(acc / Math.max(1, plane.length));
}

function meanOf(plane) {
  let acc = 0;
  for (let i = 0; i < plane.length; i++) acc += plane[i];
  return acc / Math.max(1, plane.length);
}

/** Convert whatever spectrumPreview returned into an RGBA image plus scale info. */
function normalizeSpectrum(spec, width, height) {
  if (spec?.data instanceof Uint8ClampedArray && Number.isInteger(spec.width) && Number.isInteger(spec.height)) {
    return { rgba: spec.data, width: spec.width, height: spec.height, min: spec.min ?? null, max: spec.max ?? null, scale: spec.scale ?? "log magnitude, as returned by the core", centered: spec.centered ?? true };
  }
  if (spec instanceof Uint8ClampedArray && spec.length === width * height * 4) {
    return { rgba: spec, width, height, min: null, max: null, scale: "RGBA as returned by the core", centered: true };
  }
  const values = spec instanceof Float32Array || spec instanceof Float64Array ? spec : spec?.values ?? spec?.magnitude ?? spec?.logMagnitude ?? null;
  if (values && typeof values.length === "number") {
    const w = spec?.width ?? width;
    const h = spec?.height ?? height;
    if (values.length !== w * h) throw new Error("spectrumPreview() returned a numeric array whose length does not match width*height.");
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min || 1;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < values.length; i++) {
      const t = Number.isFinite(values[i]) ? (values[i] - min) / range : 0;
      const g = Math.round(255 * t);
      rgba[4 * i] = g;
      rgba[4 * i + 1] = g;
      rgba[4 * i + 2] = g;
      rgba[4 * i + 3] = 255;
    }
    return { rgba, width: w, height: h, min, max, scale: "numeric values from the core, linearly mapped from min to max", centered: spec?.centered ?? true };
  }
  throw new Error("spectrumPreview() returned a shape the worker does not understand.");
}

async function handle(msg) {
  switch (msg.type) {
    case "ping":
      return { type: "pong", api: adapter.availableApi(), names: adapter.resolvedNames() };

    case "layout": {
      const { width, height, nonce, bitCount } = msg;
      const key = `${width}x${height}|${nonce}|${bitCount}`;
      if (!layouts.has(key)) {
        const layout = await adapter.createLayout({ width, height, nonce, bitCount });
        layouts.set(key, layout);
      }
      return { type: "layout", key, summary: adapter.layoutSummary(layouts.get(key)) };
    }

    case "carriers": {
      const { layoutKey, psnr } = msg;
      const bits = new Uint8Array(msg.bits);
      const layout = getLayout(layoutKey);
      const setKey = `${layoutKey}|${psnr}|${hashBytes(bits)}`;
      if (!carrierSets.has(setKey)) {
        const planes = await adapter.createCarriers(layout, bits, psnr);
        if (carrierSets.size >= MAX_CARRIER_SETS) {
          const oldest = carrierSets.keys().next().value;
          carrierSets.delete(oldest);
        }
        carrierSets.set(setKey, planes);
      }
      const planes = carrierSets.get(setKey);
      return {
        type: "carriers",
        setKey,
        stats: {
          planes: planes.length,
          length: planes[0]?.length ?? 0,
          rms: planes.map((p) => rms(p)),
          mean: planes.map((p) => meanOf(p)),
          alpha: planes.meta?.alpha ?? null,
        },
      };
    }

    case "embed": {
      const planes = carrierSets.get(msg.setKey);
      if (!planes) throw new Error("Carrier set is not cached in the worker.");
      const plane = planes[msg.group];
      if (!plane) throw new Error(`No carrier plane for group ${msg.group}.`);
      const src = new Uint8ClampedArray(msg.rgba);
      const out = adapter.embedFrame(src, msg.width, msg.height, plane);
      const buffer = out.buffer === msg.rgba ? out.slice().buffer : out.buffer;
      return { type: "embedded", index: msg.index, group: msg.group, rgba: buffer, transfer: [buffer] };
    }

    case "extract": {
      const layout = getLayout(msg.layoutKey);
      const rgba = new Uint8ClampedArray(msg.rgba);
      const row = adapter.extractFrameEvidence(rgba, msg.width, msg.height, layout);
      let set = evidenceSets.get(msg.sessionId);
      if (!set) {
        set = { rows: [], layoutKey: msg.layoutKey, summaries: [] };
        evidenceSets.set(msg.sessionId, set);
      }
      set.rows.push(row);
      const summary = adapter.rowSummary(row);
      set.summaries.push(summary.group);
      return { type: "evidence", sessionId: msg.sessionId, index: msg.index, count: set.rows.length, summary };
    }

    case "verify": {
      const set = evidenceSets.get(msg.sessionId);
      if (!set || set.rows.length === 0) throw new Error("No evidence rows were collected for this verification session.");
      const layout = getLayout(msg.layoutKey ?? set.layoutKey);
      const publicKey = new Uint8Array(msg.publicKey);
      const raw = await adapter.verifyEvidence(set.rows, layout, publicKey);
      return {
        type: "verified",
        sessionId: msg.sessionId,
        rowCount: set.rows.length,
        frameGroups: set.summaries.slice(),
        result: adapter.sanitizeVerifyResult(raw),
      };
    }

    case "discard": {
      evidenceSets.delete(msg.sessionId);
      return { type: "discarded", sessionId: msg.sessionId };
    }

    case "spectrum": {
      const rgba = new Uint8ClampedArray(msg.rgba);
      const spec = await adapter.spectrumPreview(rgba, msg.width, msg.height, msg.options ?? {});
      const image = normalizeSpectrum(spec, msg.width, msg.height);
      return { type: "spectrum", label: msg.label ?? null, image: { width: image.width, height: image.height, rgba: image.rgba.buffer }, min: image.min, max: image.max, scale: image.scale, centered: image.centered, transfer: [image.rgba.buffer] };
    }

    case "residual": {
      // Plain pixel arithmetic for display: (a - b) * gain + 128 per RGB channel.
      // Also reports measured PSNR between the two frames over RGB.
      const a = new Uint8ClampedArray(msg.a);
      const b = new Uint8ClampedArray(msg.b);
      if (a.length !== b.length) throw new Error("Residual inputs have different sizes.");
      const gain = Number.isFinite(msg.gain) ? msg.gain : 16;
      const out = new Uint8ClampedArray(a.length);
      let sq = 0;
      let maxAbs = 0;
      let sumAbs = 0;
      let n = 0;
      for (let i = 0; i < a.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const d = a[i + c] - b[i + c];
          out[i + c] = 128 + d * gain;
          sq += d * d;
          const ad = Math.abs(d);
          if (ad > maxAbs) maxAbs = ad;
          sumAbs += ad;
          n++;
        }
        out[i + 3] = 255;
      }
      const mse = sq / Math.max(1, n);
      const psnr = mse > 0 ? 10 * Math.log10((255 * 255) / mse) : Infinity;
      return { type: "residual", rgba: out.buffer, gain, stats: { psnr, maxAbs, meanAbs: sumAbs / Math.max(1, n), mse }, transfer: [out.buffer] };
    }

    default:
      throw new Error(`Unknown worker message type: ${msg.type}`);
  }
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    const reply = await handle(msg);
    const { transfer = [], ...rest } = reply;
    self.postMessage({ id: msg.id, ...rest }, transfer);
  } catch (err) {
    self.postMessage({ id: msg.id, type: "error", message: err?.message ?? String(err), stack: err?.stack ?? null });
  }
};

self.postMessage({
  type: "ready",
  api: adapter.availableApi(),
  names: adapter.resolvedNames(),
  layoutVersion: adapter.LAYOUT_VERSION,
  coreVersion: adapter.CORE_VERSION,
  maxMessageBytes: adapter.CORE_MAX_MESSAGE_BYTES,
});
