// The demo interface. One mount function builds the DOM once and re-renders
// from state. All numbers on screen come from the pipeline, the worker, or
// the media layer. Nothing is animated as a stand-in for real progress.
import { createSession, applyChange, setActiveStep, stepStatuses, canEmbed, STEPS } from "./session.js";
import { validateMessage, payloadBitLength, hexToBytes, groupHex, fixed, MAX_MESSAGE_BYTES } from "./text.js";
import { detectCapabilities, readBrowserEnvironment, describeMime } from "./capabilities.js";
import { verdictViewModel, SCOPE_NOTE } from "./verdict.js";
import { parseMetadata } from "./metadata.js";
import { formatBytes, EXCERPT_SECONDS, SAMPLE_COUNT, SAMPLE_FPS, CANONICAL, clampExcerptStart, describeInterval, MAX_INPUT_BYTES } from "./validation.js";
import { Pipeline, LADDER, BUILTIN, CancelledError, randomNonce, OUTPUT_BITRATE } from "./pipeline.js";
import { downloadBlob } from "../media.js";
import { h, text, show, setDisabled, setClass, formatMs, copyText, prefersReducedMotion } from "./dom.js";
import { codeForStep, embedSnippet, sdkImportLine } from "./codepane.js";
import { drawSpectrum, drawResidual, drawGroupTimeline, clearCanvas } from "./inspect-draw.js";
import { RUN_STEPS, CARD_ORDER } from "./run-order.js";
import { buildWalkthrough, formatDuration } from "./walkthrough.js";
import { withBase } from "./base.js";

const HEADLINE = "Asymmetric Phase Coding Video Watermarking";
const SUBHEAD = "A training-free video watermark that removes the shared secret. The signer embeds a complete Ed25519 signature in the chroma phase spectrum. Anyone holding the 32-byte public key verifies offline.";
const LEDE =
  "This page runs the protocol from the paper in your browser: sign a short message, carry it in the chroma phase of a four second video excerpt, decode the encoded file, and verify it with the public key alone. " +
  "Every step runs in this browser tab. Nothing is uploaded.";
export const PAPER_URL = "https://arxiv.org/abs/2608.29212";
const AUTHORS = [
  { name: "Guang Yang", affiliation: "Phi Lab Foundation", href: "https://philab.fund" },
  { name: "Fengchen Liu", affiliation: "University of California, Berkeley", href: null },
];

export function mountApp(root, options = {}) {
  const isDev = typeof import.meta !== "undefined" && import.meta.env ? !!import.meta.env.DEV : false;
  const opts = {
    paperHref: PAPER_URL,
    isDev,
    widgetSrc: isDev ? withBase("/src/widget.js") : withBase("/apcvw-widget.js"),
    sdkSrc: isDev ? withBase("/src/lib/index.js") : withBase("/apcvw-sdk.js"),
    ...options,
  };
  const caps = detectCapabilities(readBrowserEnvironment());
  const refs = {};
  const handlers = {};
  root.classList.add("apcvw");
  root.append(buildShell(refs, handlers, opts, caps));

  let session = createSession();
  session = { ...session, nonce: safeNonce() };
  const ui = {
    busy: false,
    progress: null,
    error: null,
    notice: null,
    seedRevealed: false,
    sourceTab: "builtin",
    candidate: null,
    candidateStart: 0,
    workerStatus: "loading",
    workerInfo: null,
    coreError: null,
    coreNames: null,
    wrongKey: null,
    unmarked: null,
    external: null,
    externalMeta: null,
    spectrumView: "marked",
    residualView: "carrier",
    gain: 16,
    showBins: true,
    copied: null,
    // The detailed controls start expanded above 860 px and collapsed at or below it. The walkthrough is the primary view on phones.
    detailsOpen: !(typeof matchMedia === "function" && matchMedia("(max-width: 860px)").matches),
  };
  let pipeline = null;
  let coreMod = null;
  let destroyed = false;
  // Run state for the walkthrough: which step is running, where a run stopped, and measured wall time per step function.
  const freshWalk = () => ({ mode: null, phase: "idle", current: null, failedStep: null, cancelledStep: null, error: null, timings: {}, cancelRequested: false });
  let walk = freshWalk();

  const onProgress = (p) => {
    ui.progress = p;
    renderProgress();
    renderWalkthrough();
  };
  const onWorkerStatus = (status, detail) => {
    ui.workerStatus = status;
    if (status === "ready") ui.workerInfo = detail;
    if (status === "error") ui.coreError = detail;
    renderStatus();
  };

  const coreReady = import("./core-adapter.js")
    .then((mod) => {
      if (destroyed) return mod;
      coreMod = mod;
      ui.coreNames = mod.resolvedNames();
      if (mod.CORE_DEFAULT_MESSAGE && session.message === createSession().message && !session.payload) {
        session = { ...session, message: mod.CORE_DEFAULT_MESSAGE };
      }
      pipeline = new Pipeline({ core: mod, hiddenHost: refs.hiddenHost, outputCanvas: refs.outputCanvas, recorderMime: caps.recorder.mime, onProgress, onWorkerStatus });
      pipeline.warmUp().catch(() => {});
      render();
      return mod;
    })
    .catch((err) => {
      ui.coreError = err;
      ui.workerStatus = "error";
      render();
      return null;
    });

  // ---- actions -----------------------------------------------------------

  async function run(scope, fn) {
    if (ui.busy) return;
    ui.busy = true;
    ui.error = null;
    ui.notice = null;
    ui.progress = null;
    // A new action supersedes the previous failure or cancellation in the walkthrough.
    walk.failedStep = null;
    walk.cancelledStep = null;
    walk.error = null;
    walk.cancelRequested = false;
    if (scope !== "demo") {
      walk.mode = "step";
      walk.phase = "idle";
    }
    render();
    try {
      await fn();
    } catch (err) {
      if (isCancelled(err)) {
        ui.notice = "Cancelled. Partial work was discarded and the worker was stopped.";
      } else {
        console.error(err);
        ui.error = { scope, message: err?.message ?? String(err) };
      }
    } finally {
      ui.busy = false;
      ui.progress = null;
      walk.current = null;
      render();
    }
  }

  function isCancelled(err) {
    return err instanceof CancelledError || err?.name === "CancelledError";
  }

  function requirePipeline() {
    if (!pipeline) throw new Error(ui.coreError ? `The core library did not load: ${ui.coreError.message}` : "The core library is still loading.");
    return pipeline;
  }

  handlers.step = (n) => {
    session = setActiveStep(session, n);
    render();
  };

  // ---- protocol steps ------------------------------------------------------
  // One implementation per step. The per-step buttons and the one-click
  // runner call the same functions. The runner iterates RUN_STEPS from
  // run-order.js and keeps no list of its own.

  const steps = {
    async doGenerate() {
      const p = requirePipeline();
      const identity = await p.generateIdentity();
      ui.seedRevealed = false;
      session = applyChange(session, "identity", identity);
      resetDerived();
    },

    async doPrepareBuiltin() {
      await doPrepare({ kind: "builtin" });
    },

    async doImport() {
      const p = requirePipeline();
      if (!ui.candidate) throw new Error("Choose a source first.");
      const candidate = ui.candidate;
      ui.candidate = null;
      disposeSource();
      const source = await p.importSource(candidate, ui.candidateStart);
      session = applyChange(session, "source", source);
      resetDerived();
    },

    async doSign() {
      const p = requirePipeline();
      if (!session.identity) throw new Error("Generate an identity first.");
      const check = validateMessage(session.message);
      if (!check.ok) throw new Error(check.message);
      const payload = await p.signMessage(session.message, session.identity);
      session = applyChange(session, "payload", payload);
    },

    async doEmbed() {
      const p = requirePipeline();
      if (!caps.ok) throw new Error(caps.blockers.join(" "));
      if (!canEmbed(session)) throw new Error("Sign the message first.");
      const nonce = session.nonce.trim();
      if (!nonce) throw new Error("The public nonce must not be empty.");
      resetDerived();
      session = applyChange(session, "marked", null);
      render();
      const marked = await p.embed({
        source: session.source,
        payload: session.payload,
        nonce,
        identity: session.identity,
        mode: session.strength.mode,
        psnr: session.strength.psnr,
      });
      session = applyChange(session, "marked", marked);
      if (!marked.accepted) {
        ui.notice = `No rung of the ladder verified after encoding (${marked.ladder.map((r) => `${r.psnr} dB: ${r.reason ?? "not verified"}`).join("; ")}). The last output is kept for inspection and is labeled not verified.`;
      }
    },

    async doVerify() {
      const p = requirePipeline();
      const marked = session.marked;
      if (!marked) throw new Error("Embed the signature first.");
      const v = await p.verifyBlob(marked.blob, { layoutKey: marked.layout.key, publicKey: session.identity.publicKey });
      ui.wrongKey = null;
      ui.unmarked = null;
      session = applyChange(session, "verification", v);
    },

    async doWrongKey() {
      const p = requirePipeline();
      const v = session.verification;
      if (!v) throw new Error("Run Extract and verify first.");
      const other = await p.generateIdentity();
      try {
        const res = await p.verifyRetained(v.sessionId, v.layoutKey, other.publicKey);
        ui.wrongKey = { res, publicKeyHex: other.publicKeyHex };
      } catch (err) {
        if (/No evidence rows/.test(err?.message ?? "")) {
          throw new Error("The evidence rows from the last verification are no longer in the worker (it was restarted). Run Extract and verify again, then retry.");
        }
        throw err;
      }
    },

    async doUnmarked() {
      const p = requirePipeline();
      if (!session.marked || !session.source) throw new Error("Embed the signature first.");
      const res = await p.verifyUnmarked(session.source, { layoutKey: session.marked.layout.key, publicKey: session.identity.publicKey });
      ui.unmarked = { res, publicKeyHex: session.identity.publicKeyHex };
    },

    async doInspect() {
      const p = requirePipeline();
      const marked = session.marked;
      if (!marked) throw new Error("Embed the signature first.");
      const result = await p.inspect({ frame0: marked.frame0, gain: ui.gain });
      session = applyChange(session, "inspect", result);
    },
  };

  /** Open a source candidate. The built-in step and the file and URL tabs share this. */
  async function doPrepare(descriptor) {
    const p = requirePipeline();
    disposeCandidate();
    // A file or URL prepare replaces the built-in one, so its timing no longer describes this source.
    if (descriptor.kind !== "builtin") delete walk.timings[steps.doPrepareBuiltin.name];
    const candidate = await p.prepareSource(descriptor);
    ui.candidate = candidate;
    ui.candidateStart = 0;
  }

  /** Run one step function, record its wall-clock time under its own name, and keep the walkthrough state current. */
  async function timed(fn) {
    const name = fn.name;
    if (walk.cancelRequested) throw new CancelledError("Cancelled before this step started");
    walk.current = name;
    render();
    const t0 = performance.now();
    try {
      await fn();
      walk.timings[name] = performance.now() - t0;
    } catch (err) {
      walk.timings[name] = performance.now() - t0;
      if (isCancelled(err)) walk.cancelledStep = name;
      else {
        walk.failedStep = name;
        walk.error = err?.message ?? String(err);
      }
      throw err;
    } finally {
      walk.current = null;
      render();
    }
  }

  // ---- handlers ------------------------------------------------------------

  handlers.generate = () => run("identity", () => timed(steps.doGenerate));

  handlers.revealSeed = () => {
    ui.seedRevealed = !ui.seedRevealed;
    render();
  };

  handlers.copy = async (key, value) => {
    const ok = await copyText(value);
    ui.copied = ok ? key : `${key}:failed`;
    render();
    setTimeout(() => {
      if (ui.copied && ui.copied.startsWith(key)) {
        ui.copied = null;
        render();
      }
    }, 1600);
  };

  handlers.sourceTab = (tab) => {
    ui.sourceTab = tab;
    render();
  };

  handlers.useBuiltin = () => run("source", () => timed(steps.doPrepareBuiltin));
  handlers.fileChosen = (file) => {
    if (!file) return;
    run("source", () => doPrepare({ kind: "file", file }));
  };
  handlers.loadUrl = () => {
    const url = refs.urlInput.value;
    run("source", () => doPrepare({ kind: "url", url }));
  };
  handlers.startChanged = (value) => {
    if (!ui.candidate) return;
    ui.candidateStart = clampExcerptStart(Number(value), ui.candidate.duration);
    render();
  };
  handlers.importConfirm = () => run("import", () => timed(steps.doImport));

  handlers.messageInput = (value) => {
    session = applyChange(session, "message", value);
    resetDerived();
    render();
  };
  handlers.nonceInput = (value) => {
    session = applyChange(session, "nonce", value);
    resetDerived();
    render();
  };
  handlers.newNonce = () => handlers.nonceInput(safeNonce());

  handlers.sign = () => run("sign", () => timed(steps.doSign));

  handlers.strengthMode = (mode) => {
    session = applyChange(session, "strength", { ...session.strength, mode });
    render();
  };
  handlers.strengthPsnr = (psnr) => {
    session = applyChange(session, "strength", { ...session.strength, psnr: Number(psnr) });
    render();
  };

  handlers.embed = () => run("embed", () => timed(steps.doEmbed));
  handlers.verify = () => run("verify", () => timed(steps.doVerify));
  handlers.wrongKey = () => run("wrong-key", () => timed(steps.doWrongKey));
  handlers.unmarked = () => run("unmarked", () => timed(steps.doUnmarked));

  handlers.metadataChosen = async (file) => {
    ui.externalMeta = null;
    ui.external = null;
    if (!file) {
      render();
      return;
    }
    const textContent = await file.text();
    const parsed = parseMetadata(textContent);
    ui.externalMeta = { ...parsed, fileName: file.name };
    if (parsed.ok && parsed.metadata.publicKey && !refs.verifyKeyInput.value.trim()) {
      refs.verifyKeyInput.value = parsed.metadata.publicKey;
    }
    render();
  };

  handlers.verifyExternal = () =>
    run("external", async () => {
      const p = requirePipeline();
      const file = refs.verifyFileInput.files?.[0];
      if (!file) throw new Error("Choose a video file to verify.");
      if (!ui.externalMeta?.ok) throw new Error(ui.externalMeta?.message ?? "Choose the metadata JSON that was downloaded with the video.");
      const keyHex = refs.verifyKeyInput.value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error("Enter the 64 hex character public key to verify against.");
      const publicKey = hexToBytes(keyHex);
      const res = await p.verifyExternal({ file, metadata: ui.externalMeta.metadata, publicKey });
      ui.external = { res, publicKeyHex: keyHex, fileName: file.name, ignoredFields: ui.externalMeta.ignoredFields };
    });

  handlers.inspect = () => run("inspect", () => timed(steps.doInspect));

  /**
   * One click: every step in RUN_STEPS order on the built-in excerpt. Runs
   * inside one run("demo") so busy, Cancel, and error handling are shared with
   * the per-step buttons. The demonstration uses the automatic ladder and the
   * default residual gain; both selections stay visible in the detailed controls.
   */
  handlers.runAll = () =>
    run("demo", async () => {
      requirePipeline();
      walk = { ...freshWalk(), mode: "demo", phase: "running" };
      if (session.strength.mode !== "auto") session = applyChange(session, "strength", { ...session.strength, mode: "auto" });
      ui.gain = 16;
      ui.sourceTab = "builtin";
      try {
        for (const step of RUN_STEPS) {
          const fn = steps[step.fn];
          if (typeof fn !== "function") throw new Error(`The runner has no step function named ${step.fn}.`);
          await timed(fn);
        }
        walk.phase = "done";
      } catch (err) {
        walk.phase = isCancelled(err) ? "cancelled" : "failed";
        throw err;
      }
    });

  handlers.toggleDetails = () => {
    ui.detailsOpen = !ui.detailsOpen;
    render();
  };
  handlers.spectrumView = (v) => {
    ui.spectrumView = v;
    render();
  };
  handlers.residualView = (v) => {
    ui.residualView = v;
    render();
  };
  handlers.gain = (g) => {
    ui.gain = Number(g);
    if (session.inspect) handlers.inspect();
    else render();
  };
  handlers.showBins = (on) => {
    ui.showBins = on;
    render();
  };

  handlers.cancel = () => {
    // Stops the sequence even between steps, when no pipeline operation is in flight.
    if (ui.busy) walk.cancelRequested = true;
    if (pipeline?.cancel()) {
      ui.notice = "Cancelled. The worker was terminated and partial output discarded.";
    }
    ui.progress = null;
    render();
  };

  handlers.reset = () => {
    pipeline?.cancel();
    disposeCandidate();
    disposeSource();
    pipeline?.reset();
    walk = freshWalk();
    session = { ...createSession(), nonce: safeNonce(), message: coreMod?.CORE_DEFAULT_MESSAGE ?? createSession().message };
    Object.assign(ui, { busy: false, progress: null, error: null, notice: "Session reset. Keys, payload, sampled frames, and outputs were discarded.", seedRevealed: false, candidate: null, candidateStart: 0, wrongKey: null, unmarked: null, external: null, externalMeta: null, copied: null });
    refs.messageInput.value = session.message;
    refs.nonceInput.value = session.nonce;
    refs.urlInput.value = "";
    refs.verifyKeyInput.value = "";
    refs.fileInput.value = "";
    refs.verifyFileInput.value = "";
    refs.verifyMetadataInput.value = "";
    render();
  };

  handlers.downloadVideo = () => {
    const m = session.marked;
    if (!m) return;
    const ext = /mp4/.test(m.mime) ? "mp4" : /matroska/.test(m.mime) ? "mkv" : "webm";
    downloadBlob(m.blob, `apcvw-signed-excerpt-${session.identity.keyId}-${m.psnr}dB.${ext}`);
  };
  handlers.downloadMetadata = () => {
    const m = session.marked;
    if (!m) return;
    downloadBlob(new Blob([m.metadataText], { type: "application/json" }), `apcvw-metadata-${session.identity.keyId}.json`);
  };

  function resetDerived() {
    ui.wrongKey = null;
    ui.unmarked = null;
  }

  function disposeCandidate() {
    const c = ui.candidate;
    if (!c) return;
    ui.candidate = null;
    try {
      c.video?.remove();
    } catch {
      // ignore
    }
    if (c.kind !== "builtin" && pipeline) pipeline.urls.revoke(c.url);
  }

  function disposeSource() {
    const s = session.source;
    if (!s) return;
    s.store?.dispose();
    if (s.kind !== "builtin" && pipeline) pipeline.urls.revoke(s.url);
  }

  // ---- render ------------------------------------------------------------

  function renderStatus() {
    const st = ui.workerStatus;
    let label;
    if (ui.coreError) label = "Local processing: unavailable";
    else if (st === "loading") label = "Local processing: starting";
    else if (st === "ready" || st === "idle") label = "Local processing: ready";
    else if (st === "busy") label = "Local processing: working";
    else if (st === "terminated") label = "Local processing: stopped";
    else label = `Local processing: ${st}`;
    text(refs.statusText, label);
    refs.statusDot.className = `status-dot status-dot--${ui.coreError ? "error" : st === "busy" ? "busy" : st === "ready" || st === "idle" ? "ready" : "off"}`;
    text(refs.statusDetail, ui.coreError ? ui.coreError.message : ui.workerInfo?.coreVersion ? `core ${ui.workerInfo.coreVersion}, layout ${ui.workerInfo.layoutVersion}` : ui.workerInfo?.layoutVersion ? `layout ${ui.workerInfo.layoutVersion}` : "");
  }

  function renderProgress() {
    const p = ui.progress;
    show(refs.progressBox, !!p && ui.busy);
    if (p) {
      text(refs.progressStage, p.text ?? `${p.op}: ${p.stage}`);
      const count = Number.isFinite(p.total) && p.total ? `${p.done} / ${p.total}` : Number.isFinite(p.done) ? `${p.done}` : "";
      text(refs.progressCount, count);
      const frac = Number.isFinite(p.total) && p.total ? Math.min(1, p.done / p.total) : null;
      show(refs.progressBar, frac !== null);
      if (frac !== null) refs.progressBarFill.style.width = `${Math.round(frac * 100)}%`;
      text(refs.progressRung, p.rung ? `rung ${p.rungIndex} of ${p.rungCount}: ${p.rung} dB` : "");
      if (p.op === "embed") text(refs.outputNote, p.text ?? "");
    }
  }

  function render() {
    if (destroyed) return;
    const statuses = stepStatuses(session);
    const active = session.activeStep;
    const busy = ui.busy;

    // Step navigator
    statuses.forEach((s, i) => {
      const btn = refs.stepButtons[i];
      btn.dataset.status = s.status;
      setClass(btn, "is-active", s.index === active);
      if (s.index === active) btn.setAttribute("aria-current", "step");
      else btn.removeAttribute("aria-current");
      setDisabled(btn, s.status === "locked");
      text(refs.stepStates[i], s.index === active && busy ? "working" : s.status);
    });
    refs.panels.forEach((panel, i) => show(panel, i + 1 === active));
    setDisabled(refs.resetButton, false);

    // Capability notice
    show(refs.capsBox, !caps.ok || caps.warnings.length > 0);
    text(refs.capsText, [...caps.blockers, ...caps.warnings].join(" "));
    setClass(refs.capsBox, "notice--blocker", !caps.ok);

    // Error / notice
    show(refs.errorBox, !!ui.error);
    text(refs.errorText, ui.error ? `${ui.error.scope}: ${ui.error.message}` : "");
    show(refs.noticeBox, !!ui.notice && !ui.error);
    text(refs.noticeText, ui.notice ?? "");
    renderProgress();
    show(refs.cancelButton, busy);
    renderStatus();

    renderStage();
    renderIdentityPanel(busy);
    renderSourcePanel(busy);
    renderEmbedPanel(busy);
    renderVerifyPanel(busy);
    renderInspectPanel(busy);
    renderInspector();
    renderDetails();
    renderWalkthrough();
  }

  function renderStage() {
    const source = session.source;
    const marked = session.marked;
    // Source frame
    show(refs.sourcePoster, !source);
    show(refs.sourceVideo, !!source);
    if (source) {
      if (refs.sourceVideo.dataset.src !== source.url) {
        refs.sourceVideo.dataset.src = source.url;
        refs.sourceVideo.src = source.url;
        if (source.poster) refs.sourceVideo.poster = source.poster;
        else refs.sourceVideo.removeAttribute("poster");
      }
      text(refs.sourceCaption, `${source.name} · ${source.width}x${source.height} · ${fixed(source.duration, 2)} s · full file shown, excerpt ${source.interval}`);
    } else if (refs.sourceVideo.dataset.src) {
      delete refs.sourceVideo.dataset.src;
      refs.sourceVideo.removeAttribute("src");
      refs.sourceVideo.load();
      text(refs.sourceCaption, "No source loaded. Built-in poster frame shown.");
    } else {
      text(refs.sourceCaption, "No source loaded. Built-in poster frame shown.");
    }
    // Output frame
    const live = ui.busy && ui.progress?.op === "embed";
    show(refs.outputPoster, !marked && !live);
    show(refs.outputCanvas, live);
    show(refs.outputVideo, !!marked && !live);
    show(refs.outputNote, true);
    if (marked && !live) {
      if (refs.outputVideo.dataset.src !== marked.url) {
        refs.outputVideo.dataset.src = marked.url;
        refs.outputVideo.src = marked.url;
      }
      text(refs.outputCaption, `Signed excerpt · ${marked.mimeInfo.container} ${marked.mimeInfo.codec} · ${marked.psnr} dB target · ${formatBytes(marked.blob.size)} · ${marked.frames} frames`);
      text(refs.outputNote, marked.accepted ? "Encoded output. Acceptance check verified this file." : "Encoded output. No rung verified; labeled not verified.");
    } else if (!marked) {
      if (refs.outputVideo.dataset.src) {
        delete refs.outputVideo.dataset.src;
        refs.outputVideo.removeAttribute("src");
        refs.outputVideo.load();
      }
      text(refs.outputCaption, "Signed output");
      if (!live) text(refs.outputNote, session.source ? "Waiting for step 03. The poster stands in for the output." : "Waiting for a source and step 03.");
    }
    // Interval readout
    if (source) {
      text(refs.interval, `Processed excerpt: ${source.interval} · ${SAMPLE_COUNT} frames at ${SAMPLE_FPS} fps · ${source.sampling.text} · ${source.plan.description}`);
    } else if (ui.candidate) {
      const c = ui.candidate;
      text(refs.interval, `Ready to import: ${describeInterval(ui.candidateStart, c.duration)} · will sample ${SAMPLE_COUNT} frames at ${SAMPLE_FPS} fps · ${c.plan.description}`);
    } else {
      text(refs.interval, `Excerpt policy: ${EXCERPT_SECONDS} s sampled into ${SAMPLE_COUNT} frames at ${SAMPLE_FPS} fps, letterboxed into ${CANONICAL.width}x${CANONICAL.height}. Inputs up to 40 MB.`);
    }
  }

  function renderIdentityPanel(busy) {
    const id = session.identity;
    setDisabled(refs.generateButton, busy || !pipeline);
    text(refs.generateButton, id ? "Regenerate identity" : "Generate identity");
    show(refs.identityBox, !!id);
    if (id) {
      text(refs.keyId, id.keyId);
      text(refs.publicKeyHex, groupHex(id.publicKeyHex, 8));
      text(refs.copyKeyButton, ui.copied === "pubkey" ? "Copied" : ui.copied === "pubkey:failed" ? "Copy failed" : "Copy public key");
      text(refs.revealButton, ui.seedRevealed ? "Hide demo key" : "Reveal demo key");
      show(refs.seedBox, ui.seedRevealed);
      text(refs.seedHex, ui.seedRevealed ? groupHex(id.privateKeyHex, 8) : "");
    }
    setDisabled(refs.next2, !id || busy);
  }

  function renderSourcePanel(busy) {
    for (const [tab, btn] of Object.entries(refs.sourceTabs)) {
      setClass(btn, "is-active", ui.sourceTab === tab);
      btn.setAttribute("aria-selected", ui.sourceTab === tab ? "true" : "false");
    }
    for (const [tab, body] of Object.entries(refs.sourceBodies)) show(body, ui.sourceTab === tab);
    setDisabled(refs.useBuiltinButton, busy || !pipeline);
    setDisabled(refs.fileInput, busy || !pipeline);
    setDisabled(refs.urlInput, busy || !pipeline);
    setDisabled(refs.loadUrlButton, busy || !pipeline);
    const c = ui.candidate;
    show(refs.candidateBox, !!c);
    if (c) {
      text(refs.candidateName, `${c.name}${c.size ? ` · ${formatBytes(c.size)}` : ""}`);
      text(refs.candidateDims, `${c.width}x${c.height} · ${fixed(c.duration, 3)} s`);
      refs.startInput.max = String(c.maxStart.toFixed(3));
      if (document.activeElement !== refs.startInput) refs.startInput.value = String(ui.candidateStart.toFixed(3));
      setDisabled(refs.startInput, busy || c.maxStart <= 0);
      text(refs.startHint, c.maxStart <= 0 ? "The clip is exactly 4 s. The whole clip is the excerpt." : `Start between 0 and ${c.maxStart.toFixed(3)} s.`);
      text(refs.candidateInterval, describeInterval(ui.candidateStart, c.duration));
      text(refs.candidatePlan, c.plan.description);
      show(refs.candidateAttribution, !!c.attribution);
      text(refs.candidateAttribution, c.attribution ?? "");
      setDisabled(refs.importButton, busy);
    }
    const s = session.source;
    show(refs.sourceDone, !!s);
    if (s) {
      text(refs.sourceDoneText, `${s.name} imported. ${s.sampling.text}. Capture method: ${s.captureMethod}. Frames are held as lossless PNG in memory (${formatBytes(s.store.bytes)}).`);
    }
    setDisabled(refs.next3, !s || busy);
  }

  function renderEmbedPanel(busy) {
    const check = validateMessage(session.message);
    if (document.activeElement !== refs.messageInput && refs.messageInput.value !== session.message) refs.messageInput.value = session.message;
    if (document.activeElement !== refs.nonceInput && refs.nonceInput.value !== session.nonce) refs.nonceInput.value = session.nonce;
    text(refs.byteCounter, `${check.bytes} / ${MAX_MESSAGE_BYTES} UTF-8 bytes${check.ok ? ` · ${payloadBitLength(check.bytes)} payload bits` : ""}`);
    setClass(refs.byteCounter, "is-invalid", !check.ok);
    text(refs.messageHint, check.ok ? "" : check.message);
    setDisabled(refs.messageInput, busy);
    setDisabled(refs.nonceInput, busy);
    setDisabled(refs.newNonceButton, busy);

    const payload = session.payload;
    const ready = !!session.identity && !!session.source;
    show(refs.signRow, !payload);
    setDisabled(refs.signButton, busy || !ready || !check.ok || !pipeline);
    show(refs.payloadBox, !!payload);
    if (payload) {
      text(refs.payloadBits, `${payload.bitCount} bits`);
      text(refs.payloadBytes, `${payload.messageByteLength} message bytes + 67 framing bytes + 30 parity bytes`);
      text(refs.payloadSig, groupHex(payload.signatureHex, 16));
    }
    const strength = session.strength;
    refs.modeSelect.value = strength.mode;
    refs.psnrSelect.value = String(strength.psnr);
    setDisabled(refs.modeSelect, busy || !payload);
    setDisabled(refs.psnrSelect, busy || !payload || strength.mode !== "manual");
    text(refs.strengthHint, strength.mode === "auto" ? `Closed loop: try ${LADDER.join(", ")} dB in order. Each rung is encoded, decoded, and verified. The first rung that verifies is kept.` : `Manual: encode once at ${strength.psnr} dB and verify the encoded output. No automatic descent.`);
    setDisabled(refs.embedButton, busy || !canEmbed(session) || !caps.ok || !pipeline || !session.nonce.trim());
    text(refs.embedButton, session.marked ? "Embed again" : "Embed into excerpt");
    text(refs.codecLine, caps.recorder.mime ? `Output: ${describeMime(caps.recorder.mime).container} ${describeMime(caps.recorder.mime).codec} via MediaRecorder, ${OUTPUT_BITRATE / 1e6} Mbit/s requested` : "Output: no supported recorder format in this browser");

    const m = session.marked;
    show(refs.markedBox, !!m);
    if (m) {
      setClass(refs.markedBox, "is-rejected", !m.accepted);
      text(refs.markedSummary, m.accepted ? `Accepted at ${m.psnr} dB after ${m.ladder.length} rung${m.ladder.length === 1 ? "" : "s"}.` : `No rung verified. Last output at ${m.psnr} dB is kept and labeled not verified.`);
      text(refs.markedCodec, `${m.mimeInfo.container} ${m.mimeInfo.codec} · "${m.mime}" · ${formatBytes(m.blob.size)} · ${m.frames} frames · recorded in ${formatMs(m.wallMs)}${m.lateFrames ? ` · ${m.lateFrames} frames paced late` : ""} · ${m.captureMode}`);
      const rows = m.ladder.map((r) => `${r.psnr} dB: ${r.verified ? "verified" : "not verified"}${r.reason ? ` (${r.reason})` : ""}${Number.isInteger(r.correctedSymbols) ? `, ${r.correctedSymbols} RS symbols corrected` : ""}, ${r.framesRead} frames read`);
      text(refs.ladderList, rows.join("\n"));
      setDisabled(refs.downloadVideoButton, busy);
      setDisabled(refs.downloadMetadataButton, busy);
    }
    setDisabled(refs.next4, !m || busy);
  }

  function renderVerifyPanel(busy) {
    const m = session.marked;
    const v = session.verification;
    setDisabled(refs.verifyButton, busy || !m || !pipeline);
    text(refs.verifyButton, v ? "Extract and verify again" : "Extract and verify");
    const vm = verdictViewModel(v?.result ?? null, { publicKeyHex: v?.publicKeyHex ?? session.identity?.publicKeyHex });
    fillVerdict(refs.mainVerdict, vm, v ? { frames: v.read?.frames, method: v.read?.method, rows: v.rowCount, resized: v.read?.resized } : null);
    show(refs.mainVerdict.root, !!v);
    setDisabled(refs.wrongKeyButton, busy || !v || !pipeline);
    setDisabled(refs.unmarkedButton, busy || !v || !session.source || !pipeline);
    show(refs.wrongVerdict.root, !!ui.wrongKey);
    if (ui.wrongKey) fillVerdict(refs.wrongVerdict, verdictViewModel(ui.wrongKey.res.result, { publicKeyHex: ui.wrongKey.publicKeyHex }), { rows: ui.wrongKey.res.rowCount, note: "Same evidence rows, a freshly generated unrelated public key." });
    show(refs.unmarkedVerdict.root, !!ui.unmarked);
    if (ui.unmarked) fillVerdict(refs.unmarkedVerdict, verdictViewModel(ui.unmarked.res.result, { publicKeyHex: ui.unmarked.publicKeyHex }), { rows: ui.unmarked.res.rowCount, frames: ui.unmarked.res.read?.frames, method: ui.unmarked.res.read?.method, note: "Evidence extracted from the unmarked sampled source frames." });

    // External verification
    setDisabled(refs.verifyFileInput, busy || !pipeline);
    setDisabled(refs.verifyMetadataInput, busy || !pipeline);
    setDisabled(refs.verifyKeyInput, busy);
    const meta = ui.externalMeta;
    text(refs.externalMetaText, meta ? (meta.ok ? `${meta.fileName}: nonce ${meta.metadata.nonce}, ${meta.metadata.bitCount} bits, ${meta.metadata.groups} groups x K=${meta.metadata.runLength}${meta.ignoredFields.length ? `. Ignored claimed fields: ${meta.ignoredFields.join(", ")}.` : ""}` : `${meta.fileName}: ${meta.message}`) : "");
    setClass(refs.externalMetaText, "is-invalid", !!meta && !meta.ok);
    setDisabled(refs.verifyExternalButton, busy || !pipeline || !meta?.ok);
    show(refs.externalVerdict.root, !!ui.external);
    if (ui.external) {
      const r = ui.external.res;
      fillVerdict(refs.externalVerdict, verdictViewModel(r.result, { publicKeyHex: ui.external.publicKeyHex }), { frames: r.read?.frames, method: r.read?.method, rows: r.rowCount, resized: r.read?.resized, note: `${ui.external.fileName}` });
    }
    setDisabled(refs.next5, !m || busy);
  }

  function renderInspectPanel(busy) {
    const m = session.marked;
    const ins = session.inspect;
    setDisabled(refs.inspectButton, busy || !m || !pipeline);
    text(refs.inspectButton, ins ? "Recompute from frame 0" : "Compute spectrum and residual");
    show(refs.inspectBox, !!ins);
    for (const [k, btn] of Object.entries(refs.spectrumToggles)) {
      setClass(btn, "is-active", ui.spectrumView === k);
      btn.setAttribute("aria-pressed", ui.spectrumView === k ? "true" : "false");
    }
    for (const [k, btn] of Object.entries(refs.residualToggles)) {
      setClass(btn, "is-active", ui.residualView === k);
      btn.setAttribute("aria-pressed", ui.residualView === k ? "true" : "false");
    }
    refs.gainSelect.value = String(ui.gain);
    refs.binsCheckbox.checked = ui.showBins;
    setDisabled(refs.gainSelect, busy || !ins);
    if (!ins) {
      text(refs.spectrumLabel, m ? "Press the button to compute the Cr spectrum and residual of frame 0 from the actual planes." : "Available after step 03.");
      text(refs.residualLabel, "");
      return;
    }
    const spec = ui.spectrumView === "source" ? ins.spectrumSource : ui.spectrumView === "output" ? ins.spectrumOutput : ins.spectrumMarked;
    const band = m.layout.summary.band;
    drawSpectrum(refs.spectrumCanvas, spec, { band, bins: m.layout.summary.bins, showBins: ui.showBins });
    const binNote = m.layout.summary.bins ? "Dots: the actual nonce-derived carrier bins of the four groups and their conjugates." : "Bin positions are not exposed by this core build.";
    text(refs.spectrumLabel, spec ? `Cr spectrum of frame 0 (${spec.label}). ${spec.scale}. DC centered. Dashed ellipses: the ${band ? `${band.lo} to ${band.hi}` : "carrier"} cycles/pixel band. ${ui.showBins ? binNote : ""}${Number.isFinite(spec.min) ? ` Range ${fixed(spec.min, 2)} to ${fixed(spec.max, 2)}.` : ""}` : "This spectrum is not available (frame missing).");
    const res = ui.residualView === "output" ? ins.residualOutput : ins.residualCarrier;
    drawResidual(refs.residualCanvas, res);
    text(refs.residualLabel, res ? `Residual ${res.label}, amplified x${res.gain} around gray 128. Measured over RGB of frame 0: PSNR ${fixed(res.stats.psnr, 2)} dB, max |difference| ${res.stats.maxAbs}, mean |difference| ${fixed(res.stats.meanAbs, 3)}.` : "This residual is not available (frame missing).");
    const fg = session.verification?.frameGroups ?? m.acceptance?.frameGroups ?? [];
    const tl = drawGroupTimeline(refs.groupsCanvas, fg, m.layout.summary.groups ?? 4);
    text(refs.groupsLabel, fg.length ? `Per-frame group assigned by correlation energy while decoding the output (${fg.length} frames, counts ${tl.counts.join(" / ")}). The verifier never reads a frame index.` : "Run step 04 to see per-frame group identification.");
  }

  function renderInspector() {
    const id = session.identity;
    const p = session.payload;
    const s = session.source;
    const m = session.marked;
    const v = session.verification;
    text(refs.recIdentity, id ? `key id ${id.keyId} · Ed25519 public key ${id.publicKeyHex.slice(0, 16)}...` : "not generated");
    text(refs.recPayload, p ? `${p.messageByteLength} bytes → ${p.bitCount} bits · signature ${p.signatureHex.slice(0, 16)}...` : "not signed");
    const ls = m?.layout?.summary;
    text(refs.recLayout, ls ? `${ls.version} · nonce ${m.nonce} · ${ls.groups} groups x ${ls.binsPerGroup?.[0] ?? "?"} bins · K=${ls.runLength} · band ${ls.band ? `${ls.band.lo} to ${ls.band.hi}` : "?"} · pool ${ls.poolSize ?? "?"}` : session.nonce ? `nonce ${session.nonce} · created at embed time` : "no nonce");
    text(refs.recSource, s ? `${s.name} · ${s.width}x${s.height} · excerpt ${s.interval} · ${s.sampling.text}` : ui.candidate ? `${ui.candidate.name} prepared, not imported` : "none");
    text(refs.recOutput, m ? `${m.mimeInfo.container} ${m.mimeInfo.codec} · ${m.psnr} dB · ${formatBytes(m.blob.size)} · ${m.accepted ? "accepted" : "not verified"}` : "none");
    const vm = verdictViewModel(v?.result ?? null, { publicKeyHex: v?.publicKeyHex });
    text(refs.recVerify, v ? `${vm.label} · ${vm.reason}` : "not run");
    setClass(refs.recVerify, "is-verified", vm.state === "verified");
    setClass(refs.recVerify, "is-rejected", vm.state === "rejected" || vm.state === "inconsistent");

    const ctx = {
      names: ui.coreNames,
      sdkSrc: opts.sdkSrc,
      publicKeyHex: id?.publicKeyHex,
      message: session.message,
      nonce: session.nonce,
      bitCount: p?.bitCount,
      psnr: m?.psnr ?? session.strength.psnr,
      runLength: ls?.runLength ?? 30,
      groups: ls?.groups ?? 4,
    };
    text(refs.codeTitle, `SDK call for step 0${session.activeStep}`);
    text(refs.codePane, codeForStep(session.activeStep, ctx));
    text(refs.copyCodeButton, ui.copied === "code" ? "Copied" : ui.copied === "code:failed" ? "Copy failed" : "Copy");
    text(refs.embedSnippet, embedSnippet(opts.widgetSrc));
    text(refs.apiImport, sdkImportLine(ui.coreNames, opts.sdkSrc));
    text(refs.apiNames, ui.coreNames ? Object.entries(ui.coreNames).map(([role, name]) => `${role}: ${name ?? "missing"}`).join("\n") : ui.coreError ? `core failed to load: ${ui.coreError.message}` : "loading core exports");
  }

  // ---- walkthrough -------------------------------------------------------

  /** The live progress line for the running card. Real counts only. */
  function progressText() {
    const p = ui.progress;
    if (!p || !ui.busy) return null;
    if (p.text) return p.text;
    const count = Number.isFinite(p.total) && p.total ? ` (${p.done} of ${p.total})` : Number.isFinite(p.done) ? ` (${p.done})` : "";
    return `${p.op}: ${p.stage}${count}`;
  }

  function renderWalkthrough() {
    if (destroyed || !refs.walkCards) return;
    const cards = buildWalkthrough({
      session,
      controls: { wrongKey: ui.wrongKey, unmarked: ui.unmarked },
      timings: walk.timings,
      status: { phase: walk.phase, current: walk.current, failedStep: walk.failedStep, cancelledStep: walk.cancelledStep, error: walk.error, progressText: progressText() },
    });
    for (const card of cards) {
      const el = refs.walkCards[card.id];
      if (!el) continue;
      el.root.dataset.status = card.status;
      text(el.title, card.title);
      text(el.status, WALK_STATUS_LABEL[card.status] ?? card.status);
      text(el.summary, card.summary);
      const key = JSON.stringify([card.facts, card.notes]);
      if (el.key !== key) {
        el.key = key;
        el.facts.replaceChildren(
          ...card.facts.map((f) => h("div", { class: `wfact${f.full ? " wfact--full" : ""}${/^[0-9a-f]{32,}$/i.test(String(f.value)) ? " wfact--hex" : ""}` }, h("dt", { class: "k" }, f.label), h("dd", { class: f.mono ? "mono" : "" }, String(f.value)))),
        );
        el.notes.replaceChildren(...card.notes.map((n) => h("p", { class: "wnote" }, n)));
      }
      if (card.id === "inspect") renderWalkInspect(el);
    }
    renderRunStatus(cards);
  }

  /** Spectrum and residual canvases in the inspection card, drawn from the same inspect result as the detailed panel. */
  function renderWalkInspect(el) {
    const ins = session.inspect;
    const m = session.marked;
    show(el.visual, !!ins);
    if (!ins) {
      el.drawn = null;
      return;
    }
    if (el.drawn === ins) return;
    el.drawn = ins;
    const summary = m?.layout?.summary;
    const spec = ins.spectrumOutput ?? ins.spectrumMarked ?? ins.spectrumSource ?? null;
    drawSpectrum(el.spectrumCanvas, spec, { band: summary?.band, bins: summary?.bins, showBins: true });
    const frame = Number.isInteger(ins.frameIndex) ? `frame ${ins.frameIndex}` : "the inspected frame";
    const bandText = summary?.band ? ` Dashed ellipses: the ${summary.band.lo} to ${summary.band.hi} cycles per pixel carrier band.` : "";
    const binText = summary?.bins ? ` Dots: the nonce-derived carrier bins of the ${summary.groups ?? "four"} groups and their conjugates.` : "";
    text(el.spectrumLabel, spec ? `Cr spectrum of ${frame} (${spec.label}). ${spec.scale}. DC centered.${bandText}${binText}` : "No spectrum is available for this frame.");
    const res = ins.residualCarrier ?? ins.residualOutput ?? null;
    drawResidual(el.residualCanvas, res);
    text(el.residualLabel, res ? `Residual ${res.label}, amplified x${res.gain} around gray 128. Measured over RGB of ${frame}: PSNR ${fixed(res.stats?.psnr, 2)} dB.` : "No residual is available for this frame.");
  }

  /** The line under the masthead button. Step numbers and times come from the cards and the recorded timings. */
  function renderRunStatus(cards) {
    setDisabled(refs.runButton, ui.busy || !pipeline);
    show(refs.runCancelButton, ui.busy);
    let line = "";
    if (ui.busy) {
      const running = cards.find((c) => c.status === "running");
      if (walk.mode === "demo") line = running ? `Running step ${running.index} of ${cards.length}: ${running.title}.` : "Starting the run.";
      else line = running ? `Running: ${running.title}.` : "Working.";
    } else if (walk.mode === "demo" && walk.phase === "done") {
      const total = Object.values(walk.timings).reduce((acc, ms) => acc + (Number.isFinite(ms) ? ms : 0), 0);
      line = `All ${cards.length} steps completed in ${formatDuration(total)}. The walkthrough below was written from this run.`;
    } else if (walk.mode === "demo" && walk.phase === "failed") {
      const c = cards.find((x) => x.status === "failed");
      line = c ? `Stopped at step ${c.index}, ${c.title}: ${walk.error ?? "no error message"}` : `Stopped: ${walk.error ?? "no error message"}`;
    } else if (walk.mode === "demo" && walk.phase === "cancelled") {
      const c = cards.find((x) => x.status === "cancelled");
      line = c ? `Cancelled at step ${c.index}, ${c.title}.` : "Cancelled.";
    } else if (!pipeline) {
      line = ui.coreError ? `The core library did not load: ${ui.coreError.message}` : "Starting the local worker.";
    } else {
      line = "One click runs every step on the built-in excerpt in this tab. The walkthrough below is written from the data the run produces.";
    }
    text(refs.runStatus, line);
  }

  /** The detailed controls collapse to a 1 px, inert box rather than display: none, so the recorder canvas inside keeps producing frames. */
  function renderDetails() {
    const open = ui.detailsOpen;
    setClass(refs.operate, "is-collapsed", !open);
    if (open) {
      refs.operate.removeAttribute("inert");
      refs.operate.removeAttribute("aria-hidden");
    } else {
      refs.operate.setAttribute("inert", "");
      refs.operate.setAttribute("aria-hidden", "true");
    }
    refs.detailsToggle.setAttribute("aria-expanded", open ? "true" : "false");
    text(refs.detailsToggle, open ? "Hide the detailed controls" : "Show the detailed controls");
  }


  fetch(BUILTIN.attributionUrl)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
    .then((t) => text(refs.attribution, t))
    .catch(() => text(refs.attribution, `${BUILTIN.attribution} Attribution file could not be loaded.`));

  refs.messageInput.value = session.message;
  refs.nonceInput.value = session.nonce;
  render();

  return {
    root,
    capabilities: caps,
    coreReady,
    get pipeline() {
      return pipeline;
    },
    get sdk() {
      return coreMod?.sdk ?? null;
    },
    getState() {
      return { session, ui: { ...ui } };
    },
    destroy() {
      destroyed = true;
      pipeline?.destroy();
      root.replaceChildren();
    },
  };
}

function safeNonce() {
  try {
    return randomNonce();
  } catch {
    return "";
  }
}

// ---- verdict block -------------------------------------------------------

function buildVerdictBlock(testid, title) {
  const b = {};
  b.label = h("span", { class: "verdict-label mono", testid: `${testid}-status` }, "Not run");
  b.reason = h("p", { class: "verdict-reason", testid: `${testid}-reason` });
  b.message = h("code", { class: "verdict-value", testid: `${testid}-message` });
  b.signature = h("code", { class: "verdict-value mono wrap", testid: `${testid}-signature` });
  b.corrected = h("span", { class: "mono", testid: `${testid}-corrected` });
  b.groups = h("span", { class: "mono", testid: `${testid}-groups` });
  b.frames = h("span", { class: "mono", testid: `${testid}-frames` });
  b.key = h("span", { class: "mono", testid: `${testid}-key` });
  b.note = h("p", { class: "verdict-note" });
  b.messageRow = h("div", { class: "kv" }, h("span", { class: "k" }, "Recovered message"), b.message);
  b.messageFlag = h("span", { class: "flag" });
  b.root = h(
    "section",
    { class: "verdict", testid, "aria-live": "polite" },
    h("header", { class: "verdict-head" }, h("h4", {}, title), b.label),
    b.reason,
    b.note,
    b.messageRow,
    h("div", { class: "kv" }, h("span", { class: "k" }, "Recovered signature (64 bytes)"), b.signature),
    h("div", { class: "kv-grid" }, h("div", { class: "kv" }, h("span", { class: "k" }, "RS symbols corrected"), b.corrected), h("div", { class: "kv" }, h("span", { class: "k" }, "Frames per group"), b.groups), h("div", { class: "kv" }, h("span", { class: "k" }, "Frames decoded / rows"), b.frames), h("div", { class: "kv" }, h("span", { class: "k" }, "Public key used"), b.key)),
  );
  b.messageRow.append(b.messageFlag);
  return b;
}

function fillVerdict(b, vm, extra) {
  text(b.label, vm.label);
  b.root.dataset.state = vm.state;
  text(b.reason, vm.reason ?? "");
  text(b.message, vm.messageText ?? (vm.state === "pending" ? "" : "no decodable message"));
  text(b.messageFlag, vm.messageIsUnverified ? "recovered bytes, signature not valid under this key" : vm.state === "verified" ? `${vm.messageByteLength} bytes, signature valid` : "");
  text(b.signature, vm.signatureHex ? groupHex(vm.signatureHex, 16) : "none");
  text(b.corrected, Number.isInteger(vm.correctedSymbols) ? String(vm.correctedSymbols) : "-");
  text(b.groups, vm.groupCounts ? vm.groupCounts.join(" / ") : "-");
  text(b.frames, extra ? `${extra.frames ?? "-"} / ${extra.rows ?? "-"}${extra.method ? ` (${extra.method})` : ""}${extra.resized ? " · input was not 1024x512 and was letterboxed" : ""}` : "-");
  text(b.key, vm.keyId ? `${vm.keyId}... (${vm.publicKeyHex.length / 2} bytes)` : "-");
  text(b.note, extra?.note ?? "");
}

// ---- shell ---------------------------------------------------------------

function buildShell(refs, handlers, opts, caps) {
  const on = (name) => (...args) => handlers[name]?.(...args);

  refs.statusDot = h("span", { class: "status-dot status-dot--off", "aria-hidden": "true" });
  refs.statusText = h("span", { class: "status-text", testid: "processing-status" }, "Local processing: starting");
  refs.statusDetail = h("span", { class: "status-detail mono" });

  const topbar = h(
    "header",
    { class: "topbar" },
    h("div", { class: "brand" }, h("span", { class: "brand-name" }, "Asymmetric Phase Coding Video Watermarking"), h("span", { class: "tag mono" }, "v1 Preview")),
    h(
      "nav",
      { class: "toplinks", "aria-label": "Site" },
      h("a", { href: opts.paperHref, target: "_blank", rel: "noopener", testid: "link-paper" }, "Paper"),
      h("a", { href: "#api", testid: "link-api", onclick: (e) => scrollTo(e, refs.apiSection) }, "API"),
      h("a", { href: "#learn", testid: "link-learn", onclick: (e) => scrollTo(e, refs.learnSection) }, "Learn"),
    ),
    h("div", { class: "status", role: "status" }, refs.statusDot, refs.statusText, refs.statusDetail),
  );

  // Phi Lab Foundation mark, used as a faint hero watermark exactly as on philab.fund (opacity 0.05, fixed px, 1:1).
  refs.deco = h("img", { class: "hero-watermark", src: withBase("/brand/phi-mark-black.png"), alt: "", "aria-hidden": "true", width: 1200, height: 1043 });
  // The one-click runner sits right after the headline and lede, so on phones it is the first interactive element after the headline.
  refs.runButton = h("button", { type: "button", class: "btn btn-primary btn-run", testid: "run-demo", onclick: on("runAll") }, "Run the full demonstration");
  refs.runCancelButton = h("button", { type: "button", class: "btn btn-ghost", testid: "run-cancel", onclick: on("cancel"), hidden: true }, "Cancel");
  refs.runStatus = h("p", { class: "run-status", testid: "run-status", "aria-live": "polite" });
  const masthead = h(
    "section",
    { class: "masthead" },
    h(
      "div",
      { class: "masthead-text" },
      h("p", { class: "kicker mono" }, "Public-key video watermarking. Browser demonstration."),
      h("h1", { class: "headline" }, HEADLINE),
      h("p", { class: "subhead" }, SUBHEAD),
      h(
        "p",
        { class: "authors", testid: "authors" },
        ...AUTHORS.flatMap((a, i) => [
          i > 0 ? h("span", { class: "author-sep", "aria-hidden": "true" }, " · ") : null,
          h("span", { class: "author" }, h("span", { class: "author-name" }, a.name), h("span", { class: "author-affil" }, a.affiliation)),
        ].filter(Boolean)),
      ),
      h(
        "p",
        { class: "paper-ref mono" },
        "Paper: ",
        h("a", { href: PAPER_URL, target: "_blank", rel: "noopener", testid: "link-paper-hero" }, "arXiv:2608.29212"),
        " · cs.CR, cs.CV, cs.GR · 2026",
      ),
      h("p", { class: "lede" }, LEDE),
      h("div", { class: "run-row" }, refs.runButton, refs.runCancelButton),
      refs.runStatus,
      h("p", { class: "run-hint small" }, "About 20 seconds. Keep this tab in the foreground: browsers pause video frame callbacks in background tabs, and the run waits until you return."),
      h("p", { class: "meta mono" }, "Ed25519 · Cr phase carrier · run-length groups G=4, K=30 · browser-local · identity geometry only"),
    ),
    refs.deco,
  );

  // Protocol navigator
  refs.stepButtons = [];
  refs.stepStates = [];
  const nav = h(
    "nav",
    { class: "protocol", "aria-label": "Protocol steps" },
    h(
      "ol",
      {},
      STEPS.map((s, i) => {
        refs.stepStates[i] = h("span", { class: "step-state mono" }, "locked");
        const btn = h("button", { type: "button", class: "step", testid: `step-0${s.index}`, dataset: { step: String(s.index) }, onclick: () => on("step")(s.index) }, h("span", { class: "step-num mono" }, `0${s.index}`), h("span", { class: "step-title" }, s.title), refs.stepStates[i]);
        refs.stepButtons[i] = btn;
        return h("li", {}, btn);
      }),
    ),
    (refs.resetButton = h("button", { type: "button", class: "btn btn-ghost", testid: "reset-session", onclick: on("reset") }, "Reset session")),
  );

  // Stage
  refs.sourcePoster = h("img", { class: "poster", src: BUILTIN.poster, alt: "Poster frame of the built-in Sintel excerpt", width: 1024, height: 512 });
  refs.sourceVideo = h("video", { class: "stage-video", testid: "video-source", controls: true, muted: true, playsinline: true, preload: "metadata", hidden: true });
  refs.sourceCaption = h("span", { class: "caption-detail mono" });
  refs.outputPoster = h("img", { class: "poster poster--waiting", src: BUILTIN.poster, alt: "Poster frame standing in for the signed output", width: 1024, height: 512 });
  refs.outputCanvas = h("canvas", { class: "stage-canvas", testid: "canvas-output", width: CANONICAL.width, height: CANONICAL.height, hidden: true, "aria-label": "Live marked frames feeding the recorder" });
  refs.outputVideo = h("video", { class: "stage-video", testid: "video-marked", controls: true, muted: true, playsinline: true, preload: "metadata", hidden: true });
  refs.outputCaption = h("span", { class: "caption-detail mono" }, "Signed output");
  refs.outputNote = h("div", { class: "frame-note mono", testid: "output-note" });
  refs.interval = h("p", { class: "interval mono", testid: "interval-readout" });

  refs.progressStage = h("span", { class: "progress-stage", testid: "progress-stage" });
  refs.progressCount = h("span", { class: "progress-count mono", testid: "progress-count" });
  refs.progressRung = h("span", { class: "progress-rung mono", testid: "progress-rung" });
  refs.progressBarFill = h("span", { class: "bar-fill" });
  refs.progressBar = h("span", { class: "bar", hidden: true }, refs.progressBarFill);
  refs.cancelButton = h("button", { type: "button", class: "btn btn-ghost", testid: "cancel", onclick: on("cancel"), hidden: true }, "Cancel");
  refs.progressBox = h("div", { class: "progress", testid: "progress", "aria-live": "polite", hidden: true }, h("div", { class: "progress-row" }, refs.progressStage, refs.progressCount, refs.progressRung), refs.progressBar);
  refs.errorText = h("span", { testid: "error-text" });
  refs.errorBox = h("div", { class: "notice notice--error", role: "alert", testid: "error", hidden: true }, refs.errorText);
  refs.noticeText = h("span", { testid: "notice-text" });
  refs.noticeBox = h("div", { class: "notice", testid: "notice", hidden: true }, refs.noticeText);
  refs.capsText = h("span", { testid: "capabilities-text" });
  refs.capsBox = h("div", { class: "notice", testid: "capabilities", hidden: true }, refs.capsText);

  const stageGrid = h(
    "div",
    { class: "stage-grid" },
    h("figure", { class: "frame", testid: "frame-source" }, h("figcaption", {}, h("span", { class: "caption-title" }, "Source"), refs.sourceCaption), h("div", { class: "frame-body" }, refs.sourcePoster, refs.sourceVideo)),
    h("figure", { class: "frame", testid: "frame-marked" }, h("figcaption", {}, h("span", { class: "caption-title" }, "Signed output"), refs.outputCaption), h("div", { class: "frame-body" }, refs.outputPoster, refs.outputCanvas, refs.outputVideo, refs.outputNote)),
  );

  // Panels
  refs.panels = [buildIdentityPanel(refs, on), buildSourcePanel(refs, on), buildEmbedPanel(refs, on, caps), buildVerifyPanel(refs, on), buildInspectPanel(refs, on)];

  const stage = h("section", { class: "stage" }, stageGrid, refs.interval, h("div", { class: "stage-messages" }, refs.capsBox, refs.errorBox, refs.noticeBox, h("div", { class: "progress-wrap" }, refs.progressBox, refs.cancelButton)), ...refs.panels);

  // Inspector
  refs.recIdentity = h("dd", { class: "mono", testid: "record-identity" });
  refs.recPayload = h("dd", { class: "mono", testid: "record-payload" });
  refs.recLayout = h("dd", { class: "mono", testid: "record-layout" });
  refs.recSource = h("dd", { class: "mono", testid: "record-source" });
  refs.recOutput = h("dd", { class: "mono", testid: "record-output" });
  refs.recVerify = h("dd", { class: "mono", testid: "record-verification" });
  refs.codeTitle = h("h3", {}, "SDK call");
  refs.codePane = h("code", { testid: "code-pane" });
  refs.copyCodeButton = h("button", { type: "button", class: "btn btn-ghost btn-small", testid: "copy-code", onclick: () => handlers.copy?.("code", refs.codePane.textContent) }, "Copy");
  refs.embedSnippet = h("code", { testid: "embed-snippet" });
  const inspector = h(
    "aside",
    { class: "inspector", "aria-label": "Protocol record" },
    h("section", { class: "record" }, h("h3", {}, "Record"), h("dl", {}, h("dt", {}, "Identity"), refs.recIdentity, h("dt", {}, "Payload"), refs.recPayload, h("dt", {}, "Layout"), refs.recLayout, h("dt", {}, "Source"), refs.recSource, h("dt", {}, "Output"), refs.recOutput, h("dt", {}, "Verification"), refs.recVerify)),
    h("section", { class: "code" }, h("header", { class: "code-head" }, refs.codeTitle, refs.copyCodeButton), h("pre", {}, refs.codePane)),
    h("section", { class: "code code--embed" }, h("h3", {}, "One-element embed"), h("p", { class: "small" }, "Same-origin page, after loading the bundle. Shadow DOM isolates the styles."), h("pre", {}, refs.embedSnippet)),
  );

  refs.operateHead = h(
    "header",
    { class: "section-head operate-head" },
    h("span", { class: "section-kicker mono" }, "Part 2 · Detailed controls"),
    h("h2", { class: "section-title" }, "Run each step by hand"),
    h("p", { class: "section-intro" }, "Load your own video, edit the message, choose the strength, download the signed file, and verify a downloaded file against a public key."),
  );
  refs.operate = h("main", { class: "operate", id: "operate" }, nav, stage, inspector);

  // Walkthrough: seven card shells in run order, filled by renderWalkthrough from real data.
  const walkthrough = buildWalkthroughSection(refs, on);

  // Learn
  refs.attribution = h("pre", { class: "attribution", testid: "attribution" }, "Loading attribution.");
  refs.apiImport = h("code", { testid: "api-import" });
  refs.apiNames = h("code", { testid: "api-names" });
  refs.apiSection = h(
    "section",
    { class: "learn-block", id: "api" },
    h("h3", {}, "API"),
    h("p", {}, "The interface calls the same library that developers import. Function names below are the exports that resolved in this build."),
    h("pre", {}, refs.apiImport),
    h("pre", { class: "small" }, refs.apiNames),
    h("p", { class: "small" }, "Layout version apcvw-js-v1 uses a SHA-256 counter PRNG. It is not byte-compatible with the Python reference layouts for the same nonce. Canonical frame size in this preview: 1024x512."),
  );
  refs.learnSection = h(
    "section",
    { class: "learn", id: "learn" },
    h(
      "header",
      { class: "section-head" },
      h("span", { class: "section-kicker mono" }, "Part 3 · Background"),
      h("h2", { class: "section-title learn-title" }, "Protocol, scope, API, and paper"),
    ),
    h(
      "div",
      { class: "learn-grid" },
      h(
        "section",
        { class: "learn-block" },
        h("h3", {}, "Protocol"),
        h(
          "ol",
          { class: "protocol-list" },
          h("li", {}, "The signer holds an Ed25519 private key. The payload is a flag byte, a 2-byte length, the message, the 64-byte signature, and 30 Reed-Solomon parity bytes."),
          h("li", {}, "Each payload bit sets the phase of one mid-band bin (0.05 to 0.12 cycles per pixel) of the Cr chroma plane. Bin positions and phases derive from a public per-video nonce."),
          h("li", {}, "The bits split into four groups. Each group occupies 30 consecutive frames and the cycle repeats. The decoder assigns a frame to a group by correlation, never by frame index."),
          h("li", {}, "The signer tests its own output with the public verifier at 42, 40, 38, 36 dB and reserve rungs 34 and 32 dB. The first rung that verifies ships."),
          h("li", {}, "A verifier needs the public key, the nonce, the payload length, and the canonical size. It recovers the message and signature from pixels and checks the signature."),
        ),
      ),
      h(
        "section",
        { class: "learn-block" },
        h("h3", {}, "Verification scope"),
        h("p", { testid: "scope-note" }, SCOPE_NOTE),
        h(
          "details",
          { class: "limits", testid: "limits" },
          h("summary", {}, "Protocol and limits"),
          h(
            "ul",
            {},
            h("li", {}, "Identity geometry only. Rotation, scaling, and cropping robustness are not implemented in this browser demo."),
            h("li", {}, "The output codec is whatever MediaRecorder supports here, typically WebM VP9 or VP8. The paper measured H.264. Browser results are separate evidence and inherit no published rates."),
            h("li", {}, "The demo processes a four second excerpt sampled into 120 frames at 30 fps and letterboxed to 1024x512. It never labels that excerpt as the whole original file."),
            h("li", {}, "Inputs are limited to 40 MB and at least 4 s. Remote URLs must allow CORS. There is no proxy and no upload."),
            h("li", {}, "The signature binds the message bytes, not the pixels. Copying a signed carrier into other footage is not prevented by this version."),
            h("li", {}, "Demo keys are random and live only in this tab. Revealing the seed is for demonstration. Nothing is persisted."),
            h("li", {}, "A NOT VERIFIED answer is not evidence of forgery. It can result from degradation, a wrong key, wrong metadata, or unmarked video."),
          ),
        ),
      ),
      refs.apiSection,
      h(
        "section",
        { class: "learn-block" },
        h("h3", {}, "Paper and authors"),
        h("p", { class: "cite-title" }, "Asymmetric Phase Coding Video Watermarking"),
        h("p", {}, "Guang Yang (Phi Lab Foundation) and Fengchen Liu (University of California, Berkeley). arXiv:2608.29212, submitted 29 August 2026. Subjects: cs.CR, cs.CV, cs.GR."),
        h("p", {}, h("a", { href: PAPER_URL, target: "_blank", rel: "noopener", testid: "link-paper-learn" }, "Read the paper on arXiv")),
        h("p", { class: "small" }, "This demonstration implements the browser-local, identity-geometry subset of the protocol described in the paper. Published rates were measured with the Python reference implementation and H.264, not with this page."),
      ),
      h("section", { class: "learn-block" }, h("h3", {}, "Attribution"), refs.attribution),
    ),
  );

  refs.hiddenHost = h("div", { class: "hidden-host", "aria-hidden": "true" });
  const footer = h("footer", { class: "foot mono" }, "Asymmetric Phase Coding Video Watermarking, v1 Preview. Runs locally in this browser. No uploads, no accounts, no analytics.");

  function scrollTo(e, el) {
    e.preventDefault();
    el?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }

  const detailsSection = h(
    "section",
    { class: "details", id: "details" },
    refs.operateHead,
    h("div", { class: "details-bar" }, refs.detailsToggle),
    refs.operate,
  );
  return h("div", { class: "shell" }, topbar, masthead, walkthrough, detailsSection, refs.learnSection, footer, refs.hiddenHost);
}

const WALK_STATUS_LABEL = Object.freeze({ pending: "Pending", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" });

/** Card shells for the walkthrough. Titles, statuses, facts, and notes are filled from buildWalkthrough at render time. */
function buildWalkthroughSection(refs, on) {
  refs.walkCards = {};
  const items = CARD_ORDER.map((id, i) => {
    const el = {};
    el.title = h("h3", { class: "walk-title" });
    el.status = h("span", { class: "walk-status mono", testid: `walk-${id}-status` }, WALK_STATUS_LABEL.pending);
    el.summary = h("p", { class: "walk-summary" });
    el.facts = h("dl", { class: "walk-facts", testid: `walk-${id}-facts` });
    el.notes = h("div", { class: "walk-notes" });
    const children = [h("header", { class: "walk-head" }, h("span", { class: "walk-num mono" }, `0${i + 1}`), el.title, el.status), el.summary, el.facts];
    if (id === "inspect") {
      el.spectrumCanvas = h("canvas", { class: "inspect-canvas", testid: "walk-canvas-spectrum", width: CANONICAL.width, height: CANONICAL.height, "aria-label": "Log-power Cr spectrum of the inspected frame with the carrier band overlay" });
      el.residualCanvas = h("canvas", { class: "inspect-canvas", testid: "walk-canvas-residual", width: CANONICAL.width, height: CANONICAL.height, "aria-label": "Amplified residual image of the inspected frame" });
      el.spectrumLabel = h("p", { class: "small", testid: "walk-spectrum-label" });
      el.residualLabel = h("p", { class: "small", testid: "walk-residual-label" });
      el.visual = h(
        "div",
        { class: "walk-visual", hidden: true },
        h("figure", { class: "walk-figure" }, el.spectrumCanvas, h("figcaption", {}, el.spectrumLabel)),
        h("figure", { class: "walk-figure" }, el.residualCanvas, h("figcaption", {}, el.residualLabel)),
      );
      children.push(el.visual);
    }
    children.push(el.notes);
    el.root = h("li", { class: "walk-card", testid: `walk-${id}`, dataset: { card: id, status: "pending" } }, ...children);
    refs.walkCards[id] = el;
    return el.root;
  });
  refs.detailsToggle = h("button", { type: "button", class: "btn btn-ghost", testid: "toggle-details", "aria-expanded": "true", "aria-controls": "operate", onclick: on("toggleDetails") }, "Hide the detailed controls");
  return h(
    "section",
    { class: "walkthrough", id: "walkthrough", "aria-labelledby": "walk-heading" },
    h(
      "header",
      { class: "section-head walk-header" },
      h("span", { class: "section-kicker mono" }, "Part 1 · Walkthrough"),
      h("h2", { class: "section-title walk-heading", id: "walk-heading" }, "What happened, step by step"),
      h("p", { class: "section-intro walk-intro" }, "Every card below is written from the data this browser produced during the run. Numbers are measured, not assumed. A card that is still pending explains its step and waits for data."),
    ),
    h("ol", { class: "walk-list", testid: "walkthrough" }, items),
  );
}

function panel(index, title, intro, ...children) {
  return h("section", { class: "panel", dataset: { panel: String(index) }, testid: `panel-0${index}`, hidden: true, "aria-labelledby": `panel-title-${index}` }, h("header", { class: "panel-head" }, h("span", { class: "mono panel-num" }, `0${index}`), h("h2", { id: `panel-title-${index}` }, title)), intro ? h("p", { class: "panel-intro" }, intro) : null, ...children);
}

function buildIdentityPanel(refs, on) {
  refs.generateButton = h("button", { type: "button", class: "btn btn-primary", testid: "generate-identity", onclick: on("generate") }, "Generate identity");
  refs.keyId = h("code", { class: "mono", testid: "key-id" });
  refs.publicKeyHex = h("code", { class: "mono wrap", testid: "public-key" });
  refs.copyKeyButton = h("button", { type: "button", class: "btn btn-ghost btn-small", testid: "copy-public-key", onclick: () => on("copy")("pubkey", refs.publicKeyHex.textContent.replace(/\s+/g, "")) }, "Copy public key");
  refs.revealButton = h("button", { type: "button", class: "btn btn-ghost btn-small", testid: "reveal-seed", "aria-pressed": "false", onclick: on("revealSeed") }, "Reveal demo key");
  refs.seedHex = h("code", { class: "mono wrap", testid: "private-seed" });
  refs.seedBox = h("div", { class: "seed", hidden: true }, h("p", { class: "small warn" }, "Demo only. This 32-byte seed is the private key of this session. It is shown because the identity is disposable. It is never stored or sent."), refs.seedHex);
  refs.identityBox = h("div", { class: "result", testid: "identity-result", hidden: true }, h("div", { class: "kv" }, h("span", { class: "k" }, "Key ID (first 4 bytes of the public key)"), refs.keyId), h("div", { class: "kv" }, h("span", { class: "k" }, "Public key, 32 bytes"), refs.publicKeyHex), h("div", { class: "row" }, refs.copyKeyButton, refs.revealButton), refs.seedBox);
  refs.next2 = h("button", { type: "button", class: "btn btn-ghost", testid: "next-2", disabled: true, onclick: () => on("step")(2) }, "Continue to 02 Load a video");
  return panel(1, "Generate identity", "Create a random Ed25519 signing identity in this tab. The public key verifies. The private seed signs and never leaves the browser.", h("div", { class: "row" }, refs.generateButton), refs.identityBox, h("div", { class: "row row-end" }, refs.next2));
}

function buildSourcePanel(refs, on) {
  refs.sourceTabs = {};
  refs.sourceBodies = {};
  const tabs = [
    ["builtin", "Built-in excerpt"],
    ["file", "Local file"],
    ["url", "Direct URL"],
  ];
  const tablist = h("div", { class: "tabs", role: "tablist" }, tabs.map(([key, label]) => (refs.sourceTabs[key] = h("button", { type: "button", class: "tab", role: "tab", testid: `source-tab-${key}`, onclick: () => on("sourceTab")(key) }, label))));
  refs.useBuiltinButton = h("button", { type: "button", class: "btn btn-primary", testid: "import-builtin", onclick: on("useBuiltin") }, "Use the built-in excerpt");
  refs.sourceBodies.builtin = h("div", { class: "tab-body", role: "tabpanel" }, h("p", {}, "Sintel, Blender Foundation, CC BY 3.0. A four second excerpt at 1024x512, 30 fps, 120 frames, no audio. Attribution is in the Learn section and shipped next to the file."), h("div", { class: "row" }, refs.useBuiltinButton));
  refs.fileInput = h("input", { type: "file", accept: "video/*,.mp4,.webm,.mkv,.mov", testid: "file-input", "aria-label": "Choose a local video file", onchange: (e) => on("fileChosen")(e.target.files?.[0]) });
  refs.sourceBodies.file = h("div", { class: "tab-body", role: "tabpanel", hidden: true }, h("p", {}, `A local video up to ${formatBytes(MAX_INPUT_BYTES)} and at least ${EXCERPT_SECONDS} s. It is decoded in this tab and never uploaded.`), h("div", { class: "row" }, refs.fileInput));
  refs.urlInput = h("input", { type: "url", class: "input", placeholder: "https://example.org/clip.mp4", testid: "url-input", "aria-label": "Direct video URL", inputmode: "url", autocomplete: "off", spellcheck: "false" });
  refs.loadUrlButton = h("button", { type: "button", class: "btn", testid: "load-url", onclick: on("loadUrl") }, "Load URL");
  refs.sourceBodies.url = h("div", { class: "tab-body", role: "tabpanel", hidden: true }, h("p", {}, "A direct link to a video file, fetched by this browser with CORS. The server must send Access-Control-Allow-Origin. Streaming sites and protected media do not work. There is no proxy."), h("div", { class: "row" }, refs.urlInput, refs.loadUrlButton));

  refs.candidateName = h("span", { class: "mono", testid: "candidate-name" });
  refs.candidateDims = h("span", { class: "mono", testid: "candidate-dims" });
  refs.startInput = h("input", { type: "number", class: "input input-num", testid: "excerpt-start", min: "0", step: "0.1", value: "0", "aria-label": "Excerpt start in seconds", onchange: (e) => on("startChanged")(e.target.value), oninput: (e) => on("startChanged")(e.target.value) });
  refs.startHint = h("span", { class: "small" });
  refs.candidateInterval = h("span", { class: "mono", testid: "candidate-interval" });
  refs.candidatePlan = h("span", { class: "mono", testid: "candidate-plan" });
  refs.candidateAttribution = h("p", { class: "small", hidden: true });
  refs.importButton = h("button", { type: "button", class: "btn btn-primary", testid: "import-confirm", onclick: on("importConfirm") }, `Import ${EXCERPT_SECONDS} s excerpt as ${SAMPLE_COUNT} frames`);
  refs.candidateBox = h(
    "div",
    { class: "result", testid: "candidate", hidden: true },
    h("h3", {}, "Before import"),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Source"), refs.candidateName),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Decoded size and duration"), refs.candidateDims),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Excerpt start (s)"), h("span", { class: "row" }, refs.startInput, refs.startHint)),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Processing interval"), refs.candidateInterval),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Conversion"), refs.candidatePlan),
    h("div", { class: "kv" }, h("span", { class: "k" }, "Sampling"), h("span", { class: "mono" }, `${SAMPLE_COUNT} frames at ${SAMPLE_FPS} fps, held as lossless PNG. Only this excerpt is processed.`)),
    refs.candidateAttribution,
    h("div", { class: "row" }, refs.importButton),
  );
  refs.sourceDoneText = h("p", { class: "small", testid: "source-summary" });
  refs.sourceDone = h("div", { class: "result result--ok", hidden: true }, h("h3", {}, "Imported"), refs.sourceDoneText);
  refs.next3 = h("button", { type: "button", class: "btn btn-ghost", testid: "next-3", disabled: true, onclick: () => on("step")(3) }, "Continue to 03 Embed signature");
  return panel(2, "Load a video", "Choose a source. The demo shows the exact interval and conversion, then waits for Import.", tablist, ...Object.values(refs.sourceBodies), refs.candidateBox, refs.sourceDone, h("div", { class: "row row-end" }, refs.next3));
}

function buildEmbedPanel(refs, on, caps) {
  refs.messageInput = h("textarea", { class: "input textarea", rows: "2", testid: "message-input", "aria-label": "Message to sign", spellcheck: "false", oninput: (e) => on("messageInput")(e.target.value) });
  refs.byteCounter = h("span", { class: "mono counter", testid: "byte-counter" });
  refs.messageHint = h("span", { class: "small warn", testid: "message-hint" });
  refs.nonceInput = h("input", { type: "text", class: "input", testid: "nonce-input", "aria-label": "Public per-video nonce", spellcheck: "false", autocomplete: "off", oninput: (e) => on("nonceInput")(e.target.value) });
  refs.newNonceButton = h("button", { type: "button", class: "btn btn-ghost btn-small", testid: "new-nonce", onclick: on("newNonce") }, "New nonce");
  refs.signButton = h("button", { type: "button", class: "btn btn-primary", testid: "sign-run", onclick: on("sign") }, "Sign message");
  refs.signRow = h("div", { class: "row" }, refs.signButton, h("span", { class: "small" }, "Creates the framed payload: message, Ed25519 signature, Reed-Solomon parity."));
  refs.payloadBits = h("span", { class: "mono", testid: "payload-bits" });
  refs.payloadBytes = h("span", { class: "mono" });
  refs.payloadSig = h("code", { class: "mono wrap", testid: "payload-signature" });
  refs.payloadBox = h("div", { class: "result", testid: "payload-result", hidden: true }, h("h3", {}, "Signed payload"), h("div", { class: "kv" }, h("span", { class: "k" }, "Payload"), refs.payloadBits), h("div", { class: "kv" }, h("span", { class: "k" }, "Framing"), refs.payloadBytes), h("div", { class: "kv" }, h("span", { class: "k" }, "Signature, 64 bytes"), refs.payloadSig));
  refs.modeSelect = h("select", { class: "input", testid: "strength-mode", "aria-label": "Strength selection mode", onchange: (e) => on("strengthMode")(e.target.value) }, h("option", { value: "auto" }, "Automatic ladder (closed loop)"), h("option", { value: "manual" }, "Manual rung"));
  refs.psnrSelect = h("select", { class: "input", testid: "strength-select", "aria-label": "Per-frame PSNR target in dB", onchange: (e) => on("strengthPsnr")(e.target.value) }, LADDER.map((p) => h("option", { value: String(p) }, `${p} dB`)));
  refs.strengthHint = h("p", { class: "small" });
  refs.codecLine = h("p", { class: "small mono", testid: "output-codec" });
  refs.embedButton = h("button", { type: "button", class: "btn btn-primary", testid: "embed-run", onclick: on("embed") }, "Embed into excerpt");
  refs.markedSummary = h("p", { testid: "embed-summary" });
  refs.markedCodec = h("p", { class: "small mono", testid: "embed-codec" });
  refs.ladderList = h("pre", { class: "small ladder", testid: "ladder" });
  refs.downloadVideoButton = h("button", { type: "button", class: "btn", testid: "download-video", onclick: on("downloadVideo") }, "Download signed excerpt");
  refs.downloadMetadataButton = h("button", { type: "button", class: "btn", testid: "download-metadata", onclick: on("downloadMetadata") }, "Download public metadata (JSON)");
  refs.markedBox = h("div", { class: "result", testid: "embed-result", hidden: true }, h("h3", {}, "Encoded output"), refs.markedSummary, refs.markedCodec, h("h4", {}, "Ladder"), refs.ladderList, h("div", { class: "row" }, refs.downloadVideoButton, refs.downloadMetadataButton), h("p", { class: "small" }, "The metadata carries the nonce, bit count, canonical size, and public key. It does not carry the message or signature. Those are recovered from pixels at verification."));
  refs.next4 = h("button", { type: "button", class: "btn btn-ghost", testid: "next-4", disabled: true, onclick: () => on("step")(4) }, "Continue to 04 Extract and verify");
  return panel(
    3,
    "Embed signature",
    "Edit the message, sign it, then mark the sampled excerpt. Only Cr pixel values change. Each rung is encoded with MediaRecorder, decoded again, and verified before it is accepted.",
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Message", refs.byteCounter), refs.messageInput, refs.messageHint),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Public nonce (domain separation, travels with the file)"), h("div", { class: "row" }, refs.nonceInput, refs.newNonceButton)),
    refs.signRow,
    refs.payloadBox,
    h("div", { class: "field" }, h("span", { class: "field-label" }, "Strength"), h("div", { class: "row" }, refs.modeSelect, refs.psnrSelect), refs.strengthHint, refs.codecLine),
    h("div", { class: "row" }, refs.embedButton, caps.ok ? null : h("span", { class: "small warn" }, "Unavailable in this browser. See the notice above.")),
    refs.markedBox,
    h("div", { class: "row row-end" }, refs.next4),
  );
}

function buildVerifyPanel(refs, on) {
  refs.verifyButton = h("button", { type: "button", class: "btn btn-primary", testid: "verify-run", onclick: on("verify") }, "Extract and verify");
  refs.mainVerdict = buildVerdictBlock("verify", "Result under the session public key");
  refs.wrongKeyButton = h("button", { type: "button", class: "btn", testid: "verify-wrong-key", onclick: on("wrongKey") }, "Wrong key");
  refs.unmarkedButton = h("button", { type: "button", class: "btn", testid: "verify-unmarked", onclick: on("unmarked") }, "Unmarked source");
  refs.wrongVerdict = buildVerdictBlock("wrong-key", "Wrong key control");
  refs.unmarkedVerdict = buildVerdictBlock("unmarked", "Unmarked source control");
  refs.verifyFileInput = h("input", { type: "file", accept: "video/*,.webm,.mp4,.mkv", testid: "verify-file-input", "aria-label": "Video file to verify" });
  refs.verifyMetadataInput = h("input", { type: "file", accept: ".json,application/json", testid: "verify-metadata-input", "aria-label": "Metadata JSON", onchange: (e) => on("metadataChosen")(e.target.files?.[0]) });
  refs.verifyKeyInput = h("input", { type: "text", class: "input mono", testid: "verify-key-input", placeholder: "public key, 64 hex characters", "aria-label": "Public key hex", spellcheck: "false", autocomplete: "off" });
  refs.externalMetaText = h("p", { class: "small mono", testid: "verify-metadata-summary" });
  refs.verifyExternalButton = h("button", { type: "button", class: "btn", testid: "verify-external-run", onclick: on("verifyExternal") }, "Verify file");
  refs.externalVerdict = buildVerdictBlock("external", "Result for the supplied file");
  return panel(
    4,
    "Extract and verify",
    "A new video element decodes the encoded output. Every presented frame becomes one evidence row. The verifier gets the public layout and the public key only, never the message, the original bits, or the private key.",
    h("div", { class: "row" }, refs.verifyButton),
    refs.mainVerdict.root,
    h("h3", {}, "Negative controls"),
    h("p", { class: "small" }, "Both controls run the real verifier. No outcome is hardcoded."),
    h("div", { class: "row" }, refs.wrongKeyButton, refs.unmarkedButton),
    refs.wrongVerdict.root,
    refs.unmarkedVerdict.root,
    h(
      "details",
      { class: "external", testid: "verify-another" },
      h("summary", {}, "Verify another file"),
      h("p", { class: "small" }, "Use a downloaded signed excerpt with its metadata JSON. The public key is prefilled from the metadata when present and can be replaced. A file that is not 1024x512 is letterboxed and will not verify in this identity-geometry preview."),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Video file"), refs.verifyFileInput),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Metadata JSON"), refs.verifyMetadataInput, refs.externalMetaText),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "Public key (hex)"), refs.verifyKeyInput),
      h("div", { class: "row" }, refs.verifyExternalButton),
      refs.externalVerdict.root,
    ),
    h("div", { class: "row row-end" }, (refs.next5 = h("button", { type: "button", class: "btn btn-ghost", testid: "next-5", disabled: true, onclick: () => on("step")(5) }, "Continue to 05 Inspect the signal"))),
  );
}

function buildInspectPanel(refs, on) {
  refs.inspectButton = h("button", { type: "button", class: "btn btn-primary", testid: "inspect-run", onclick: on("inspect") }, "Compute spectrum and residual");
  refs.spectrumToggles = {};
  refs.residualToggles = {};
  const spectrumTabs = [
    ["source", "Source"],
    ["marked", "Marked, pre-codec"],
    ["output", "Decoded output"],
  ];
  const residualTabs = [
    ["carrier", "Carrier (marked minus source)"],
    ["output", "Output (decoded minus source)"],
  ];
  refs.spectrumCanvas = h("canvas", { class: "inspect-canvas", testid: "canvas-spectrum", width: 1024, height: 512, "aria-label": "Log-power Cr spectrum with carrier band overlay" });
  refs.residualCanvas = h("canvas", { class: "inspect-canvas", testid: "canvas-residual", width: 1024, height: 512, "aria-label": "Amplified residual image" });
  refs.groupsCanvas = h("canvas", { class: "groups-canvas", testid: "canvas-groups", width: 120, height: 28, "aria-label": "Per-frame group identification" });
  refs.spectrumLabel = h("p", { class: "small", testid: "spectrum-label" });
  refs.residualLabel = h("p", { class: "small", testid: "residual-label" });
  refs.groupsLabel = h("p", { class: "small", testid: "groups-label" });
  refs.gainSelect = h("select", { class: "input", testid: "residual-gain", "aria-label": "Residual gain", onchange: (e) => on("gain")(e.target.value) }, [8, 16, 32].map((g) => h("option", { value: String(g) }, `x${g}`)));
  refs.binsCheckbox = h("input", { type: "checkbox", testid: "show-bins", checked: true, onchange: (e) => on("showBins")(e.target.checked) });
  refs.inspectBox = h(
    "div",
    { class: "inspect", hidden: true },
    h("div", { class: "inspect-block" }, h("div", { class: "row row-between" }, h("h3", {}, "Cr spectrum, frame 0"), h("div", { class: "tabs tabs-small" }, spectrumTabs.map(([k, l]) => (refs.spectrumToggles[k] = h("button", { type: "button", class: "tab", testid: `spectrum-${k}`, "aria-pressed": "false", onclick: () => on("spectrumView")(k) }, l))), h("label", { class: "check" }, refs.binsCheckbox, "Show bins"))), refs.spectrumCanvas, refs.spectrumLabel),
    h("div", { class: "inspect-block" }, h("div", { class: "row row-between" }, h("h3", {}, "Residual, frame 0"), h("div", { class: "tabs tabs-small" }, residualTabs.map(([k, l]) => (refs.residualToggles[k] = h("button", { type: "button", class: "tab", testid: `residual-${k}`, "aria-pressed": "false", onclick: () => on("residualView")(k) }, l))), refs.gainSelect)), refs.residualCanvas, refs.residualLabel),
    h("div", { class: "inspect-block" }, h("h3", {}, "Group identification"), refs.groupsCanvas, refs.groupsLabel),
  );
  return panel(5, "Inspect the signal", "Spectra come from the library's spectrum preview on actual frames. Residuals are pixel differences of actual frames. Scales and gains are stated on each label.", h("div", { class: "row" }, refs.inspectButton), refs.inspectBox);
}
