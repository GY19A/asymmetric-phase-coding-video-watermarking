// UI slice C: the narrated walkthrough is built from real session data.
// buildWalkthrough is a pure function (no DOM) so every card, fact, and
// status can be checked in Node. The fixtures below use the real core
// library for the identity, the payload, and the layout, and mirror the
// result shapes produced by src/app/pipeline.js for everything else.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildWalkthrough, compareBytes, formatDuration } from "../src/app/walkthrough.js";
import { RUN_STEPS, CARD_ORDER, stepsForCard, cardForStep } from "../src/app/run-order.js";
import { createSession, applyChange } from "../src/app/session.js";
import { generateIdentity, createPayload, createLayout } from "../src/lib/index.js";
import { layoutSummary } from "../src/app/core-adapter.js";
import { bytesToHex, utf8ByteLength, payloadBitLength, DEFAULT_MESSAGE } from "../src/app/text.js";
import { planCanonical, describeInterval, CANONICAL, SAMPLE_COUNT, SAMPLE_FPS } from "../src/app/validation.js";
import { samplingSummary } from "../src/app/sampling.js";
import { describeMime } from "../src/app/capabilities.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---- fixtures ----------------------------------------------------------------

const idle = () => ({ phase: "idle", current: null, failedStep: null, cancelledStep: null, error: null, progressText: null });

const TIMINGS = Object.freeze({
  doGenerate: 12.4,
  doPrepareBuiltin: 210.5,
  doImport: 4800.2,
  doSign: 9.1,
  doEmbed: 38000,
  doVerify: 5200,
  doWrongKey: 40,
  doUnmarked: 3100,
  doInspect: 900,
});

async function realFixtures() {
  const id = await generateIdentity();
  const publicKeyHex = bytesToHex(id.publicKey);
  const identity = {
    publicKey: id.publicKey,
    privateKey: id.privateKey,
    publicKeyHex,
    privateKeyHex: bytesToHex(id.privateKey),
    keyId: publicKeyHex.slice(0, 8),
  };
  const message = DEFAULT_MESSAGE;
  assert.equal(utf8ByteLength(message), 31, "fixture message must be exactly 31 UTF-8 bytes");
  const p = await createPayload(message, id.privateKey);
  const payload = {
    bits: p.bits,
    bitCount: p.bits.length,
    signature: p.signature,
    signatureHex: bytesToHex(p.signature),
    messageBytes: p.messageBytes,
    messageByteLength: p.messageBytes.length,
    message,
  };
  const nonce = "apcvw-demo-000102030405060708090a0b";
  const layout = await createLayout({ width: CANONICAL.width, height: CANONICAL.height, nonce, bitCount: payload.bitCount });
  const summary = layoutSummary(layout);

  const other = await generateIdentity();
  const otherHex = bytesToHex(other.publicKey);

  const filled = new Array(SAMPLE_COUNT).fill(true);
  filled[7] = false;
  filled[63] = false;
  const source = {
    kind: "builtin",
    name: "sintel-demo.mp4",
    size: null,
    url: "/media/sintel-demo.mp4",
    width: 1024,
    height: 512,
    duration: 4,
    plan: planCanonical(1024, 512),
    poster: "/media/sintel-poster.jpg",
    attribution: "Sintel excerpt. Blender Foundation, www.sintel.org. CC BY 3.0.",
    start: 0,
    interval: describeInterval(0, 4),
    store: { bytes: 71_303_168 },
    sampling: samplingSummary(filled),
    captureMethod: "requestVideoFrameCallback",
    sampleCount: SAMPLE_COUNT,
    sampleFps: SAMPLE_FPS,
    canonical: { ...CANONICAL },
    frame0: new Uint8ClampedArray(16),
  };

  const mime = "video/webm;codecs=vp9";
  const ladder = [
    { psnr: 42, verified: false, reason: "signature invalid", correctedSymbols: null, framesRead: 120, blobSize: 5_100_000, wallMs: 4600, lateFrames: 0 },
    { psnr: 40, verified: true, reason: "ok", correctedSymbols: 3, framesRead: 120, blobSize: 5_242_880, wallMs: 4630, lateFrames: 1 },
  ];
  const marked = {
    accepted: true,
    psnr: 40,
    mode: "auto",
    blob: { size: 5_242_880, type: mime },
    url: "blob:demo",
    mime,
    mimeInfo: describeMime(mime),
    frames: 120,
    wallMs: 4630,
    lateFrames: 1,
    captureMode: "manual (track.requestFrame)",
    requestedBitsPerSecond: 12_000_000,
    actualBitsPerSecond: null,
    ladder,
    acceptance: { frameGroups: [] },
    carrierStats: {},
    layout: { key: `${CANONICAL.width}x${CANONICAL.height}|${nonce}|${payload.bitCount}`, summary },
    nonce,
    frame0: { source: null, marked: null, output: null },
    metadata: {},
    metadataText: "{}",
  };

  const groupCounts = [30, 30, 30, 30];
  const verification = {
    sessionId: "v1",
    layoutKey: marked.layout.key,
    result: {
      verified: true,
      reason: "ok",
      message,
      messageBytes: new Uint8Array(p.messageBytes),
      signature: new Uint8Array(p.signature),
      correctedSymbols: 3,
      extractedBits: new Uint8Array(payload.bitCount),
      groupCounts,
    },
    rowCount: 120,
    frameGroups: [],
    read: { frames: 120, lastMediaTime: 3.966, method: "requestVideoFrameCallback", width: 1024, height: 512, resized: false, duration: 4, truncated: false },
    output0: null,
    publicKeyHex,
  };

  const controls = {
    wrongKey: {
      res: {
        sessionId: "v1",
        layoutKey: marked.layout.key,
        result: { verified: false, reason: "signature invalid", messageBytes: new Uint8Array(p.messageBytes), signature: new Uint8Array(p.signature), correctedSymbols: 3, groupCounts },
        rowCount: 120,
        frameGroups: [],
        publicKeyHex: otherHex,
      },
      publicKeyHex: otherHex,
    },
    unmarked: {
      res: {
        sessionId: "u2",
        layoutKey: marked.layout.key,
        result: { verified: false, reason: "bad length header (0)", correctedSymbols: null, groupCounts: [31, 29, 30, 30] },
        rowCount: 120,
        frameGroups: [],
        publicKeyHex,
        read: { frames: 120, method: "frame store" },
      },
      publicKeyHex,
    },
  };

  const spectrum = (label) => ({ image: { width: 1024, height: 512 }, min: 0.12, max: 6.31, scale: "log10(1 + |F|)", centered: true, label });
  const residual = (label, psnr) => ({ image: { width: 1024, height: 512 }, gain: 16, stats: { psnr, maxAbs: 4, meanAbs: 0.91, mse: 0.62 }, label });
  const inspect = {
    spectrumSource: spectrum("source"),
    spectrumMarked: spectrum("marked, before encoding"),
    spectrumOutput: spectrum("output, decoded from the encoded Blob"),
    residualCarrier: residual("marked minus source (before encoding)", 40.21),
    residualOutput: residual("decoded output minus source (after encoding)", 37.88),
    gain: 16,
    frameIndex: 0,
  };

  return { identity, payload, message, nonce, summary, source, marked, verification, controls, inspect, publicKeyHex, otherHex };
}

const fx = await realFixtures();

function fullSession() {
  let s = createSession();
  s = { ...s, message: fx.message, nonce: fx.nonce };
  s = applyChange(s, "identity", fx.identity);
  s = applyChange(s, "source", fx.source);
  s = applyChange(s, "payload", fx.payload);
  s = applyChange(s, "marked", fx.marked);
  s = applyChange(s, "verification", fx.verification);
  s = applyChange(s, "inspect", fx.inspect);
  return s;
}

function upTo(field) {
  // A session where every result up to and including `field` exists.
  const order = ["identity", "source", "payload", "marked", "verification", "inspect"];
  let s = { ...createSession(), message: fx.message, nonce: fx.nonce };
  for (const f of order) {
    s = applyChange(s, f, fx[f === "marked" ? "marked" : f]);
    if (f === field) break;
  }
  return s;
}

const card = (cards, id) => {
  const c = cards.find((x) => x.id === id);
  assert.ok(c, `card ${id} exists`);
  return c;
};
const fact = (c, labelRe) => c.facts.find((f) => labelRe.test(f.label));
const factValue = (c, labelRe) => {
  const f = fact(c, labelRe);
  assert.ok(f, `${c.id}: fact matching ${labelRe} exists (labels: ${c.facts.map((x) => x.label).join(" | ")})`);
  return f.value;
};
const allText = (c) => [c.title, c.summary, ...c.notes, ...c.facts.flatMap((f) => [f.label, String(f.value)])].join("\n");

// ---- run order ---------------------------------------------------------------

test("run-order lists nine step functions mapped onto seven cards, in protocol order", () => {
  assert.deepEqual(
    RUN_STEPS.map((s) => s.fn),
    ["doGenerate", "doPrepareBuiltin", "doImport", "doSign", "doEmbed", "doVerify", "doWrongKey", "doUnmarked", "doInspect"],
  );
  assert.deepEqual([...CARD_ORDER], ["identity", "source", "payload", "embed", "verify", "controls", "inspect"]);
  assert.equal(CARD_ORDER.length, 7);
  assert.deepEqual(stepsForCard("source"), ["doPrepareBuiltin", "doImport"]);
  assert.deepEqual(stepsForCard("controls"), ["doWrongKey", "doUnmarked"]);
  assert.equal(cardForStep("doEmbed"), "embed");
  assert.equal(cardForStep("nope"), null);
  for (const s of RUN_STEPS) assert.ok(CARD_ORDER.includes(s.card), `${s.fn} maps to a known card`);
  for (const id of CARD_ORDER) assert.ok(stepsForCard(id).length >= 1, `${id} has at least one step`);
});

test("card ordering and count are stable: seven cards whose ids follow the runner's step order", () => {
  const empty = buildWalkthrough({ session: createSession(), controls: {}, timings: {}, status: idle() });
  const full = buildWalkthrough({ session: fullSession(), controls: fx.controls, timings: TIMINGS, status: { ...idle(), phase: "done" } });
  assert.equal(empty.length, 7);
  assert.equal(full.length, 7);
  assert.deepEqual(empty.map((c) => c.id), [...CARD_ORDER]);
  assert.deepEqual(full.map((c) => c.id), [...CARD_ORDER]);
  assert.deepEqual(empty.map((c) => c.index), [1, 2, 3, 4, 5, 6, 7]);
  for (const c of [...empty, ...full]) {
    assert.equal(typeof c.title, "string");
    assert.equal(typeof c.summary, "string");
    assert.ok(Array.isArray(c.facts));
    assert.ok(Array.isArray(c.notes));
    assert.ok(["pending", "running", "done", "failed", "cancelled"].includes(c.status), c.status);
    for (const f of c.facts) {
      assert.equal(typeof f.label, "string");
      assert.ok(["string", "boolean"].includes(typeof f.value), `${c.id}/${f.label}: value is a string or boolean`);
    }
  }
});

test("the runner's step list lives in run-order.js and ui.js defines each step function exactly once", () => {
  const src = readFileSync(join(here, "..", "src", "app", "ui.js"), "utf8");
  assert.match(src, /from "\.\/run-order\.js"/, "ui.js imports the shared run order");
  assert.match(src, /\bRUN_STEPS\b/, "ui.js iterates RUN_STEPS for the runner");
  for (const { fn } of RUN_STEPS) {
    const definitions = src.match(new RegExp(`^\\s*async ${fn}\\(`, "gm")) ?? [];
    assert.equal(definitions.length, 1, `${fn} is defined exactly once in ui.js`);
    const literals = src.match(new RegExp(`["'\`]${fn}["'\`]`, "g")) ?? [];
    assert.equal(literals.length, 0, `${fn} is never listed as a string literal in ui.js (no second step list)`);
  }
});

// ---- pending -----------------------------------------------------------------

test("pending cards contain no numbers and no facts", () => {
  const cards = buildWalkthrough({ session: createSession(), controls: {}, timings: {}, status: idle() });
  for (const c of cards) {
    assert.equal(c.status, "pending", `${c.id} is pending`);
    assert.deepEqual(c.facts, [], `${c.id} has no facts`);
    const textOnly = [c.title, c.summary, ...c.notes].join("\n");
    assert.doesNotMatch(textOnly, /\d/, `${c.id} pending text has no digits: ${textOnly}`);
    assert.ok(c.summary.length > 20, `${c.id} explains the idea of the step`);
  }
});

test("missing inputs are tolerated: undefined session and controls give seven pending cards", () => {
  const cards = buildWalkthrough({});
  assert.equal(cards.length, 7);
  assert.ok(cards.every((c) => c.status === "pending"));
});

// ---- identity ----------------------------------------------------------------

test("identity card carries the key id, the full public key hex, the private-key statement, and the elapsed time", () => {
  const cards = buildWalkthrough({ session: upTo("identity"), controls: {}, timings: TIMINGS, status: idle() });
  const c = card(cards, "identity");
  assert.equal(c.status, "done");
  assert.equal(factValue(c, /key id/i), fx.identity.keyId);
  const pk = fact(c, /public key/i);
  assert.equal(pk.value, fx.identity.publicKeyHex);
  assert.equal(pk.value.length, 64);
  assert.equal(pk.mono, true);
  assert.equal(pk.full, true);
  assert.match(allText(c), /private key/i);
  assert.match(allText(c), /not transmitted/i);
  assert.match(allText(c), /stays in this browser/i);
  assert.equal(factValue(c, /elapsed/i), "12 ms");
  assert.doesNotMatch(allText(c), new RegExp(fx.identity.privateKeyHex), "the private key never appears in the walkthrough");
  for (const id of ["source", "payload", "embed", "verify", "controls", "inspect"]) assert.equal(card(cards, id).status, "pending");
});

// ---- source ------------------------------------------------------------------

test("source card carries the file name, dimensions, interval, sampling counts, and the letterbox statement from the source record", () => {
  const cards = buildWalkthrough({ session: upTo("source"), controls: {}, timings: TIMINGS, status: idle() });
  const c = card(cards, "source");
  assert.equal(c.status, "done");
  assert.match(factValue(c, /^file/i), /sintel-demo\.mp4/);
  assert.match(factValue(c, /source dimensions/i), /^1024x512$/);
  assert.match(factValue(c, /canonical/i), /1024x512/);
  assert.equal(factValue(c, /excerpt/i), fx.source.interval);
  assert.match(factValue(c, /frames sampled/i), /120 frames at 30 fps/);
  assert.match(factValue(c, /distinct/i), /118 distinct/);
  assert.match(factValue(c, /distinct/i), /2 duplicated/);
  assert.equal(factValue(c, /letterbox|scaling/i), fx.source.plan.description);
  assert.equal(factValue(c, /capture method/i), "requestVideoFrameCallback");
  // prepare (210.5 ms) + import (4800.2 ms)
  assert.equal(factValue(c, /elapsed/i), "5.0 s");
});

// ---- payload -----------------------------------------------------------------

test("framing arithmetic from a real 31-byte message equals 1024 bits", () => {
  const cards = buildWalkthrough({ session: upTo("payload"), controls: {}, timings: TIMINGS, status: idle() });
  const c = card(cards, "payload");
  assert.equal(c.status, "done");
  assert.equal(factValue(c, /^message$/i), fx.message);
  assert.match(factValue(c, /utf-8 bytes/i), /^31 UTF-8 bytes$/);
  const framing = factValue(c, /framing/i);
  assert.equal(framing, "(1 + 2 + 31 + 64 + 30) * 8 = 1024 bits");
  assert.equal(payloadBitLength(31), 1024);
  assert.match(factValue(c, /payload bits/i), /^1024 bits/);
  const sig = fact(c, /signature/i);
  assert.equal(sig.value, fx.payload.signatureHex);
  assert.equal(sig.value.length, 128);
  assert.equal(sig.full, true);
  assert.equal(factValue(c, /nonce/i), fx.nonce);
  assert.match(factValue(c, /layout/i), /not created yet/i);
});

test("the framing arithmetic uses the real byte count, not a fixed 31", () => {
  const longer = "Signed in the browser, APCVW v1!!"; // 33 bytes
  const payload = { ...fx.payload, message: longer, messageByteLength: 33, bitCount: payloadBitLength(33) };
  let s = { ...createSession(), message: longer, nonce: fx.nonce };
  s = applyChange(s, "identity", fx.identity);
  s = applyChange(s, "source", fx.source);
  s = applyChange(s, "payload", payload);
  const c = card(buildWalkthrough({ session: s, controls: {}, timings: {}, status: idle() }), "payload");
  assert.equal(factValue(c, /framing/i), "(1 + 2 + 33 + 64 + 30) * 8 = 1040 bits");
});

test("a library bit count that disagrees with the framing arithmetic is reported, not hidden", () => {
  const payload = { ...fx.payload, bitCount: 1032 };
  let s = { ...createSession(), message: fx.message, nonce: fx.nonce };
  s = applyChange(s, "identity", fx.identity);
  s = applyChange(s, "payload", payload);
  const c = card(buildWalkthrough({ session: s, controls: {}, timings: {}, status: idle() }), "payload");
  assert.match(factValue(c, /payload bits/i), /1032/);
  assert.match(allText(c), /differs/i);
});

test("after embedding, the payload card carries the layout summary: version, groups, bins per group, K, band, pool", () => {
  const cards = buildWalkthrough({ session: upTo("marked"), controls: {}, timings: TIMINGS, status: idle() });
  const layout = factValue(card(cards, "payload"), /layout/i);
  assert.match(layout, /apcvw-js-v1/);
  assert.match(layout, /4 groups/);
  assert.match(layout, /256 bins per group/);
  assert.match(layout, /K = 30/);
  assert.match(layout, /0\.05 to 0\.12/);
  assert.match(layout, /pool(?: of)? 2416/);
  assert.equal(fx.summary.poolSize, 2416);
});

// ---- embed -------------------------------------------------------------------

test("embed card lists every ladder rung with its target and verification state, the accepted rung, container, codec, size, wall time, and late frames", () => {
  const cards = buildWalkthrough({ session: upTo("marked"), controls: {}, timings: TIMINGS, status: idle() });
  const c = card(cards, "embed");
  assert.equal(c.status, "done");
  const rungs = c.facts.filter((f) => /^rung \d/i.test(f.label));
  assert.equal(rungs.length, 2);
  assert.match(rungs[0].value, /^42 dB target: not verified \(signature invalid\)/);
  assert.match(rungs[1].value, /^40 dB target: verified/);
  assert.match(rungs[1].value, /3 RS symbols corrected/);
  assert.match(factValue(c, /accepted rung/i), /^40 dB/);
  const out = factValue(c, /^output$/i);
  assert.match(out, /WebM/);
  assert.match(out, /VP9/);
  assert.match(out, /video\/webm;codecs=vp9/);
  assert.equal(factValue(c, /output size/i), "5.0 MB");
  assert.equal(factValue(c, /recording wall time/i), "4.6 s");
  assert.equal(factValue(c, /late frames/i), "1");
  assert.equal(factValue(c, /frames encoded/i), "120");
  assert.equal(factValue(c, /elapsed/i), "38.0 s");
});

test("an embed with no verified rung says so and never labels the output accepted", () => {
  const marked = { ...fx.marked, accepted: false, psnr: 32, ladder: fx.marked.ladder.map((r) => ({ ...r, verified: false, reason: "RS decode failed (too many errors)" })) };
  const s = applyChange(upTo("payload"), "marked", marked);
  const c = card(buildWalkthrough({ session: s, controls: {}, timings: {}, status: idle() }), "embed");
  assert.match(factValue(c, /accepted rung/i), /none/i);
  assert.match(factValue(c, /accepted rung/i), /32 dB/);
  assert.match(factValue(c, /accepted rung/i), /not verified/i);
});

test("absent embed data is reported as absent, never invented", () => {
  const marked = { ...fx.marked, wallMs: undefined, lateFrames: undefined, blob: undefined };
  const s = applyChange(upTo("payload"), "marked", marked);
  const c = card(buildWalkthrough({ session: s, controls: {}, timings: {}, status: idle() }), "embed");
  assert.match(factValue(c, /recording wall time/i), /not reported/i);
  assert.match(factValue(c, /late frames/i), /not reported/i);
  assert.match(factValue(c, /output size/i), /not reported/i);
});

// ---- verify ------------------------------------------------------------------

test("verify card carries verdict, reason, recovered message and signature, RS symbols, group counts, frames, and decode method", () => {
  const cards = buildWalkthrough({ session: upTo("verification"), controls: {}, timings: TIMINGS, status: idle() });
  const c = card(cards, "verify");
  assert.equal(c.status, "done");
  assert.equal(factValue(c, /^verdict$/i), "VERIFIED");
  assert.equal(factValue(c, /^reason$/i), "ok");
  assert.equal(factValue(c, /recovered message/i), fx.message);
  const sig = fact(c, /recovered signature \(/i) ?? fact(c, /^recovered signature$/i);
  assert.ok(sig, "recovered signature fact");
  assert.equal(sig.value, fx.payload.signatureHex);
  assert.equal(factValue(c, /rs symbols corrected/i), "3");
  assert.equal(factValue(c, /frames per group/i), "30 / 30 / 30 / 30");
  assert.equal(factValue(c, /frames decoded/i), "120");
  assert.equal(factValue(c, /decode method/i), "requestVideoFrameCallback");
  assert.equal(factValue(c, /elapsed/i), "5.2 s");
});

test("signature identity fact is true only when the bytes are equal, and false when one byte differs", () => {
  const label = /^Recovered signature identical to the signature created in step 3$/;
  const same = card(buildWalkthrough({ session: upTo("verification"), controls: {}, timings: {}, status: idle() }), "verify");
  assert.equal(factValue(same, label), true);
  assert.match(factValue(same, /bytes compared/i), /64 of 64/);

  const flipped = new Uint8Array(fx.payload.signature);
  flipped[17] ^= 0x01;
  const v2 = { ...fx.verification, result: { ...fx.verification.result, signature: flipped } };
  const s2 = applyChange(upTo("marked"), "verification", v2);
  const differ = card(buildWalkthrough({ session: s2, controls: {}, timings: {}, status: idle() }), "verify");
  assert.equal(factValue(differ, label), false);
  assert.match(factValue(differ, /bytes compared/i), /byte 17/);

  const v3 = { ...fx.verification, result: { ...fx.verification.result, verified: false, reason: "signature invalid", signature: null, messageBytes: null } };
  const s3 = applyChange(upTo("marked"), "verification", v3);
  const missing = card(buildWalkthrough({ session: s3, controls: {}, timings: {}, status: idle() }), "verify");
  assert.equal(typeof factValue(missing, label), "string");
  assert.match(factValue(missing, label), /not compared/i);
  assert.equal(factValue(missing, /^verdict$/i), "NOT VERIFIED");
  assert.equal(factValue(missing, /^reason$/i), "signature invalid");
});

test("compareBytes is a real byte comparison", () => {
  const a = new Uint8Array([1, 2, 3]);
  assert.deepEqual(compareBytes(a, new Uint8Array([1, 2, 3])), { equal: true, length: 3, firstDifference: -1 });
  assert.deepEqual(compareBytes(a, new Uint8Array([1, 9, 3])), { equal: false, length: 3, firstDifference: 1 });
  assert.equal(compareBytes(a, new Uint8Array([1, 2])).equal, false);
  assert.equal(compareBytes(a, null), null);
  assert.equal(compareBytes(undefined, a), null);
});

// ---- controls ----------------------------------------------------------------

test("wrong-key and unmarked cards carry the library reason verbatim, the unrelated public key, and say both ran the real verifier", () => {
  const cards = buildWalkthrough({ session: fullSession(), controls: fx.controls, timings: TIMINGS, status: idle() });
  const c = card(cards, "controls");
  assert.equal(c.status, "done");
  assert.equal(factValue(c, /wrong key verdict/i), "NOT VERIFIED");
  assert.equal(factValue(c, /wrong key reason/i), "signature invalid");
  assert.equal(factValue(c, /unrelated public key/i), fx.otherHex);
  assert.equal(factValue(c, /unmarked source verdict/i), "NOT VERIFIED");
  assert.equal(factValue(c, /unmarked source reason/i), "bad length header (0)");
  assert.match(c.notes.join(" "), /both controls ran the real verifier/i);
  assert.equal(factValue(c, /elapsed/i), "3.1 s");
});

test("a control reason is passed through exactly, including an unexpected outcome", () => {
  const odd = { ...fx.controls, wrongKey: { ...fx.controls.wrongKey, res: { ...fx.controls.wrongKey.res, result: { ...fx.controls.wrongKey.res.result, verified: true, reason: "ok", messageBytes: new Uint8Array(fx.payload.messageBytes), signature: new Uint8Array(fx.payload.signature) } } } };
  const c = card(buildWalkthrough({ session: fullSession(), controls: odd, timings: {}, status: idle() }), "controls");
  assert.equal(factValue(c, /wrong key verdict/i), "VERIFIED");
  assert.equal(factValue(c, /wrong key reason/i), "ok");
});

test("with only one control run, the card is not done and says which control has not run", () => {
  const c = card(buildWalkthrough({ session: fullSession(), controls: { wrongKey: fx.controls.wrongKey, unmarked: null }, timings: {}, status: idle() }), "controls");
  assert.notEqual(c.status, "done");
  assert.equal(factValue(c, /wrong key reason/i), "signature invalid");
  assert.match(allText(c), /unmarked source control has not run/i);
  assert.doesNotMatch(c.notes.join(" "), /both controls ran/i);
});

// ---- inspect -----------------------------------------------------------------

test("inspect card names the computed planes, the frame index, the gain, and the carrier band", () => {
  const cards = buildWalkthrough({ session: fullSession(), controls: fx.controls, timings: TIMINGS, status: idle() });
  const c = card(cards, "inspect");
  assert.equal(c.status, "done");
  const planes = factValue(c, /planes computed/i);
  assert.match(planes, /source/i);
  assert.match(planes, /marked/i);
  assert.match(planes, /decoded output/i);
  assert.match(planes, /residual/i);
  assert.equal(factValue(c, /frame index/i), "0");
  assert.equal(factValue(c, /gain/i), "x16");
  assert.match(factValue(c, /band/i), /0\.05 to 0\.12 cycles per pixel/);
  assert.match(factValue(c, /carrier residual/i), /40\.21 dB/);
  assert.match(factValue(c, /output residual/i), /37\.88 dB/);
  assert.equal(factValue(c, /elapsed/i), "900 ms");
});

test("an inspect result without a frame index says so instead of assuming zero", () => {
  const { frameIndex, ...noIndex } = fx.inspect;
  const s = applyChange(fullSession(), "inspect", { ...noIndex, spectrumOutput: null, residualOutput: null });
  const c = card(buildWalkthrough({ session: s, controls: fx.controls, timings: {}, status: idle() }), "inspect");
  assert.match(factValue(c, /frame index/i), /not recorded/i);
  assert.doesNotMatch(factValue(c, /planes computed/i), /decoded output/i);
  assert.match(factValue(c, /planes computed/i), /source frame/i);
  assert.match(factValue(c, /planes computed/i), /marked frame/i);
  assert.match(factValue(c, /output residual/i), /not reported/i);
});

// ---- run status --------------------------------------------------------------

test("a failed step marks its card failed with the real error, and later cards as not run", () => {
  const error = "MediaRecorder produced an empty Blob. The codec may be unsupported for canvas capture in this browser.";
  const status = { ...idle(), phase: "failed", failedStep: "doEmbed", error };
  const cards = buildWalkthrough({ session: upTo("payload"), controls: {}, timings: TIMINGS, status });
  for (const id of ["identity", "source", "payload"]) assert.equal(card(cards, id).status, "done", `${id} stays done`);
  const embed = card(cards, "embed");
  assert.equal(embed.status, "failed");
  assert.equal(factValue(embed, /^error$/i), error);
  for (const id of ["verify", "controls", "inspect"]) {
    const c = card(cards, id);
    assert.equal(c.status, "pending", `${id} is not run`);
    assert.match(allText(c), /did not run/i);
    assert.match(allText(c), /embedding/i, `${id} names the step where the run stopped`);
    assert.deepEqual(c.facts, []);
  }
});

test("a cancelled step marks its card cancelled and later cards as not run", () => {
  const status = { ...idle(), phase: "cancelled", cancelledStep: "doVerify" };
  const cards = buildWalkthrough({ session: upTo("marked"), controls: {}, timings: TIMINGS, status });
  assert.equal(card(cards, "verify").status, "cancelled");
  assert.match(allText(card(cards, "verify")), /cancelled/i);
  for (const id of ["controls", "inspect"]) {
    assert.equal(card(cards, id).status, "pending");
    assert.match(allText(card(cards, id)), /did not run/i);
  }
  assert.equal(card(cards, "embed").status, "done");
});

test("the running card shows the live progress text and completed cards keep their facts", () => {
  const progressText = "Rung 42 dB: marking and encoding frame 57 of 120";
  const status = { ...idle(), phase: "running", current: "doEmbed", progressText };
  const cards = buildWalkthrough({ session: upTo("payload"), controls: {}, timings: TIMINGS, status });
  const embed = card(cards, "embed");
  assert.equal(embed.status, "running");
  assert.equal(factValue(embed, /progress/i), progressText);
  assert.equal(card(cards, "payload").status, "done");
  assert.equal(factValue(card(cards, "payload"), /framing/i), "(1 + 2 + 31 + 64 + 30) * 8 = 1024 bits");
  for (const id of ["verify", "controls", "inspect"]) {
    assert.equal(card(cards, id).status, "pending");
    assert.doesNotMatch(allText(card(cards, id)), /did not run/i);
  }
});

test("a running step inside a two-step card marks the card running even when its first step is done", () => {
  const status = { ...idle(), phase: "running", current: "doUnmarked", progressText: "Unmarked source: evidence from frame 40 of 120" };
  const c = card(buildWalkthrough({ session: fullSession(), controls: { wrongKey: fx.controls.wrongKey, unmarked: null }, timings: {}, status }), "controls");
  assert.equal(c.status, "running");
  assert.equal(factValue(c, /wrong key reason/i), "signature invalid");
  assert.equal(factValue(c, /progress/i), "Unmarked source: evidence from frame 40 of 120");
});

// ---- prose -------------------------------------------------------------------

test("card prose uses no em dashes, en dashes, or hyphen chains as dashes", () => {
  const runs = [
    buildWalkthrough({ session: createSession(), controls: {}, timings: {}, status: idle() }),
    buildWalkthrough({ session: fullSession(), controls: fx.controls, timings: TIMINGS, status: { ...idle(), phase: "done" } }),
    buildWalkthrough({ session: upTo("payload"), controls: {}, timings: TIMINGS, status: { ...idle(), phase: "failed", failedStep: "doEmbed", error: "x" } }),
    buildWalkthrough({ session: upTo("marked"), controls: {}, timings: TIMINGS, status: { ...idle(), phase: "cancelled", cancelledStep: "doVerify" } }),
  ];
  for (const cards of runs) {
    for (const c of cards) {
      const t = allText(c);
      assert.doesNotMatch(t, /[–—]/, `${c.id}: no en or em dash`);
      assert.doesNotMatch(t, / - /, `${c.id}: no spaced hyphen used as a dash`);
      assert.doesNotMatch(t, /--/, `${c.id}: no double hyphen`);
    }
  }
});

test("formatDuration reports milliseconds below one second and seconds above", () => {
  assert.equal(formatDuration(12.4), "12 ms");
  assert.equal(formatDuration(999.4), "999 ms");
  assert.equal(formatDuration(1000), "1.0 s");
  assert.equal(formatDuration(38000), "38.0 s");
  assert.match(formatDuration(NaN), /not recorded/i);
  assert.match(formatDuration(undefined), /not recorded/i);
});
