// Narrated walkthrough of one demonstration run, built from real data.
// buildWalkthrough is pure: it reads the protocol session, the negative
// control results, the per-step wall-clock timings, and the run status, and
// returns seven card models. It contains no DOM code so it runs under Node.
// Every number and string in a fact comes from the session or a result.
// Nothing is hardcoded as a claimed outcome. Absent data is reported as absent.
import { RUN_STEPS, CARD_ORDER, stepsForCard, cardForStep } from "./run-order.js";
import { verdictViewModel } from "./verdict.js";
import { payloadBitLength, utf8ByteLength, fixed } from "./text.js";
import { formatBytes } from "./validation.js";

/**
 * @typedef {{ label: string, value: string | boolean, mono?: boolean, full?: boolean }} Fact
 * @typedef {{ id: string, index: number, title: string, status: "pending" | "running" | "done" | "failed" | "cancelled", summary: string, facts: Fact[], notes: string[] }} Card
 */

/** Titles and the one or two plain sentences that explain the idea of each step. No digits: pending cards must carry no numbers. */
const CARD_TEXT = Object.freeze({
  identity: {
    title: "Identity",
    summary:
      "The signer creates a random signing key pair in this browser tab. The public key is shared and verifies. The private key signs and never leaves the tab.",
  },
  source: {
    title: "Source",
    summary:
      "The browser decodes the source video, samples a short excerpt at a fixed frame rate, and letterboxes every frame into the canonical size. Only that excerpt is processed.",
  },
  payload: {
    title: "Signature and payload",
    summary:
      "The signer signs the message with the private key. The message, its length, the signature, and Reed-Solomon parity form one framed payload. Each payload bit will set the phase of one chroma frequency bin.",
  },
  embed: {
    title: "Embedding",
    summary:
      "The payload is added to the chroma phase of every sampled frame and the result is encoded to a video file. The signer then decodes its own file and runs the public verifier. The first rung of the strength ladder whose encoded output verifies is kept.",
  },
  verify: {
    title: "Extraction and verification",
    summary:
      "A new video element decodes the encoded file. Every presented frame becomes one evidence row. The verifier receives the public key and the public layout. It never sees the message or the private key.",
  },
  controls: {
    title: "Negative controls",
    summary:
      "Two negative controls run the real verifier on real evidence. The first uses an unrelated public key. The second extracts from the unmarked source frames. No outcome is hardcoded.",
  },
  inspect: {
    title: "Inspection",
    summary:
      "The chroma spectrum and the pixel residual of the first sampled frame are computed from the actual planes. Scales and gains are stated on the labels.",
  },
});

const ABSENT = "not reported";

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "not recorded";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** Byte-for-byte comparison of two byte arrays. Returns null when either side is missing. */
export function compareBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return null;
  const length = Math.max(a.length, b.length);
  if (a.length !== b.length) return { equal: false, length, firstDifference: Math.min(a.length, b.length) };
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return { equal: false, length, firstDifference: i };
  }
  return { equal: true, length, firstDifference: -1 };
}

const isInt = (v) => Number.isInteger(v);
const isNum = (v) => Number.isFinite(v);
const str = (v) => (v === null || v === undefined || v === "" ? ABSENT : String(v));
const count = (v) => (isInt(v) ? String(v) : ABSENT);

function elapsedFact(cardId, timings) {
  const fns = stepsForCard(cardId);
  const present = fns.filter((fn) => isNum(timings?.[fn]));
  if (present.length === 0) return { label: "Elapsed", value: "not recorded", mono: true };
  const total = present.reduce((acc, fn) => acc + timings[fn], 0);
  const partial = present.length < fns.length ? ", part of this step was not timed" : "";
  return { label: "Elapsed", value: `${formatDuration(total)}${partial}`, mono: true };
}

function layoutText(summary) {
  if (!summary) return "Created from the nonce when embedding starts. Not created yet.";
  const bins = Array.isArray(summary.binsPerGroup) && summary.binsPerGroup.length ? summary.binsPerGroup : null;
  const sameBins = bins && bins.every((b) => b === bins[0]);
  const binText = !bins ? "bins per group not exposed" : sameBins ? `${str(bins[0])} bins per group` : `${bins.map(str).join(", ")} bins per group`;
  const band = summary.band && isNum(summary.band.lo) && isNum(summary.band.hi) ? `band ${summary.band.lo} to ${summary.band.hi} cycles per pixel` : "band not exposed";
  const pool = isInt(summary.poolSize) ? `pool of ${summary.poolSize} bins` : "pool size not exposed";
  return `${str(summary.version)}, ${count(summary.groups)} groups, ${binText}, K = ${count(summary.runLength)}, ${band}, ${pool}`;
}

// ---- per-card facts ----------------------------------------------------------

function identityFacts(session, timings) {
  const id = session.identity;
  if (!id) return null;
  const hex = typeof id.publicKeyHex === "string" ? id.publicKeyHex : ABSENT;
  const bytes = hex === ABSENT ? null : hex.length / 2;
  return {
    facts: [
      { label: "Key ID", value: str(id.keyId), mono: true },
      { label: `Ed25519 public key${bytes ? ` (${bytes} bytes)` : ""}`, value: hex, mono: true, full: true },
      { label: "Private key", value: "Stays in this browser tab. It was not transmitted and is not stored." },
      elapsedFact("identity", timings),
    ],
    notes: ["The key ID is the first four bytes of the public key, shown for quick reference. Anyone holding the public key can verify. Only this tab can sign."],
  };
}

function sourceFacts(session, timings) {
  const s = session.source;
  if (!s) return null;
  const sampling = s.sampling ?? {};
  const distinct = isInt(sampling.distinct) && isInt(sampling.total) ? `${sampling.distinct} distinct of ${sampling.total} slots${isInt(sampling.duplicated) && sampling.duplicated > 0 ? `, ${sampling.duplicated} duplicated to keep the frame rate` : ""}` : ABSENT;
  const facts = [
    { label: "File", value: `${str(s.name)}${isNum(s.size) ? ` (${formatBytes(s.size)})` : ""}`, mono: true },
    { label: "Source dimensions", value: isInt(s.width) && isInt(s.height) ? `${s.width}x${s.height}` : ABSENT, mono: true },
    { label: "Canonical frame", value: s.canonical && isInt(s.canonical.width) && isInt(s.canonical.height) ? `${s.canonical.width}x${s.canonical.height}` : ABSENT, mono: true },
    { label: "Excerpt", value: str(s.interval), mono: true },
    { label: "Frames sampled", value: isInt(s.sampleCount) && isNum(s.sampleFps) ? `${s.sampleCount} frames at ${s.sampleFps} fps` : ABSENT, mono: true },
    { label: "Distinct frames", value: distinct, mono: true },
    { label: "Letterbox and scaling", value: str(s.plan?.description) },
    { label: "Capture method", value: str(s.captureMethod), mono: true },
    elapsedFact("source", timings),
  ];
  const notes = [];
  if (s.attribution) notes.push(String(s.attribution));
  notes.push("The full file is shown in the detailed controls. Only the excerpt above was sampled and marked.");
  return { facts, notes };
}

function payloadFacts(session, timings) {
  const p = session.payload;
  if (!p) return null;
  const message = typeof p.message === "string" ? p.message : typeof session.message === "string" ? session.message : null;
  const n = isInt(p.messageByteLength) ? p.messageByteLength : message !== null ? utf8ByteLength(message) : null;
  const computedBits = n !== null ? payloadBitLength(n) : null;
  const libBits = isInt(p.bitCount) ? p.bitCount : null;
  const sigHex = typeof p.signatureHex === "string" ? p.signatureHex : null;
  const sigBytes = sigHex ? sigHex.length / 2 : null;
  const facts = [
    { label: "Message", value: message === null ? ABSENT : message },
    { label: "UTF-8 bytes", value: n === null ? ABSENT : `${n} UTF-8 bytes`, mono: true },
    { label: "Framing", value: n === null ? ABSENT : `(1 + 2 + ${n} + 64 + 30) * 8 = ${computedBits} bits`, mono: true },
    {
      label: "Payload bits (library)",
      value: libBits === null ? ABSENT : libBits === computedBits ? `${libBits} bits, matches the framing arithmetic` : `${libBits} bits, differs from the framing arithmetic (${computedBits})`,
      mono: true,
    },
    { label: `Ed25519 signature${sigBytes ? ` (${sigBytes} bytes)` : ""}`, value: sigHex ?? ABSENT, mono: true, full: true },
    { label: "Nonce (public, travels with the file)", value: str(session.nonce), mono: true },
    { label: "Layout", value: layoutText(session.marked?.layout?.summary ?? null), mono: true },
    elapsedFact("payload", timings),
  ];
  const notes = ["The signature covers the message bytes. The nonce selects the bins and phases of the public layout."];
  if (libBits !== null && libBits !== computedBits) notes.push("The library bit count differs from the framing arithmetic. This is shown, not hidden.");
  return { facts, notes };
}

function embedFacts(session, timings) {
  const m = session.marked;
  if (!m) return null;
  const facts = [];
  const ladder = Array.isArray(m.ladder) ? m.ladder : [];
  ladder.forEach((r, i) => {
    const parts = [`${str(r.psnr)} dB target: ${r.verified === true ? "verified" : "not verified"}`];
    if (r.verified !== true && r.reason) parts[0] += ` (${r.reason})`;
    if (isInt(r.correctedSymbols)) parts.push(`${r.correctedSymbols} RS symbols corrected`);
    if (isInt(r.framesRead)) parts.push(`${r.framesRead} frames read`);
    if (isInt(r.blobSize)) parts.push(formatBytes(r.blobSize));
    facts.push({ label: `Rung ${i + 1}`, value: parts.join(", "), mono: true });
  });
  if (ladder.length === 0) facts.push({ label: "Rungs", value: ABSENT, mono: true });
  facts.push({
    label: "Accepted rung",
    value: m.accepted === true ? `${str(m.psnr)} dB, its encoded output verified` : `none verified. The last output (${str(m.psnr)} dB) is kept and labeled not verified.`,
    mono: true,
  });
  const info = m.mimeInfo ?? {};
  facts.push({ label: "Output", value: `${str(info.container)} ${str(info.codec)}${m.mime ? ` (${m.mime})` : ""}`, mono: true });
  facts.push({ label: "Output size", value: isNum(m.blob?.size) ? formatBytes(m.blob.size) : ABSENT, mono: true });
  facts.push({ label: "Frames encoded", value: count(m.frames), mono: true });
  facts.push({ label: "Recording wall time", value: isNum(m.wallMs) ? formatDuration(m.wallMs) : ABSENT, mono: true });
  facts.push({ label: "Late frames", value: count(m.lateFrames), mono: true });
  facts.push({ label: "Capture", value: str(m.captureMode), mono: true });
  facts.push(elapsedFact("embed", timings));
  const notes = ["Each rung is encoded with MediaRecorder, decoded again from the produced file, and verified before it is accepted. Only chroma pixel values change."];
  return { facts, notes };
}

function verifyFacts(session, timings) {
  const v = session.verification;
  if (!v) return null;
  const vm = verdictViewModel(v.result ?? null, { publicKeyHex: v.publicKeyHex ?? session.identity?.publicKeyHex });
  const payloadIndex = CARD_ORDER.indexOf("payload") + 1;
  const recovered = v.result?.signature instanceof Uint8Array ? v.result.signature : null;
  const created = session.payload?.signature instanceof Uint8Array ? session.payload.signature : null;
  const cmp = compareBytes(recovered, created);
  let identical;
  let compared;
  if (cmp === null) {
    const why = !created ? "no signature from the signing step is in this session" : "the verifier recovered no signature";
    identical = `not compared: ${why}`;
    compared = "none";
  } else if (cmp.equal) {
    identical = true;
    compared = `${cmp.length} of ${cmp.length} bytes equal`;
  } else {
    identical = false;
    compared = `first difference at byte ${cmp.firstDifference} of ${cmp.length}`;
  }
  const facts = [
    { label: "Verdict", value: vm.label, mono: true },
    { label: "Reason", value: vm.reason ?? ABSENT },
    { label: "Recovered message", value: vm.messageText ?? "none" },
    { label: `Recovered signature${vm.signatureHex ? ` (${vm.signatureHex.length / 2} bytes)` : ""}`, value: vm.signatureHex ?? "none", mono: true, full: true },
    { label: `Recovered signature identical to the signature created in step ${payloadIndex}`, value: identical, mono: true },
    { label: "Bytes compared", value: compared, mono: true },
    { label: "RS symbols corrected", value: count(vm.correctedSymbols), mono: true },
    { label: "Frames per group", value: Array.isArray(vm.groupCounts) ? vm.groupCounts.join(" / ") : ABSENT, mono: true },
    { label: "Frames decoded", value: count(v.read?.frames), mono: true },
    { label: "Evidence rows", value: count(v.rowCount), mono: true },
    { label: "Decode method", value: str(v.read?.method), mono: true },
    { label: "Public key used", value: str(vm.publicKeyHex), mono: true, full: true },
    elapsedFact("verify", timings),
  ];
  const notes = [];
  if (vm.messageIsUnverified) notes.push("The recovered bytes are shown because the payload decoded, but the signature is not valid under this key.");
  if (v.read?.resized) notes.push("The decoded file was not at the canonical size and was letterboxed before extraction.");
  notes.push("The comparison above is a byte-for-byte check performed while building this card. It is not read from any stored claim.");
  return { facts, notes };
}

function controlsFacts(session, controls, timings) {
  const wk = controls?.wrongKey ?? null;
  const um = controls?.unmarked ?? null;
  if (!wk && !um) return null;
  const facts = [];
  const notes = [];
  if (wk) {
    const vm = verdictViewModel(wk.res?.result ?? null, { publicKeyHex: wk.publicKeyHex });
    const reason = typeof wk.res?.result?.reason === "string" ? wk.res.result.reason : vm.reason ?? ABSENT;
    facts.push({ label: "Wrong key verdict", value: vm.label, mono: true });
    facts.push({ label: "Wrong key reason", value: reason });
    facts.push({ label: "Unrelated public key used", value: str(wk.publicKeyHex), mono: true, full: true });
    facts.push({ label: "Wrong key evidence rows", value: count(wk.res?.rowCount), mono: true });
  } else {
    notes.push("The wrong key control has not run.");
  }
  if (um) {
    const vm = verdictViewModel(um.res?.result ?? null, { publicKeyHex: um.publicKeyHex });
    const reason = typeof um.res?.result?.reason === "string" ? um.res.result.reason : vm.reason ?? ABSENT;
    facts.push({ label: "Unmarked source verdict", value: vm.label, mono: true });
    facts.push({ label: "Unmarked source reason", value: reason });
    facts.push({ label: "Unmarked source frames read", value: `${count(um.res?.read?.frames)}${um.res?.read?.method ? ` (${um.res.read.method})` : ""}`, mono: true });
    facts.push({ label: "Unmarked source frames per group", value: Array.isArray(vm.groupCounts) ? vm.groupCounts.join(" / ") : ABSENT, mono: true });
  } else {
    notes.push("The unmarked source control has not run.");
  }
  facts.push(elapsedFact("controls", timings));
  if (wk && um) notes.push("Both controls ran the real verifier on real evidence rows. The wrong key control reused the evidence rows of the verification step with a freshly generated, unrelated public key. The unmarked control extracted evidence from the unmarked sampled source frames.");
  else notes.push("The control that ran used the real verifier. No outcome is hardcoded.");
  return { facts, notes, complete: !!(wk && um) };
}

function inspectFacts(session, timings) {
  const ins = session.inspect;
  if (!ins) return null;
  const planes = [];
  if (ins.spectrumSource) planes.push("Cr spectrum of the source frame");
  if (ins.spectrumMarked) planes.push("Cr spectrum of the marked frame before encoding");
  if (ins.spectrumOutput) planes.push("Cr spectrum of the decoded output frame");
  if (ins.residualCarrier) planes.push("residual of the marked frame minus the source frame");
  if (ins.residualOutput) planes.push("residual of the decoded output frame minus the source frame");
  const band = session.marked?.layout?.summary?.band;
  const residualText = (r) => (r?.stats && isNum(r.stats.psnr) ? `PSNR ${fixed(r.stats.psnr, 2)} dB over RGB, max difference ${str(r.stats.maxAbs)}, mean difference ${fixed(r.stats.meanAbs, 3)}` : ABSENT);
  const spectrum = ins.spectrumOutput ?? ins.spectrumMarked ?? ins.spectrumSource ?? null;
  const facts = [
    { label: "Planes computed", value: planes.length ? planes.join("; ") : "none" },
    { label: "Frame index", value: isInt(ins.frameIndex) ? String(ins.frameIndex) : "not recorded", mono: true },
    { label: "Residual gain", value: isNum(ins.gain) ? `x${ins.gain}` : ABSENT, mono: true },
    { label: "Carrier band", value: band && isNum(band.lo) && isNum(band.hi) ? `${band.lo} to ${band.hi} cycles per pixel, drawn as two ellipses around the centered DC bin` : "not available", mono: true },
    { label: "Spectrum scale", value: str(spectrum?.scale), mono: true },
    { label: "Carrier residual (marked minus source)", value: residualText(ins.residualCarrier), mono: true },
    { label: "Output residual (decoded minus source)", value: residualText(ins.residualOutput), mono: true },
    elapsedFact("inspect", timings),
  ];
  const notes = ["The bins sit inside the carrier band. The spectrum and residual images below are drawn from the same computed planes."];
  return { facts, notes };
}

// ---- assembly ----------------------------------------------------------------

function idleStatus(status) {
  return {
    phase: status?.phase ?? "idle",
    current: status?.current ?? null,
    failedStep: status?.failedStep ?? null,
    cancelledStep: status?.cancelledStep ?? null,
    error: status?.error ?? null,
    progressText: status?.progressText ?? null,
  };
}

/**
 * Build the seven walkthrough cards.
 * @param {{ session?: object, controls?: { wrongKey?: object|null, unmarked?: object|null }, timings?: Record<string, number>, status?: object }} input
 * @returns {Card[]}
 */
export function buildWalkthrough({ session, controls, timings, status } = {}) {
  const s = session ?? {};
  const t = timings ?? {};
  const st = idleStatus(status);
  const stoppedAtCard = st.failedStep ? cardForStep(st.failedStep) : st.cancelledStep ? cardForStep(st.cancelledStep) : null;
  const stoppedIndex = stoppedAtCard ? CARD_ORDER.indexOf(stoppedAtCard) : -1;
  const runningCard = st.current ? cardForStep(st.current) : null;

  return CARD_ORDER.map((id, i) => {
    const textBlock = CARD_TEXT[id];
    let data = null;
    switch (id) {
      case "identity":
        data = identityFacts(s, t);
        break;
      case "source":
        data = sourceFacts(s, t);
        break;
      case "payload":
        data = payloadFacts(s, t);
        break;
      case "embed":
        data = embedFacts(s, t);
        break;
      case "verify":
        data = verifyFacts(s, t);
        break;
      case "controls":
        data = controlsFacts(s, controls, t);
        break;
      case "inspect":
        data = inspectFacts(s, t);
        break;
      default:
        data = null;
    }
    const complete = !!data && data.complete !== false;
    const facts = data ? data.facts.slice() : [];
    const notes = data ? data.notes.slice() : [];

    let cardStatus;
    if (stoppedAtCard === id && st.failedStep) cardStatus = "failed";
    else if (stoppedAtCard === id && st.cancelledStep) cardStatus = "cancelled";
    else if (runningCard === id) cardStatus = "running";
    else if (complete) cardStatus = "done";
    else cardStatus = "pending";

    if (cardStatus === "running") {
      facts.unshift({ label: "Progress", value: st.progressText ?? "Working. Progress will appear here as the step reports it." });
    }
    if (cardStatus === "failed") {
      facts.unshift({ label: "Error", value: st.error ?? "The step failed without an error message." });
      notes.push("The run stopped at this step. The error above is the real message from the step that failed.");
    }
    if (cardStatus === "cancelled") {
      notes.push("This step was cancelled. Partial work was discarded and the worker was stopped.");
    }
    if (stoppedIndex >= 0 && i > stoppedIndex && cardStatus === "pending") {
      const stoppedTitle = CARD_TEXT[stoppedAtCard].title;
      notes.push(`This step did not run. The run stopped at ${stoppedTitle.charAt(0).toLowerCase()}${stoppedTitle.slice(1)}${st.failedStep ? " because that step failed" : " because the run was cancelled"}.`);
    }

    return {
      id,
      index: i + 1,
      title: textBlock.title,
      status: cardStatus,
      summary: textBlock.summary,
      facts,
      notes,
    };
  });
}

export { CARD_TEXT, RUN_STEPS, CARD_ORDER };
