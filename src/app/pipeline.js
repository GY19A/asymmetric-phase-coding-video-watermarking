// Orchestration of the real protocol on top of the worker and media layers.
// Every progress event carries real counts. Every verdict comes from
// verifyEvidence on frames decoded from a produced Blob. Nothing is simulated.
import { WorkerClient, CancelledError } from "./worker-client.js";
import * as media from "../media.js";
import {
  CANONICAL,
  SAMPLE_COUNT,
  SAMPLE_FPS,
  EXCERPT_SECONDS,
  clampExcerptStart,
  describeInterval,
  validateFileCandidate,
  validateUrlCandidate,
  formatBytes,
} from "./validation.js";
import { groupForSampleIndex } from "./sampling.js";
import { bytesToHex, utf8Encode, utf8ByteLength } from "./text.js";
import { buildMetadata } from "./metadata.js";
import { describeMime } from "./capabilities.js";
import { withBase } from "./base.js";

export { CancelledError };

/** Closed-loop PSNR ladder from the paper: four rungs plus two reserve rungs. */
export const LADDER = Object.freeze([42, 40, 38, 36, 34, 32]);
export const RUN_LENGTH = 30;
export const GROUPS = 4;
export const OUTPUT_BITRATE = 12_000_000;

export const BUILTIN = Object.freeze({
  kind: "builtin",
  name: "sintel-demo.mp4",
  url: withBase("/media/sintel-demo.mp4"),
  poster: withBase("/media/sintel-poster.jpg"),
  attributionUrl: withBase("/media/ATTRIBUTION.txt"),
  attribution: "Sintel excerpt. Blender Foundation, www.sintel.org. CC BY 3.0. Trimmed, resized, letterboxed, audio removed.",
});

function createDemoWorker() {
  return new Worker(new URL("../worker.js", import.meta.url), { type: "module" });
}

function copyRgba(imageData) {
  return new Uint8ClampedArray(imageData.data);
}

export function randomNonce() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `apcvw-demo-${bytes.toHex ? bytes.toHex() : bytesToHex(bytes)}`;
}

export class Pipeline {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.hiddenHost element that hosts hidden video elements and canvases
   * @param {HTMLCanvasElement} opts.outputCanvas visible canvas that feeds the recorder
   * @param {string|null} opts.recorderMime chosen MediaRecorder MIME type
   * @param {(p: object) => void} [opts.onProgress]
   * @param {(status: string, detail?: any) => void} [opts.onWorkerStatus]
   */
  constructor({ core, hiddenHost, outputCanvas, recorderMime, onProgress, onWorkerStatus, createWorker = createDemoWorker }) {
    if (!core || typeof core.generateIdentity !== "function") throw new Error("Pipeline needs the core adapter module.");
    this.core = core;
    this.hiddenHost = hiddenHost;
    this.outputCanvas = outputCanvas;
    this.recorderMime = recorderMime;
    this.onProgress = onProgress ?? (() => {});
    this.urls = new media.UrlRegistry();
    this.workCanvas = this._canvas();
    this.verifyCanvas = this._canvas();
    this.controller = null;
    this.layoutCache = new Map();
    this.verifySessions = 0;
    this.worker = new WorkerClient(createWorker);
    this.worker.onStatus = (status, detail) => {
      if (status === "terminated" || status === "error") this.layoutCache.clear();
      onWorkerStatus?.(status, detail);
    };
  }

  _canvas() {
    const c = document.createElement("canvas");
    c.width = CANONICAL.width;
    c.height = CANONICAL.height;
    c.className = "apcvw-hidden-canvas";
    this.hiddenHost.appendChild(c);
    return c;
  }

  _workCtx() {
    return this.workCanvas.getContext("2d", { willReadFrequently: true });
  }

  /** Start an operation. Any running operation is cancelled first. */
  begin(label) {
    this.cancel();
    this.controller = new AbortController();
    this.currentOperation = label;
    return this.controller.signal;
  }

  end() {
    this.controller = null;
    this.currentOperation = null;
  }

  /** Abort the current operation and terminate the worker so that no stale work continues. */
  cancel() {
    if (!this.controller) return false;
    this.controller.abort();
    this.controller = null;
    this.currentOperation = null;
    this.worker.terminate("Cancelled by the user");
    return true;
  }

  get busy() {
    return !!this.controller;
  }

  async warmUp() {
    return this.worker.start();
  }

  async generateIdentity() {
    const id = await this.core.generateIdentity();
    const publicKeyHex = bytesToHex(id.publicKey);
    return {
      publicKey: id.publicKey,
      privateKey: id.privateKey,
      publicKeyHex,
      privateKeyHex: bytesToHex(id.privateKey),
      keyId: publicKeyHex.slice(0, 8),
    };
  }

  newNonce() {
    return randomNonce();
  }

  async signMessage(message, identity) {
    const p = await this.core.createPayload(message, identity.privateKey);
    const messageBytes = p.messageBytes instanceof Uint8Array ? p.messageBytes : utf8Encode(message);
    return {
      bits: p.bits,
      bitCount: p.bits.length,
      signature: p.signature,
      signatureHex: bytesToHex(p.signature),
      messageBytes,
      messageByteLength: messageBytes.length,
      message,
    };
  }

  async ensureLayout(nonce, bitCount) {
    const key = `${CANONICAL.width}x${CANONICAL.height}|${nonce}|${bitCount}`;
    if (this.layoutCache.has(key)) return this.layoutCache.get(key);
    const res = await this.worker.request("layout", { width: CANONICAL.width, height: CANONICAL.height, nonce, bitCount });
    const entry = { key: res.key, summary: res.summary };
    this.layoutCache.set(key, entry);
    return entry;
  }

  /**
   * Open a source candidate and read its metadata. Nothing is sampled yet.
   * The user sees the interval and conversion plan and confirms with Import.
   */
  async prepareSource(descriptor) {
    const signal = this.begin("prepare");
    try {
      let url;
      let size = null;
      let name;
      let blob = null;
      if (descriptor.kind === "builtin") {
        url = BUILTIN.url;
        name = BUILTIN.name;
      } else if (descriptor.kind === "file") {
        const check = validateFileCandidate(descriptor.file);
        if (!check.ok) throw Object.assign(new Error(check.message), { code: check.code });
        blob = descriptor.file;
        name = descriptor.file.name;
        size = descriptor.file.size;
        url = this.urls.create(blob);
      } else if (descriptor.kind === "url") {
        const check = validateUrlCandidate(descriptor.url);
        if (!check.ok) throw Object.assign(new Error(check.message), { code: check.code });
        this.onProgress({ op: "prepare", stage: "downloading", done: 0, total: null });
        blob = await media.fetchMediaBlob(check.url, {
          signal,
          onProgress: (received, total) => this.onProgress({ op: "prepare", stage: "downloading", done: received, total, text: `${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ""}` }),
        });
        const fileCheck = validateFileCandidate({ name: check.url.split("/").pop() || "download", size: blob.size, type: blob.type || "video/*" });
        if (!fileCheck.ok) throw Object.assign(new Error(fileCheck.message), { code: fileCheck.code });
        name = decodeURIComponent(check.url.split("/").pop() || "remote video");
        size = blob.size;
        url = this.urls.create(blob);
      } else {
        throw new Error(`Unknown source kind ${descriptor.kind}`);
      }
      this.onProgress({ op: "prepare", stage: "reading metadata", done: 0, total: null });
      let opened;
      try {
        opened = await media.openVideoSource(url, { host: this.hiddenHost, signal });
      } catch (err) {
        if (descriptor.kind !== "builtin") this.urls.revoke(url);
        throw err;
      }
      const duration = opened.meta.duration;
      return {
        kind: descriptor.kind,
        name,
        size,
        url,
        blob,
        video: opened.video,
        width: opened.meta.videoWidth,
        height: opened.meta.videoHeight,
        duration,
        plan: opened.plan,
        start: 0,
        maxStart: Math.max(0, duration - EXCERPT_SECONDS),
        poster: descriptor.kind === "builtin" ? BUILTIN.poster : null,
        attribution: descriptor.kind === "builtin" ? BUILTIN.attribution : null,
      };
    } finally {
      this.end();
    }
  }

  /** Sample the excerpt from a prepared candidate into a bounded frame store. */
  async importSource(candidate, requestedStart) {
    const signal = this.begin("import");
    try {
      const start = clampExcerptStart(requestedStart, candidate.duration);
      const video = candidate.video ?? (await media.openVideoSource(candidate.url, { host: this.hiddenHost, signal })).video;
      const { store, summary, capture } = await media.sampleExcerpt(video, {
        start,
        plan: candidate.plan,
        canvas: this.workCanvas,
        signal,
        onProgress: (p) => this.onProgress({ op: "import", ...p, text: `Sampling frame ${p.done} of ${p.total}` }),
      });
      media.disposeVideo(video);
      const source0 = await store.getImageData(0, this._workCtx());
      return {
        kind: candidate.kind,
        name: candidate.name,
        size: candidate.size,
        url: candidate.url,
        width: candidate.width,
        height: candidate.height,
        duration: candidate.duration,
        plan: candidate.plan,
        poster: candidate.poster,
        attribution: candidate.attribution,
        start,
        interval: describeInterval(start, candidate.duration),
        store,
        sampling: summary,
        captureMethod: capture.method,
        sampleCount: SAMPLE_COUNT,
        sampleFps: SAMPLE_FPS,
        canonical: { ...CANONICAL },
        frame0: copyRgba(source0),
      };
    } finally {
      this.end();
    }
  }

  /**
   * Closed-loop embedding. For each rung: build carriers, mark every sampled
   * frame in the worker, encode through MediaRecorder, then decode the Blob and
   * run the public verifier. The first rung whose Blob verifies is accepted.
   */
  async embed({ source, payload, nonce, identity, mode = "auto", psnr = 42 }) {
    if (!this.recorderMime) throw new Error("No supported MediaRecorder format. Output cannot be encoded in this browser.");
    const signal = this.begin("embed");
    const rungs = mode === "auto" ? LADDER : [psnr];
    const ladder = [];
    let accepted = null;
    let last = null;
    try {
      const layout = await this.ensureLayout(nonce, payload.bitCount);
      const ctx = this._workCtx();
      for (let r = 0; r < rungs.length; r++) {
        media.throwIfAborted(signal);
        const target = rungs[r];
        const rungInfo = { rung: target, rungIndex: r + 1, rungCount: rungs.length };
        this.onProgress({ op: "embed", stage: "carriers", done: 0, total: null, ...rungInfo, text: `Rung ${target} dB: building four Cr carrier planes` });
        const carriers = await this.worker.request("carriers", { layoutKey: layout.key, bits: payload.bits, psnr: target });
        let source0 = null;
        let marked0 = null;
        const rec = await media.recordFrames({
          canvas: this.outputCanvas,
          mime: this.recorderMime,
          fps: SAMPLE_FPS,
          count: SAMPLE_COUNT,
          bitsPerSecond: OUTPUT_BITRATE,
          signal,
          produceFrame: async (i) => {
            const img = await source.store.getImageData(i, ctx);
            if (i === 0) source0 = copyRgba(img);
            const group = groupForSampleIndex(i, layout.summary.runLength ?? RUN_LENGTH, layout.summary.groups ?? GROUPS);
            const res = await this.worker.request(
              "embed",
              { setKey: carriers.setKey, group, width: CANONICAL.width, height: CANONICAL.height, index: i, rgba: img.data.buffer },
              [img.data.buffer],
            );
            const out = new ImageData(new Uint8ClampedArray(res.rgba), CANONICAL.width, CANONICAL.height);
            if (i === 0) marked0 = copyRgba(out);
            return out;
          },
          onProgress: (p) => this.onProgress({ op: "embed", ...p, ...rungInfo, text: `Rung ${target} dB: marking and encoding frame ${p.done} of ${p.total}` }),
        });
        media.throwIfAborted(signal);
        const check = await this.verifyBlob(rec.blob, {
          layoutKey: layout.key,
          publicKey: identity.publicKey,
          signal,
          keepFirstFrame: true,
          progressPrefix: `Rung ${target} dB: acceptance check, `,
          rungInfo,
        });
        const entry = {
          psnr: target,
          verified: check.result.verified === true,
          reason: check.result.reason ?? null,
          correctedSymbols: check.result.correctedSymbols ?? null,
          framesRead: check.read.frames,
          blobSize: rec.blob.size,
          wallMs: rec.wallMs,
          lateFrames: rec.lateFrames,
        };
        ladder.push(entry);
        last = { rec, check, carriers, source0, marked0, target };
        if (entry.verified) {
          accepted = last;
          break;
        }
        await this.worker.request("discard", { sessionId: check.sessionId }).catch(() => {});
      }
      const chosen = accepted ?? last;
      const mimeInfo = describeMime(chosen.rec.mime);
      const metadata = buildMetadata({
        nonce,
        bitCount: payload.bitCount,
        messageByteLength: payload.messageByteLength,
        publicKeyHex: identity.publicKeyHex,
        canonical: CANONICAL,
        layoutVersion: layout.summary.version ?? this.core.LAYOUT_VERSION,
        runLength: layout.summary.runLength ?? RUN_LENGTH,
        groups: layout.summary.groups ?? GROUPS,
        mode: "runlength",
        outputMime: chosen.rec.mime,
        psnrTarget: chosen.target,
        band: layout.summary.band ?? undefined,
        channel: "Cr",
      });
      const url = this.urls.create(chosen.rec.blob);
      return {
        accepted: !!accepted,
        psnr: chosen.target,
        mode,
        blob: chosen.rec.blob,
        url,
        mime: chosen.rec.mime,
        mimeInfo,
        frames: chosen.rec.frames,
        wallMs: chosen.rec.wallMs,
        lateFrames: chosen.rec.lateFrames,
        captureMode: chosen.rec.captureMode,
        requestedBitsPerSecond: chosen.rec.requestedBitsPerSecond,
        actualBitsPerSecond: chosen.rec.actualBitsPerSecond,
        ladder,
        acceptance: chosen.check,
        carrierStats: chosen.carriers.stats,
        layout,
        nonce,
        frame0: { source: chosen.source0, marked: chosen.marked0, output: chosen.check.output0 },
        metadata,
        metadataText: JSON.stringify(metadata, null, 2),
      };
    } finally {
      this.end();
    }
  }

  /**
   * Independent verification of a Blob: a new video element decodes it, every
   * presented frame becomes one evidence row in the worker, and verifyEvidence
   * runs with the public layout and the supplied public key only.
   */
  async verifyBlob(blob, { layoutKey, publicKey, signal, keepFirstFrame = false, progressPrefix = "", rungInfo = {}, maxFrames = 600 } = {}) {
    const ownSignal = signal ?? this.begin("verify");
    const sessionId = `v${++this.verifySessions}`;
    const frameGroups = [];
    let output0 = null;
    try {
      const read = await media.readBlobFrames(blob, {
        host: this.hiddenHost,
        canvas: this.verifyCanvas,
        urls: this.urls,
        signal: ownSignal,
        maxFrames,
        onFrame: async (img, info) => {
          if (info.index === 0 && keepFirstFrame) output0 = copyRgba(img);
          const res = await this.worker.request(
            "extract",
            { sessionId, layoutKey, width: CANONICAL.width, height: CANONICAL.height, index: info.index, rgba: img.data.buffer },
            [img.data.buffer],
          );
          frameGroups.push(res.summary?.group ?? null);
        },
        onProgress: (p) => this.onProgress({ op: "verify", ...p, ...rungInfo, text: `${progressPrefix}decoded ${p.done} frames from the output` }),
      });
      this.onProgress({ op: "verify", stage: "verifying", done: read.frames, total: read.frames, ...rungInfo, text: `${progressPrefix}verifying ${read.frames} evidence rows` });
      const res = await this.worker.request("verify", { sessionId, layoutKey, publicKey });
      return { sessionId, layoutKey, result: res.result, rowCount: res.rowCount, frameGroups: res.frameGroups ?? frameGroups, read, output0, publicKeyHex: bytesToHex(publicKey) };
    } finally {
      if (!signal) this.end();
    }
  }

  /** Re-run verifyEvidence on retained evidence rows with a different public key. */
  async verifyRetained(sessionId, layoutKey, publicKey) {
    this.begin("verify-key");
    try {
      const res = await this.worker.request("verify", { sessionId, layoutKey, publicKey });
      return { sessionId, layoutKey, result: res.result, rowCount: res.rowCount, frameGroups: res.frameGroups, publicKeyHex: bytesToHex(publicKey) };
    } finally {
      this.end();
    }
  }

  /** Extract from the unmarked sampled source and verify. Expected to reject, but the verifier decides. */
  async verifyUnmarked(source, { layoutKey, publicKey }) {
    const signal = this.begin("verify-unmarked");
    const sessionId = `u${++this.verifySessions}`;
    try {
      const ctx = this._workCtx();
      const frameGroups = [];
      for (let i = 0; i < SAMPLE_COUNT; i++) {
        media.throwIfAborted(signal);
        const img = await source.store.getImageData(i, ctx);
        const res = await this.worker.request(
          "extract",
          { sessionId, layoutKey, width: CANONICAL.width, height: CANONICAL.height, index: i, rgba: img.data.buffer },
          [img.data.buffer],
        );
        frameGroups.push(res.summary?.group ?? null);
        this.onProgress({ op: "verify-unmarked", stage: "extracting", done: i + 1, total: SAMPLE_COUNT, text: `Unmarked source: evidence from frame ${i + 1} of ${SAMPLE_COUNT}` });
      }
      const res = await this.worker.request("verify", { sessionId, layoutKey, publicKey });
      return { sessionId, layoutKey, result: res.result, rowCount: res.rowCount, frameGroups: res.frameGroups ?? frameGroups, publicKeyHex: bytesToHex(publicKey), read: { frames: SAMPLE_COUNT, method: "frame store" } };
    } finally {
      this.end();
    }
  }

  /** Verify a user-supplied file with imported metadata and a public key. */
  async verifyExternal({ file, metadata, publicKey }) {
    const check = validateFileCandidate(file);
    if (!check.ok) throw Object.assign(new Error(check.message), { code: check.code });
    const signal = this.begin("verify-external");
    try {
      const layout = await this.ensureLayout(metadata.nonce, metadata.bitCount);
      return await this.verifyBlob(file, { layoutKey: layout.key, publicKey, signal, keepFirstFrame: false, progressPrefix: `${file.name}: ` });
    } finally {
      this.end();
    }
  }

  /** Spectrum and residual images from actual planes. Gains and scales are reported for labeling. */
  async inspect({ frame0, gain = 16 }) {
    this.begin("inspect");
    try {
      const w = CANONICAL.width;
      const h = CANONICAL.height;
      const spectrum = async (rgba, label) => {
        if (!rgba) return null;
        const buf = rgba.slice().buffer;
        const res = await this.worker.request("spectrum", { rgba: buf, width: w, height: h, label, options: { channel: "Cr", log: true, center: true } }, [buf]);
        return { image: new ImageData(new Uint8ClampedArray(res.image.rgba), res.image.width, res.image.height), min: res.min, max: res.max, scale: res.scale, centered: res.centered, label };
      };
      const residual = async (a, b, label) => {
        if (!a || !b) return null;
        const ab = a.slice().buffer;
        const bb = b.slice().buffer;
        const res = await this.worker.request("residual", { a: ab, b: bb, width: w, height: h, gain }, [ab, bb]);
        return { image: new ImageData(new Uint8ClampedArray(res.rgba), w, h), gain: res.gain, stats: res.stats, label };
      };
      this.onProgress({ op: "inspect", stage: "spectrum", done: 0, total: 5, text: "Computing Cr spectra and residuals from frame 0" });
      const out = {};
      out.spectrumSource = await spectrum(frame0.source, "source");
      this.onProgress({ op: "inspect", stage: "spectrum", done: 1, total: 5 });
      out.spectrumMarked = await spectrum(frame0.marked, "marked, before encoding");
      this.onProgress({ op: "inspect", stage: "spectrum", done: 2, total: 5 });
      out.spectrumOutput = await spectrum(frame0.output, "output, decoded from the encoded Blob");
      this.onProgress({ op: "inspect", stage: "residual", done: 3, total: 5 });
      out.residualCarrier = await residual(frame0.marked, frame0.source, "marked minus source (before encoding)");
      this.onProgress({ op: "inspect", stage: "residual", done: 4, total: 5 });
      out.residualOutput = await residual(frame0.output, frame0.source, "decoded output minus source (after encoding)");
      this.onProgress({ op: "inspect", stage: "done", done: 5, total: 5 });
      out.gain = gain;
      // The inspected frame is always the first sampled frame (frame0). Recorded so the walkthrough reports it instead of assuming it.
      out.frameIndex = 0;
      return out;
    } finally {
      this.end();
    }
  }

  /** Release everything: cancel work, revoke URLs, and drop caches. */
  reset() {
    this.cancel();
    this.urls.revokeAll();
    this.layoutCache.clear();
  }

  destroy() {
    this.reset();
    this.worker.terminate("Destroyed");
    this.workCanvas.remove();
    this.verifyCanvas.remove();
  }
}
