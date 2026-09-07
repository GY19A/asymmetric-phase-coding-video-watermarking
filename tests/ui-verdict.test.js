// UI slice: rendering guards for verification results.
// The view model must only say VERIFIED when the library result is a strict,
// internally consistent positive, and must never take a message or verdict
// from metadata or any claimed field.
import test from "node:test";
import assert from "node:assert/strict";
import { verdictViewModel } from "../src/app/verdict.js";

const msgBytes = new TextEncoder().encode("Signed in the browser, APCVW v1");
const sig = new Uint8Array(64).fill(7);

function positive(extra = {}) {
  return {
    verified: true,
    reason: "signature valid",
    message: "Signed in the browser, APCVW v1",
    messageBytes: msgBytes,
    signature: sig,
    correctedSymbols: 2,
    extractedBits: new Uint8Array(1024),
    groupCounts: [30, 30, 30, 30],
    ...extra,
  };
}

test("no result renders as pending, never as verified", () => {
  const vm = verdictViewModel(null);
  assert.equal(vm.state, "pending");
  assert.notEqual(vm.label, "VERIFIED");
  assert.equal(vm.messageText, null);
});

test("a strict positive result renders VERIFIED with recovered fields", () => {
  const vm = verdictViewModel(positive(), { publicKeyHex: "ab".repeat(32) });
  assert.equal(vm.state, "verified");
  assert.equal(vm.label, "VERIFIED");
  assert.equal(vm.messageText, "Signed in the browser, APCVW v1");
  assert.equal(vm.signatureHex, "07".repeat(64));
  assert.equal(vm.correctedSymbols, 2);
  assert.deepEqual(vm.groupCounts, [30, 30, 30, 30]);
  assert.equal(vm.messageByteLength, 31);
  assert.match(vm.scopeNote, /public key/i);
});

test("verified must be the boolean true, not a truthy value", () => {
  for (const v of ["true", 1, {}, [], "VERIFIED"]) {
    const vm = verdictViewModel(positive({ verified: v }));
    assert.equal(vm.state, "rejected", `value ${JSON.stringify(v)} must not verify`);
    assert.equal(vm.label, "NOT VERIFIED");
  }
});

test("a positive flag without a 64-byte signature is reported as inconsistent, not verified", () => {
  const noSig = verdictViewModel(positive({ signature: undefined }));
  assert.equal(noSig.state, "inconsistent");
  assert.equal(noSig.label, "NOT VERIFIED");
  assert.match(noSig.reason, /signature/i);
  const shortSig = verdictViewModel(positive({ signature: new Uint8Array(63) }));
  assert.equal(shortSig.state, "inconsistent");
  const noMsg = verdictViewModel(positive({ messageBytes: undefined }));
  assert.equal(noMsg.state, "inconsistent");
});

test("a rejection keeps the library reason and shows recovered bytes only as unverified", () => {
  const vm = verdictViewModel({
    verified: false,
    reason: "signature invalid",
    messageBytes: msgBytes,
    signature: sig,
    correctedSymbols: 0,
    groupCounts: [30, 30, 30, 30],
  });
  assert.equal(vm.state, "rejected");
  assert.equal(vm.label, "NOT VERIFIED");
  assert.equal(vm.reason, "signature invalid");
  assert.equal(vm.messageText, "Signed in the browser, APCVW v1");
  assert.equal(vm.messageIsUnverified, true);
  assert.equal(vm.signatureHex, "07".repeat(64));
});

test("a rejection without decodable payload shows no message and a fallback reason", () => {
  const vm = verdictViewModel({ verified: false, correctedSymbols: null, groupCounts: [31, 29, 30, 30] });
  assert.equal(vm.state, "rejected");
  assert.equal(vm.messageText, null);
  assert.equal(vm.signatureHex, null);
  assert.match(vm.reason, /no reason/i);
  assert.deepEqual(vm.groupCounts, [31, 29, 30, 30]);
});

test("claimed fields from metadata or context never leak into the view model", () => {
  const ctx = {
    publicKeyHex: "ab".repeat(32),
    metadata: { message: "forged claim", signature: "ff".repeat(64), verified: true },
    claimedMessage: "forged claim",
  };
  const vm = verdictViewModel({ verified: false, reason: "RS decode failed" }, ctx);
  assert.equal(vm.state, "rejected");
  assert.equal(vm.messageText, null);
  assert.equal(vm.signatureHex, null);
  assert.equal(JSON.stringify(vm).includes("forged"), false);
});

test("undecodable message bytes are rendered with replacement characters, not dropped", () => {
  const vm = verdictViewModel(positive({ messageBytes: new Uint8Array([0xff, 0x41]), message: undefined }));
  assert.equal(vm.state, "verified");
  assert.equal(vm.messageText, "�A");
});

test("the view model reports which public key was used", () => {
  const vm = verdictViewModel(positive(), { publicKeyHex: "ab".repeat(32) });
  assert.equal(vm.publicKeyHex, "ab".repeat(32));
  assert.equal(vm.keyId, "abababab");
});
