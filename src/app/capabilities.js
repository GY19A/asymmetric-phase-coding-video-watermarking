// Runtime capability detection for the browser demo.
// detectCapabilities takes an injected environment so it is testable in Node.

/** Recorder candidates in order of preference. WebM H.264 is never requested. */
export const RECORDER_CANDIDATES = Object.freeze([
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4",
]);

export function chooseRecorderMime(isTypeSupported) {
  if (typeof isTypeSupported !== "function") return null;
  for (const candidate of RECORDER_CANDIDATES) {
    try {
      if (isTypeSupported(candidate)) return candidate;
    } catch {
      // A throwing implementation counts as unsupported for that candidate.
    }
  }
  return null;
}

const CONTAINERS = {
  "video/webm": "WebM",
  "video/mp4": "MP4",
  "video/x-matroska": "Matroska",
  "video/quicktime": "QuickTime",
};

const AUDIO_TOKENS = /^(opus|vorbis|mp4a|aac|flac|pcm)/i;

function codecLabel(token) {
  const t = token.toLowerCase();
  if (t === "vp9" || t.startsWith("vp09")) return "VP9";
  if (t === "vp8" || t.startsWith("vp08")) return "VP8";
  if (t === "av1" || t.startsWith("av01")) return "AV1";
  if (t === "h264" || t.startsWith("avc1") || t.startsWith("avc3")) return `H.264 (${token})`;
  if (t === "h265" || t.startsWith("hev1") || t.startsWith("hvc1")) return `H.265 (${token})`;
  return token;
}

/** Describe a MIME type truthfully. Unknown codecs are reported as not disclosed. */
export function describeMime(mime) {
  if (!mime || typeof mime !== "string") return { container: "unknown", codec: "unknown" };
  const [type, ...params] = mime.split(";").map((s) => s.trim());
  const container = CONTAINERS[type.toLowerCase()] ?? (type || "unknown");
  let codec = "not disclosed by the recorder";
  for (const p of params) {
    const m = /^codecs\s*=\s*"?([^"]*)"?$/i.exec(p);
    if (!m) continue;
    const tokens = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const video = tokens.find((t) => !AUDIO_TOKENS.test(t));
    if (video) codec = codecLabel(video);
  }
  return { container, codec };
}

/**
 * Detect what this environment can do. `env` is a plain object so tests can
 * inject it. Use readBrowserEnvironment() at runtime.
 */
export function detectCapabilities(env) {
  const blockers = [];
  const warnings = [];
  const hasRecorder = !!env.MediaRecorder && typeof env.MediaRecorder.isTypeSupported === "function";
  const mime = hasRecorder ? chooseRecorderMime(env.MediaRecorder.isTypeSupported) : null;

  if (!hasRecorder) {
    blockers.push("MediaRecorder is not available in this browser, so no marked video can be encoded. There is no fallback output.");
  } else if (!mime) {
    blockers.push("MediaRecorder supports none of the candidate formats (WebM VP9, WebM VP8, WebM, MP4). No output can be encoded.");
  }
  if (!env.canvasCaptureStream) blockers.push("canvas.captureStream is not available, so marked frames cannot reach the recorder.");
  if (!env.Worker) blockers.push("Web Workers are not available. Numerical work runs in a worker.");
  if (!env.getRandomValues) blockers.push("crypto.getRandomValues is not available. Identities need cryptographic randomness.");
  if (!env.videoFrameCallback) {
    warnings.push(
      "requestVideoFrameCallback is not available. Frame capture falls back to animation-frame polling, which may duplicate or miss frames.",
    );
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    recorder: { supported: hasRecorder, mime },
    captureStream: !!env.canvasCaptureStream,
    videoFrameCallback: !!env.videoFrameCallback,
    worker: !!env.Worker,
    randomness: !!env.getRandomValues,
    secureContext: !!env.isSecureContext,
    subtleCrypto: !!env.subtleCrypto,
  };
}

/** Build the environment object from real browser globals. */
export function readBrowserEnvironment(g = globalThis) {
  const canvasProto = g.HTMLCanvasElement?.prototype;
  const videoProto = g.HTMLVideoElement?.prototype;
  return {
    MediaRecorder: g.MediaRecorder,
    canvasCaptureStream: !!(canvasProto && typeof canvasProto.captureStream === "function"),
    videoFrameCallback: !!(videoProto && typeof videoProto.requestVideoFrameCallback === "function"),
    getRandomValues: !!(g.crypto && typeof g.crypto.getRandomValues === "function"),
    Worker: typeof g.Worker === "function",
    isSecureContext: !!g.isSecureContext,
    subtleCrypto: !!(g.crypto && g.crypto.subtle),
  };
}
