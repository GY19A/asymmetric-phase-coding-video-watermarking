// Input validation and the canonical frame plan for the APCVW browser demo.
// Pure functions. No DOM access, so they run under Node tests.

/** Largest accepted input file. */
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;
/** Length of the processed excerpt in seconds. */
export const EXCERPT_SECONDS = 4;
/** Sampling rate of the excerpt. */
export const SAMPLE_FPS = 30;
/** Number of sampled frames: 4 s at 30 fps. Equals one full G=4, K=30 group cycle. */
export const SAMPLE_COUNT = EXCERPT_SECONDS * SAMPLE_FPS;
/** Canonical frame size supported by the browser layout in this version. */
export const CANONICAL = Object.freeze({ width: 1024, height: 512 });

const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "webm", "mkv", "mov", "ogv", "ogg", "avi", "mpg", "mpeg", "ts", "3gp", "wmv",
]);

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

/**
 * Check a local file before it is opened. Only cheap metadata is inspected here.
 * Decoding problems are reported later by validateSourceMetadata.
 */
export function validateFileCandidate(file) {
  const size = Number(file?.size);
  const type = String(file?.type || "");
  const name = String(file?.name || "");
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, code: "empty", message: "The selected file is empty." };
  }
  if (size > MAX_INPUT_BYTES) {
    return {
      ok: false,
      code: "too-large",
      message: `The file is ${formatBytes(size)}. This demo accepts files up to 40 MB so that the excerpt can be decoded in the browser.`,
    };
  }
  const isVideoType = type.toLowerCase().startsWith("video/");
  const hasVideoExtension = VIDEO_EXTENSIONS.has(extensionOf(name));
  if (!isVideoType && !hasVideoExtension) {
    return {
      ok: false,
      code: "not-video",
      message: `"${name || "The file"}" does not look like a video file (type "${type || "unknown"}"). Choose an MP4, WebM, MOV, or MKV file.`,
    };
  }
  return { ok: true, code: "ok", message: `${name || "File"}, ${formatBytes(size)}.` };
}

/** Check a direct media URL typed by the user. Only http and https are fetched. */
export function validateUrlCandidate(text) {
  const s = String(text ?? "").trim();
  if (!s) return { ok: false, code: "empty", message: "Enter a direct video URL." };
  let url;
  try {
    url = new URL(s);
  } catch {
    return { ok: false, code: "invalid-url", message: "That is not a valid absolute URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "not-http", message: `Only http and https URLs are supported, not ${url.protocol}` };
  }
  return { ok: true, code: "ok", url: url.href };
}

/** Check decoded media metadata from a video element. */
export function validateSourceMetadata(meta, opts = {}) {
  const excerpt = opts.excerptSeconds ?? EXCERPT_SECONDS;
  const w = Number(meta?.videoWidth);
  const h = Number(meta?.videoHeight);
  const d = Number(meta?.duration);
  if (!(w > 0 && h > 0)) {
    return {
      ok: false,
      code: "unreadable",
      message: "The browser could not decode video frames from this source. It may be audio only, protected, or in a codec this browser does not support.",
    };
  }
  if (!Number.isFinite(d)) {
    return {
      ok: false,
      code: "unknown-duration",
      message: "The browser did not report a finite duration for this source, so a fixed excerpt cannot be selected.",
    };
  }
  if (d + 1e-3 < excerpt) {
    return {
      ok: false,
      code: "too-short",
      message: `This clip is ${d.toFixed(2)} s long. The demo processes a ${excerpt} s excerpt and needs at least ${excerpt} s.`,
    };
  }
  return { ok: true, code: "ok", message: `${w}x${h}, ${d.toFixed(2)} s.` };
}

/**
 * Aspect-preserving fit of a source frame into the canonical 1024x512 frame.
 * Bars are filled with black. The plan is shown to the user before Import.
 */
export function planCanonical(srcWidth, srcHeight, canonical = CANONICAL) {
  const w = Number(srcWidth);
  const h = Number(srcHeight);
  const scale = Math.min(canonical.width / w, canonical.height / h);
  const drawWidth = Math.round(w * scale);
  const drawHeight = Math.round(h * scale);
  const offsetX = Math.floor((canonical.width - drawWidth) / 2);
  const offsetY = Math.floor((canonical.height - drawHeight) / 2);
  let bars = "none";
  if (drawWidth < canonical.width - 1) bars = "sides";
  else if (drawHeight < canonical.height - 1) bars = "top-bottom";
  const barText = bars === "none" ? "no bars" : bars === "sides" ? "black bars at the sides" : "black bars at the top and bottom";
  const description =
    scale === 1 && bars === "none"
      ? `${w}x${h} matches the canonical 1024x512 frame. No scaling.`
      : `${w}x${h} scaled by ${scale.toFixed(3)} to ${drawWidth}x${drawHeight}, centered in ${canonical.width}x${canonical.height} with ${barText}.`;
  return { scale, drawWidth, drawHeight, offsetX, offsetY, bars, description };
}

export function clampExcerptStart(start, duration, excerpt = EXCERPT_SECONDS) {
  const s = Number.isFinite(start) ? start : 0;
  const max = Math.max(0, (Number.isFinite(duration) ? duration : excerpt) - excerpt);
  return Math.min(Math.max(0, s), max);
}

export function describeInterval(start, duration, excerpt = EXCERPT_SECONDS) {
  return `${start.toFixed(3)} s to ${(start + excerpt).toFixed(3)} s of ${duration.toFixed(3)} s`;
}

/** Map HTMLMediaElement MediaError codes to text a user can act on. */
export function mediaErrorMessage(code, detail = "") {
  const suffix = detail ? ` (${detail})` : "";
  switch (Number(code)) {
    case 1:
      return `Loading was aborted before any frames were decoded${suffix}.`;
    case 2:
      return `A network error stopped the browser from reading this source${suffix}.`;
    case 3:
      return `The browser started to decode this source and failed. The file may be corrupt or use an unsupported profile${suffix}.`;
    case 4:
      return `This source format or codec is not supported by this browser${suffix}.`;
    default:
      return `Unknown media error${suffix}.`;
  }
}
