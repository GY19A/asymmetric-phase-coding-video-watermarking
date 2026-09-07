// Browser media pipeline for the APCVW demo.
// Native HTMLVideoElement decoding, canvas letterboxing into the canonical
// 1024x512 frame, a bounded lossless frame store, paced canvas capture into
// MediaRecorder, and frame-by-frame readback of a produced Blob. No fake
// output paths: when a capability is missing, the caller sees an error.
import {
  CANONICAL,
  EXCERPT_SECONDS,
  SAMPLE_FPS,
  SAMPLE_COUNT,
  MAX_INPUT_BYTES,
  planCanonical,
  validateSourceMetadata,
  mediaErrorMessage,
  formatBytes,
} from "./app/validation.js";
import { sampleSlotFor, fillMissingSlots, samplingSummary, frameIntervalMs } from "./app/sampling.js";
import { CancelledError } from "./app/worker-client.js";

export { CancelledError };

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new CancelledError();
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    function onAbort() {
      clearTimeout(t);
      reject(new CancelledError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait for one of `okEvents` on `target`. Rejects on `errEvents`, abort, or timeout. */
export function waitForEvent(target, okEvents, errEvents = [], { signal, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      for (const ev of okEvents) target.removeEventListener(ev, onOk);
      for (const ev of errEvents) target.removeEventListener(ev, onErr);
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    };
    const onOk = (e) => {
      cleanup();
      resolve(e);
    };
    const onErr = (e) => {
      cleanup();
      const mediaError = target.error;
      if (mediaError && typeof mediaError.code === "number") {
        reject(Object.assign(new Error(mediaErrorMessage(mediaError.code, mediaError.message)), { code: "media-error", mediaCode: mediaError.code }));
      } else {
        reject(e?.error instanceof Error ? e.error : new Error(`${e?.type ?? "error"} event`));
      }
    };
    const onAbort = () => {
      cleanup();
      reject(new CancelledError());
    };
    if (signal?.aborted) return onAbort();
    for (const ev of okEvents) target.addEventListener(ev, onOk);
    for (const ev of errEvents) target.addEventListener(ev, onErr);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${okEvents.join("/")}.`));
      }, timeoutMs);
    }
  });
}

/** Tracks object URLs so that a reset can revoke every one of them. */
export class UrlRegistry {
  constructor() {
    this.urls = new Set();
  }
  create(blob) {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  }
  revoke(url) {
    if (url && this.urls.has(url)) {
      URL.revokeObjectURL(url);
      this.urls.delete(url);
    }
  }
  revokeAll() {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}

export function createHiddenVideo(host) {
  const v = document.createElement("video");
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute("playsinline", "");
  v.setAttribute("muted", "");
  v.preload = "auto";
  v.crossOrigin = "anonymous";
  v.disableRemotePlayback = true;
  v.className = "apcvw-hidden-video";
  host.appendChild(v);
  return v;
}

export function disposeVideo(video) {
  if (!video) return;
  try {
    video.pause();
  } catch {
    // ignore
  }
  video.removeAttribute("src");
  try {
    video.load();
  } catch {
    // ignore
  }
  video.remove();
}

/**
 * Fetch a direct media URL through the browser with CORS. There is no proxy.
 * Enforces the 40 MB cap while streaming so a large file is abandoned early.
 */
export async function fetchMediaBlob(url, { signal, maxBytes = MAX_INPUT_BYTES, onProgress } = {}) {
  let res;
  try {
    res = await fetch(url, { mode: "cors", credentials: "omit", signal, cache: "no-store" });
  } catch (err) {
    if (err?.name === "AbortError") throw new CancelledError();
    throw new Error(
      "The browser could not fetch this URL. A direct media URL must allow cross-origin access (CORS headers) and be reachable from this device. " +
        "Streaming-site pages and protected media do not work. This demo has no server proxy.",
    );
  }
  if (!res.ok) throw new Error(`The server answered ${res.status} ${res.statusText || ""}.`.trim());
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`The resource is ${formatBytes(declared)}. This demo accepts files up to 40 MB.`);
  }
  const type = res.headers.get("content-type") || "";
  if (type && !/^video\//i.test(type) && !/octet-stream/i.test(type)) {
    throw new Error(`The URL returned "${type}", not a video resource. Use a direct link to a video file.`);
  }
  if (!res.body || typeof res.body.getReader !== "function") {
    const blob = await res.blob();
    if (blob.size > maxBytes) throw new Error(`The resource is ${formatBytes(blob.size)}. This demo accepts files up to 40 MB.`);
    return blob;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new Error(`The download passed 40 MB and was stopped. This demo accepts files up to 40 MB.`);
    }
    chunks.push(value);
    onProgress?.(received, Number.isFinite(declared) ? declared : null);
  }
  return new Blob(chunks, { type: type || "video/mp4" });
}

/**
 * Open a source in a hidden video element and read its metadata.
 * With requireExcerpt (default) the source must have a finite duration of at
 * least 4 s. Verification inputs use requireExcerpt: false because a
 * MediaRecorder WebM may report an infinite duration until it is played.
 */
export async function openVideoSource(src, { host, signal, timeoutMs = 30000, requireExcerpt = true } = {}) {
  const video = createHiddenVideo(host);
  video.src = src;
  try {
    await waitForEvent(video, ["loadedmetadata"], ["error"], { signal, timeoutMs });
    // Some browsers report dimensions only after the first frame is ready.
    if (!(video.videoWidth > 0) && video.readyState < 2) {
      await waitForEvent(video, ["loadeddata"], ["error"], { signal, timeoutMs: 10000 }).catch(() => {});
    }
  } catch (err) {
    disposeVideo(video);
    throw err;
  }
  const meta = { duration: video.duration, videoWidth: video.videoWidth, videoHeight: video.videoHeight };
  if (requireExcerpt) {
    const check = validateSourceMetadata(meta);
    if (!check.ok) {
      disposeVideo(video);
      throw Object.assign(new Error(check.message), { code: check.code });
    }
  } else if (!(meta.videoWidth > 0 && meta.videoHeight > 0)) {
    disposeVideo(video);
    throw Object.assign(new Error(validateSourceMetadata({ ...meta, duration: 1 }).message), { code: "unreadable" });
  }
  return { video, meta, plan: planCanonical(meta.videoWidth, meta.videoHeight) };
}

export function drawLetterboxed(ctx, source, plan, canonical = CANONICAL) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canonical.width, canonical.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, plan.offsetX, plan.offsetY, plan.drawWidth, plan.drawHeight);
}

export function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob returned null"))), type);
  });
}

/**
 * Bounded lossless store of the sampled excerpt: one PNG Blob per 30 fps slot
 * plus the duplication plan for slots no source frame landed in. About 60 to
 * 100 MB of Blob storage for 120 frames, instead of 250 MB of raw RGBA.
 */
export class FrameStore {
  constructor(width = CANONICAL.width, height = CANONICAL.height, count = SAMPLE_COUNT) {
    this.width = width;
    this.height = height;
    this.count = count;
    this.blobs = new Array(count).fill(null);
    this.filled = new Array(count).fill(false);
    this.times = new Array(count).fill(null);
    this.sourceSlot = null;
    this.summary = null;
    this.bytes = 0;
    this.captured = 0;
  }

  set(slot, blob, mediaTime) {
    if (this.filled[slot]) return;
    this.blobs[slot] = blob;
    this.filled[slot] = true;
    this.times[slot] = mediaTime;
    this.bytes += blob.size;
    this.captured++;
  }

  finalize() {
    const plan = fillMissingSlots(this.filled);
    this.sourceSlot = plan.sourceSlot;
    this.summary = samplingSummary(this.filled);
    return this.summary;
  }

  /** RGBA of output frame `index` drawn through `ctx` (a canonical-size 2D context). */
  async getImageData(index, ctx) {
    if (!this.sourceSlot) throw new Error("FrameStore.finalize() has not run.");
    const slot = this.sourceSlot[index];
    const blob = this.blobs[slot];
    if (!blob) throw new Error(`No frame stored for slot ${slot}.`);
    const bitmap = await decodeBlob(blob);
    ctx.drawImage(bitmap, 0, 0);
    if (typeof bitmap.close === "function") bitmap.close();
    return ctx.getImageData(0, 0, this.width, this.height);
  }

  dispose() {
    this.blobs.fill(null);
    this.filled.fill(false);
    this.bytes = 0;
    this.captured = 0;
    this.sourceSlot = null;
  }
}

async function decodeBlob(blob) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" }).catch(() => createImageBitmap(blob));
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "sync";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Play `video` from its current position and deliver every presented frame.
 * `grab(video, mediaTime, index)` runs synchronously in the frame callback and
 * returns an item or null to skip. `process(item)` may be async. Items queue
 * up to `maxQueue`; playback pauses while the queue is full and resumes when
 * it drains, so no frame is skipped and memory stays bounded. Stops when
 * `shouldStop(mediaTime)` is true or the video ends.
 */
export function captureFrames(video, { grab, process, shouldStop, signal, maxQueue = 3 } = {}) {
  const hasRvfc = typeof video.requestVideoFrameCallback === "function";
  return new Promise((resolve, reject) => {
    const queue = [];
    let stopped = false;
    let stopRequested = false;
    let ended = false;
    let pausedForBackpressure = false;
    let processing = false;
    let lastTime = -1;
    let grabbed = 0;
    let processed = 0;
    let rafId = 0;
    let rvfcId = 0;

    const cleanup = () => {
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (rafId) cancelAnimationFrame(rafId);
      if (rvfcId && typeof video.cancelVideoFrameCallback === "function") video.cancelVideoFrameCallback(rvfcId);
    };
    const finish = (err) => {
      if (stopped) return;
      stopped = true;
      cleanup();
      try {
        video.pause();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve({ frames: processed, grabbed, lastTime, method: hasRvfc ? "requestVideoFrameCallback" : "requestAnimationFrame" });
    };
    const onEnded = () => {
      ended = true;
      if (!processing && queue.length === 0) finish();
    };
    const onError = () => finish(new Error(mediaErrorMessage(video.error?.code, video.error?.message)));
    const onAbort = () => finish(new CancelledError());
    const ignoreInterrupt = (e) => {
      if (e?.name !== "AbortError" && !stopped) finish(new Error(`Playback could not continue: ${e?.message ?? e}`));
    };

    const pump = async () => {
      if (processing) return;
      processing = true;
      while (queue.length && !stopped) {
        const item = queue.shift();
        try {
          await process(item);
          processed++;
        } catch (err) {
          processing = false;
          return finish(err);
        }
        if (pausedForBackpressure && queue.length <= 1 && !stopRequested && !ended && !stopped) {
          pausedForBackpressure = false;
          video.play().catch(ignoreInterrupt);
        }
      }
      processing = false;
      if ((stopRequested || ended) && queue.length === 0) finish();
    };

    const onFrame = (mediaTime) => {
      if (stopped || stopRequested) return;
      if (mediaTime !== lastTime) {
        lastTime = mediaTime;
        let item = null;
        try {
          item = grab(video, mediaTime, grabbed);
        } catch (err) {
          return finish(err);
        }
        if (item) {
          grabbed++;
          queue.push(item);
          pump();
        }
        if (shouldStop?.(mediaTime)) {
          stopRequested = true;
          try {
            video.pause();
          } catch {
            // ignore
          }
          if (!processing && queue.length === 0) finish();
          return;
        }
        if (queue.length >= maxQueue && !video.paused) {
          pausedForBackpressure = true;
          video.pause();
        }
      }
      schedule();
    };

    const schedule = () => {
      if (stopped || stopRequested) return;
      if (hasRvfc) {
        rvfcId = video.requestVideoFrameCallback((_now, meta) => onFrame(meta.mediaTime));
      } else {
        rafId = requestAnimationFrame(() => {
          if (!video.paused && !video.seeking) onFrame(video.currentTime);
          else schedule();
        });
      }
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    schedule();
    video.play().catch((e) => {
      if (e?.name === "AbortError") return;
      finish(new Error(`Playback could not start: ${e?.message ?? e}. Keep this tab visible while the demo runs.`));
    });
  });
}

/**
 * Sample the 4 s excerpt starting at `start` into a FrameStore of 120 slots.
 * The hidden video is seeked once, then played while frames are captured.
 */
export async function sampleExcerpt(video, { start, plan, canvas, signal, onProgress } = {}) {
  const store = new FrameStore();
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const end = start + EXCERPT_SECONDS;
  video.currentTime = start;
  await waitForEvent(video, ["seeked"], ["error"], { signal, timeoutMs: 30000 });

  const grab = (v, t) => {
    const slot = sampleSlotFor(t, start, SAMPLE_FPS, SAMPLE_COUNT);
    if (slot < 0 || store.filled[slot] || pendingSlots.has(slot)) return null;
    pendingSlots.add(slot);
    drawLetterboxed(ctx, v, plan);
    return { slot, t, promise: canvasToBlob(canvas, "image/png") };
  };
  const pendingSlots = new Set();
  const process = async (item) => {
    const blob = await item.promise;
    pendingSlots.delete(item.slot);
    store.set(item.slot, blob, item.t);
    onProgress?.({ stage: "sampling", done: store.captured, total: SAMPLE_COUNT, mediaTime: item.t });
  };

  // The frame presented by the seek is available now. Take it before playback
  // so slot 0 is a distinct frame and not a duplicate of slot 1.
  const first = grab(video, video.currentTime);
  if (first) await process(first);

  const capture = await captureFrames(video, {
    grab,
    process,
    shouldStop: (t) => t >= end - 1e-4 || store.captured >= SAMPLE_COUNT,
    signal,
    maxQueue: 3,
  });
  if (store.captured === 0) throw new Error("No frames could be captured from this source inside the selected excerpt.");
  const summary = store.finalize();
  return { store, summary, capture };
}

/** Pick the canvas capture API that exists, or null when none does. */
function beginCapture(canvas, fps) {
  const manual = canvas.captureStream(0);
  const track = manual.getVideoTracks()[0];
  if (track && typeof track.requestFrame === "function") return { stream: manual, requestFrame: () => track.requestFrame(), mode: "manual (track.requestFrame)" };
  if (typeof manual.requestFrame === "function") return { stream: manual, requestFrame: () => manual.requestFrame(), mode: "manual (stream.requestFrame)" };
  manual.getTracks().forEach((t) => t.stop());
  const auto = canvas.captureStream(fps);
  return { stream: auto, requestFrame: null, mode: `automatic (captureStream(${fps}))` };
}

/**
 * Encode `count` frames produced by `produceFrame(i)` into a video Blob with
 * MediaRecorder, pacing at `fps`. Timestamps come from the wall clock, so the
 * measured wall time and any late frames are reported instead of assumed.
 */
export async function recordFrames({ canvas, mime, fps = SAMPLE_FPS, count = SAMPLE_COUNT, bitsPerSecond = 12_000_000, produceFrame, onProgress, signal, settleStartMs = 250, settleEndMs = 400 }) {
  if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder is not available in this browser. No output can be encoded.");
  if (typeof canvas.captureStream !== "function") throw new Error("canvas.captureStream is not available in this browser.");
  const ctx = canvas.getContext("2d");
  const { stream, requestFrame, mode } = beginCapture(canvas, fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitsPerSecond });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (e) => reject(e?.error instanceof Error ? e.error : new Error("MediaRecorder reported an error."));
  });
  const abortAll = () => {
    stream.getTracks().forEach((t) => t.stop());
    if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // ignore
      }
    }
  };
  try {
    // Frame 0 is drawn and requested BEFORE recorder.start(). Chrome does not
    // fire the recorder's "start" event until the captured canvas has produced
    // at least one frame, so waiting for "start" with a blank canvas deadlocks
    // (measured: never-drawn canvas timed out at 3 s; pre-drawn fired in 32 ms).
    const first = await produceFrame(0);
    throwIfAborted(signal);
    ctx.putImageData(first, 0, 0);
    requestFrame?.();
    recorder.start();
    requestFrame?.();
    await waitForEvent(recorder, ["start"], ["error"], { signal, timeoutMs: 5000 });
    const interval = frameIntervalMs(fps);
    let late = 0;
    // A short settle so the encoder has the first frame ready.
    const t0 = performance.now();
    onProgress?.({ stage: "recording", done: 1, total: count });
    await sleep(settleStartMs, signal);
    const base = performance.now() - interval; // frame 1 is due one interval after this point
    for (let i = 1; i < count; i++) {
      throwIfAborted(signal);
      const frame = await produceFrame(i);
      throwIfAborted(signal);
      ctx.putImageData(frame, 0, 0);
      requestFrame?.();
      onProgress?.({ stage: "recording", done: i + 1, total: count });
      const target = base + (i + 1) * interval;
      const now = performance.now();
      if (now < target) await sleep(target - now, signal);
      else late++;
    }
    await sleep(settleEndMs, signal);
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    const type = recorder.mimeType || mime;
    const blob = new Blob(chunks, { type });
    if (blob.size === 0) throw new Error("MediaRecorder produced an empty Blob. The codec may be unsupported for canvas capture in this browser.");
    return {
      blob,
      mime: type,
      frames: count,
      wallMs: performance.now() - t0,
      lateFrames: late,
      requestedBitsPerSecond: bitsPerSecond,
      actualBitsPerSecond: recorder.videoBitsPerSecond ?? null,
      captureMode: mode,
    };
  } catch (err) {
    abortAll();
    throw err;
  }
}

/**
 * Open a produced Blob in a NEW video element, play it, and deliver every
 * presented frame as canonical RGBA to `onFrame(imageData, info)`. The blob is
 * read through the browser decoder, never from in-memory marked frames.
 */
export async function readBlobFrames(blob, { host, canvas, urls, signal, onFrame, onProgress, maxFrames = 600 } = {}) {
  const url = urls.create(blob);
  const { video, meta, plan } = await openVideoSource(url, { host, signal, requireExcerpt: false });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const resized = !(meta.videoWidth === CANONICAL.width && meta.videoHeight === CANONICAL.height);
  let index = 0;
  try {
    video.currentTime = 0;
    const capture = await captureFrames(video, {
      grab: (v, t) => {
        drawLetterboxed(ctx, v, plan);
        const img = ctx.getImageData(0, 0, CANONICAL.width, CANONICAL.height);
        return { img, t, index: index++ };
      },
      process: async (item) => {
        await onFrame(item.img, { index: item.index, mediaTime: item.t });
        onProgress?.({ stage: "reading", done: item.index + 1, total: null, mediaTime: item.t });
      },
      shouldStop: () => index >= maxFrames,
      signal,
      maxQueue: 2,
    });
    return {
      frames: capture.frames,
      lastMediaTime: capture.lastTime,
      method: capture.method,
      width: meta.videoWidth,
      height: meta.videoHeight,
      resized,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      truncated: index >= maxFrames,
    };
  } finally {
    disposeVideo(video);
    urls.revoke(url);
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}
