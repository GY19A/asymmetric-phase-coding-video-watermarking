import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateIdentity, createPayload, createLayout, createCarriers, groupForFrame, embedFrame,
  extractFrameEvidence, verifyEvidence, DEFAULT_SAMPLE_MESSAGE,
} from '../src/lib/index.js';
import { makeFrame } from './helpers/synthetic.js';

// End-to-end on SYNTHETIC frames at the canonical 1024x512 size. This is a
// numerical unit test of embed -> evidence -> verify at identity geometry. It
// is not video evidence and says nothing about codecs or real footage.
const W = 1024; const H = 512; const FRAMES = 120;

const identity = await generateIdentity();
const stranger = await generateIdentity();
const payload = await createPayload(DEFAULT_SAMPLE_MESSAGE, identity.privateKey);
const layout = await createLayout({ width: W, height: H, nonce: 'pipeline-nonce-2026-09-06', bitCount: payload.bitCount });
const carriers = createCarriers(layout, payload.bits, 42);

const t0 = performance.now();
const sources = [];
const marked = [];
for (let t = 0; t < FRAMES; t++) {
  const src = makeFrame(W, H, 1000 + t * 7919);
  sources.push(src);
  marked.push(embedFrame(src, W, H, carriers.planes[groupForFrame(t, layout)]));
}
const t1 = performance.now();
const rows = marked.map((f) => extractFrameEvidence(f, W, H, layout));
const t2 = performance.now();
console.log(`# pipeline timing: generate+embed ${FRAMES} frames ${(t1 - t0).toFixed(0)} ms, extract ${(t2 - t1).toFixed(0)} ms`);

test('per-frame group identification from Re^2/Im^2 matches the embedded run-length cycle', () => {
  for (let t = 0; t < FRAMES; t++) {
    let best = 0;
    for (let g = 1; g < 4; g++) if (rows[t].scores[g] > rows[t].scores[best]) best = g;
    assert.equal(best, groupForFrame(t, layout), `frame ${t}`);
  }
});

test('marked synthetic frames verify, returning only recovered payload material', async () => {
  const r = await verifyEvidence(rows, layout, identity.publicKey);
  assert.equal(r.verified, true, r.reason);
  assert.equal(r.message, DEFAULT_SAMPLE_MESSAGE);
  assert.deepEqual(r.messageBytes, payload.messageBytes);
  assert.deepEqual(r.signature, payload.signature);
  assert.deepEqual(r.groupCounts, [30, 30, 30, 30]);
  let errors = 0;
  for (let i = 0; i < payload.bits.length; i++) if (r.extractedBits[i] !== payload.bits[i]) errors++;
  console.log(`# pipeline bit errors before RS: ${errors} of ${payload.bits.length}, corrected symbols ${r.correctedSymbols}`);
  assert.ok(errors <= 15, `bit errors ${errors}`);
  assert.equal(r.correctedSymbols <= 15, true);
});

test('the wrong public key is rejected', async () => {
  const r = await verifyEvidence(rows, layout, stranger.publicKey);
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'signature invalid');
  assert.equal(r.message, null);
});

test('clean unmarked frames are rejected', async () => {
  const cleanRows = sources.map((f) => extractFrameEvidence(f, W, H, layout));
  const r = await verifyEvidence(cleanRows, layout, identity.publicKey);
  assert.equal(r.verified, false);
  assert.equal(r.message, null);
  assert.equal(r.signature, null);
});

test('the wrong nonce is rejected', async () => {
  const other = await createLayout({ width: W, height: H, nonce: 'a-different-public-nonce', bitCount: payload.bitCount });
  const otherRows = marked.map((f) => extractFrameEvidence(f, W, H, other));
  const r = await verifyEvidence(otherRows, other, identity.publicKey);
  assert.equal(r.verified, false);
  assert.equal(r.message, null);
});
