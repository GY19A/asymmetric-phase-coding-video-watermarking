// UI slice: protocol session state and stage invalidation.
// Changing identity, message, nonce, or source must clear stale results.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  applyChange,
  stepStatuses,
  setActiveStep,
  firstIncompleteStep,
  canEmbed,
  STEPS,
} from "../src/app/session.js";

const identity = { publicKeyHex: "aa".repeat(32) };
const payload = { bitCount: 1024, signatureHex: "bb".repeat(64) };
const source = { kind: "builtin", width: 1024, height: 512 };
const marked = { blobSize: 1, mime: "video/webm;codecs=vp9", psnr: 42 };
const verification = { verified: true };

function fullSession() {
  let s = createSession();
  s = applyChange(s, "identity", identity);
  s = applyChange(s, "payload", payload);
  s = applyChange(s, "source", source);
  s = applyChange(s, "marked", marked);
  s = applyChange(s, "verification", verification);
  return s;
}

test("STEPS lists the five protocol steps in order", () => {
  assert.equal(STEPS.length, 5);
  assert.deepEqual(STEPS.map((s) => s.index), [1, 2, 3, 4, 5]);
  assert.match(STEPS[0].title, /identity/i);
  assert.match(STEPS[4].title, /inspect/i);
});

test("a fresh session has step 1 ready and the rest locked", () => {
  const s = createSession();
  assert.equal(s.activeStep, 1);
  const st = stepStatuses(s);
  assert.equal(st[0].status, "ready");
  assert.deepEqual(st.slice(1).map((x) => x.status), ["locked", "locked", "locked", "locked"]);
});

test("applyChange returns a new object and leaves the input untouched", () => {
  const s = createSession();
  const next = applyChange(s, "identity", identity);
  assert.notEqual(next, s);
  assert.equal(s.identity, null);
  assert.equal(next.identity, identity);
});

test("statuses progress as results arrive", () => {
  let s = createSession();
  s = applyChange(s, "identity", identity);
  let st = stepStatuses(s);
  assert.equal(st[0].status, "done");
  assert.equal(st[1].status, "ready");
  assert.equal(st[2].status, "locked");

  s = applyChange(s, "source", source);
  st = stepStatuses(s);
  assert.equal(st[1].status, "done");
  // Step 3 opens once identity and source exist. Signing happens inside it,
  // and the Embed action stays disabled until a payload exists.
  assert.equal(st[2].status, "ready");
  assert.equal(canEmbed(s), false);

  s = applyChange(s, "payload", payload);
  st = stepStatuses(s);
  assert.equal(st[2].status, "ready");
  assert.equal(canEmbed(s), true);

  s = applyChange(s, "marked", marked);
  st = stepStatuses(s);
  assert.equal(st[2].status, "done");
  assert.equal(st[3].status, "ready");
  assert.equal(st[4].status, "ready");

  s = applyChange(s, "verification", verification);
  st = stepStatuses(s);
  assert.equal(st[3].status, "done");
});

test("changing the nonce invalidates marked, verification, and inspect but keeps identity and payload", () => {
  const s = applyChange(fullSession(), "nonce", "new-public-nonce");
  assert.equal(s.marked, null);
  assert.equal(s.verification, null);
  assert.equal(s.inspect, null);
  assert.equal(s.identity, identity);
  assert.equal(s.payload, payload);
  assert.equal(s.source, source);
});

test("changing the identity also invalidates the payload", () => {
  const s = applyChange(fullSession(), "identity", { publicKeyHex: "cc".repeat(32) });
  assert.equal(s.payload, null);
  assert.equal(s.marked, null);
  assert.equal(s.verification, null);
  assert.equal(s.source, source);
});

test("changing the message invalidates the payload and everything after it", () => {
  const s = applyChange(fullSession(), "message", "another message");
  assert.equal(s.message, "another message");
  assert.equal(s.payload, null);
  assert.equal(s.marked, null);
  assert.equal(s.verification, null);
  assert.equal(canEmbed(s), false);
});

test("changing the source invalidates marked and verification but keeps payload", () => {
  const s = applyChange(fullSession(), "source", { kind: "file", width: 640, height: 480 });
  assert.equal(s.payload, payload);
  assert.equal(s.marked, null);
  assert.equal(s.verification, null);
  assert.equal(s.inspect, null);
});

test("a new marked result clears a previous verification", () => {
  const s = applyChange(fullSession(), "marked", { ...marked, psnr: 40 });
  assert.equal(s.verification, null);
  assert.equal(s.inspect, null);
});

test("invalidation pulls the active step back to the first incomplete step", () => {
  let s = fullSession();
  s = setActiveStep(s, 5);
  assert.equal(s.activeStep, 5);
  s = applyChange(s, "source", { kind: "file", width: 640, height: 480 });
  assert.equal(firstIncompleteStep(s), 3);
  assert.equal(s.activeStep, 3);
});

test("setActiveStep refuses locked steps and allows revisiting completed ones", () => {
  let s = createSession();
  const same = setActiveStep(s, 3);
  assert.equal(same, s);
  s = fullSession();
  s = setActiveStep(s, 4);
  assert.equal(s.activeStep, 4);
  s = setActiveStep(s, 1);
  assert.equal(s.activeStep, 1);
  assert.equal(setActiveStep(s, 9), s);
  assert.equal(setActiveStep(s, 0), s);
});

test("unknown fields are rejected loudly instead of silently stored", () => {
  assert.throws(() => applyChange(createSession(), "somethingElse", 1), /unknown/i);
});
