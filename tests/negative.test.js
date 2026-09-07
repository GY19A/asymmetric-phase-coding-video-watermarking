import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateIdentity, createPayload, createLayout, createCarriers, groupForFrame, embedFrame,
  extractFrameEvidence, verifyEvidence, DEFAULT_SAMPLE_MESSAGE, bytesToBits,
} from '../src/lib/index.js';
import { rsEncode } from '../src/lib/rs.js';
import { makeFrame } from './helpers/synthetic.js';

// Known wrong variants pushed through real pixels (synthetic frames, 512x512
// for speed). The checker must discriminate tampering from channel errors.
const W = 512; const H = 512; const FRAMES = 120;
const identity = await generateIdentity();
const payload = await createPayload(DEFAULT_SAMPLE_MESSAGE, identity.privateKey);
const layout = await createLayout({ width: W, height: H, nonce: 'negative-variants', bitCount: payload.bitCount });
const sources = [];
for (let t = 0; t < FRAMES; t++) sources.push(makeFrame(W, H, 5000 + t * 104729));

async function verifyBits(bits) {
  const carriers = createCarriers(layout, bits, 42);
  const rows = [];
  for (let t = 0; t < FRAMES; t++) {
    const marked = embedFrame(sources[t], W, H, carriers.planes[groupForFrame(t, layout)]);
    rows.push(extractFrameEvidence(marked, W, H, layout));
  }
  return { rows, result: await verifyEvidence(rows, layout, identity.publicKey) };
}

const body = payload.codedBytes.slice(0, payload.codedBytes.length - 30);

test('sanity: the untampered payload verifies through pixels', async () => {
  const { result } = await verifyBits(payload.bits);
  assert.equal(result.verified, true, result.reason);
  assert.equal(result.message, DEFAULT_SAMPLE_MESSAGE);
});

test('a tampered message byte with the original signature is rejected', async () => {
  const b = Uint8Array.from(body);
  b[3] ^= 0x20;
  const { result } = await verifyBits(bytesToBits(rsEncode(b)));
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'signature invalid');
  assert.equal(result.message, null);
});

test('one inverted signature bit is rejected', async () => {
  const b = Uint8Array.from(body);
  b[3 + 31 + 40] ^= 0x01;
  const { result } = await verifyBits(bytesToBits(rsEncode(b)));
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'signature invalid');
});

test('a content-bound flag is rejected explicitly', async () => {
  const b = Uint8Array.from(body);
  b[0] = 1;
  const { result } = await verifyBits(bytesToBits(rsEncode(b)));
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'content-bound payload not supported');
});

test('a channel-style coded bit inversion is corrected, which distinguishes noise from tampering', async () => {
  const bits = Uint8Array.from(payload.bits);
  bits[777] ^= 1;
  const { result } = await verifyBits(bits);
  assert.equal(result.verified, true, result.reason);
  assert.ok(result.correctedSymbols >= 1);
  assert.equal(result.message, DEFAULT_SAMPLE_MESSAGE);
});

test('inverting every soft value of honest evidence is rejected', async () => {
  const { rows } = await verifyBits(payload.bits);
  const flipped = rows.map((row) => ({
    ...row,
    groups: row.groups.map((g) => ({ re: g.re.map((v) => -v), im: g.im, weights: g.weights })),
  }));
  const r = await verifyEvidence(flipped, layout, identity.publicKey);
  assert.equal(r.verified, false);
});
