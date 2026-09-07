// UI slice: public decoding metadata that travels next to a signed output.
// It must carry layout parameters only. Any claimed message, signature, or
// verdict is stripped and reported so it can never become the result.
import test from "node:test";
import assert from "node:assert/strict";
import { buildMetadata, parseMetadata, METADATA_FORMAT } from "../src/app/metadata.js";

const base = {
  nonce: "demo-nonce-1234",
  bitCount: 1024,
  messageByteLength: 31,
  publicKeyHex: "ab".repeat(32),
  canonical: { width: 1024, height: 512 },
  layoutVersion: "apcvw-js-v1",
  runLength: 30,
  groups: 4,
  mode: "runlength",
  outputMime: "video/webm;codecs=vp9",
  psnrTarget: 42,
};

test("buildMetadata emits only public layout fields", () => {
  const m = buildMetadata(base);
  assert.equal(m.format, METADATA_FORMAT);
  assert.equal(m.nonce, base.nonce);
  assert.equal(m.bitCount, 1024);
  assert.equal(m.messageByteLength, 31);
  assert.equal(m.publicKey, "ab".repeat(32));
  assert.deepEqual(m.canonical, { width: 1024, height: 512 });
  assert.equal(m.runLength, 30);
  assert.equal(m.groups, 4);
  assert.equal(m.mode, "runlength");
  assert.equal("message" in m, false);
  assert.equal("signature" in m, false);
  assert.equal("verified" in m, false);
  assert.equal("privateKey" in m, false);
  assert.equal("seed" in m, false);
});

test("buildMetadata refuses private material", () => {
  assert.throws(() => buildMetadata({ ...base, privateKeyHex: "00".repeat(32) }), /private/i);
  assert.throws(() => buildMetadata({ ...base, message: "hello" }), /message/i);
});

test("parseMetadata accepts its own output", () => {
  const text = JSON.stringify(buildMetadata(base));
  const r = parseMetadata(text);
  assert.equal(r.ok, true);
  assert.equal(r.metadata.nonce, base.nonce);
  assert.deepEqual(r.ignoredFields, []);
});

test("parseMetadata strips and reports claimed result fields", () => {
  const forged = { ...buildMetadata(base), message: "forged", signature: "ff".repeat(64), verified: true };
  const r = parseMetadata(JSON.stringify(forged));
  assert.equal(r.ok, true);
  assert.deepEqual([...r.ignoredFields].sort(), ["message", "signature", "verified"]);
  assert.equal("message" in r.metadata, false);
  assert.equal("verified" in r.metadata, false);
});

test("parseMetadata rejects invalid JSON, wrong format, and missing fields", () => {
  assert.equal(parseMetadata("{not json").code, "invalid-json");
  assert.equal(parseMetadata(JSON.stringify({ ...buildMetadata(base), format: "other" })).code, "unsupported-format");
  const noNonce = { ...buildMetadata(base) };
  delete noNonce.nonce;
  const r = parseMetadata(JSON.stringify(noNonce));
  assert.equal(r.code, "missing-field");
  assert.match(r.message, /nonce/);
});

test("parseMetadata validates the optional public key and numeric fields", () => {
  const badKey = parseMetadata(JSON.stringify({ ...buildMetadata(base), publicKey: "abc" }));
  assert.equal(badKey.code, "bad-public-key");
  const badBits = parseMetadata(JSON.stringify({ ...buildMetadata(base), bitCount: "1024" }));
  assert.equal(badBits.code, "bad-field");
  const noKey = { ...buildMetadata(base) };
  delete noKey.publicKey;
  assert.equal(parseMetadata(JSON.stringify(noKey)).ok, true);
});

test("parseMetadata only accepts the canonical size the browser layout supports", () => {
  const r = parseMetadata(JSON.stringify({ ...buildMetadata(base), canonical: { width: 1000, height: 500 } }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad-field");
});
