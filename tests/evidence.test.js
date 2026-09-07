import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceFromPlane, extractFrameEvidence, smoothGroups, verifyEvidence } from '../src/lib/evidence.js';
import { createLayout } from '../src/lib/layout.js';
import { createCarriers, groupForFrame } from '../src/lib/carrier.js';
import { createPayload, DEFAULT_SAMPLE_MESSAGE } from '../src/lib/payload.js';
import { publicKeyFromPrivate } from '../src/lib/identity.js';
import { fromHex } from '../src/lib/hex.js';
import { fixtures } from './helpers/fixtures.js';
import { makeFrame } from './helpers/synthetic.js';

const W = 512; const H = 512;
const seed = fromHex(fixtures.framing.seed);
const pub = publicKeyFromPrivate(seed);
const payload = await createPayload(DEFAULT_SAMPLE_MESSAGE, seed);
const layout = await createLayout({ width: W, height: H, nonce: 'evidence-test', bitCount: payload.bitCount });
const carriers = createCarriers(layout, payload.bits, 42);

function offsetPlane(plane) {
  const out = new Float64Array(plane.length);
  for (let i = 0; i < out.length; i++) out[i] = 128 + plane[i];
  return out;
}

test('smoothGroups is the reference window mode with lowest-index ties', () => {
  assert.deepEqual(smoothGroups([0, 0, 1, 0, 0], 3), [0, 0, 0, 0, 0]);
  assert.deepEqual(smoothGroups([2, 1, 3], 1), [2, 1, 3]);
  assert.deepEqual(smoothGroups([1, 2], 3), [1, 1]);
  const clean = [];
  for (let t = 0; t < 120; t++) clean.push(Math.floor(t / 30) % 4);
  assert.deepEqual(smoothGroups(clean, 30), clean);
  // Isolated wrong decisions inside a run are absorbed.
  const interior = clean.slice();
  interior[5] = 3; interior[118] = 0;
  assert.deepEqual(smoothGroups(interior, 30), clean);
  // Reference property: a wrong decision within K/2 frames of a run boundary
  // flips the 16-vs-15 majority at exactly that boundary frame and nowhere else.
  const nearBoundary = clean.slice();
  nearBoundary[45] = 0;
  const expected = clean.slice();
  expected[30] = 0;
  assert.deepEqual(smoothGroups(nearBoundary, 30), expected);
});

test('evidence from a pure carrier plane picks its group by Re^2/Im^2 and recovers the signs', () => {
  for (let g = 0; g < 4; g++) {
    const row = evidenceFromPlane(offsetPlane(carriers.planes[g]), W, H, layout);
    assert.equal(row.version, 'apcvw-js-v1');
    assert.ok(row.scores instanceof Float64Array);
    assert.equal(row.scores.length, 4);
    assert.equal(row.groups.length, 4);
    let best = 0;
    for (let k = 1; k < 4; k++) if (row.scores[k] > row.scores[best]) best = k;
    assert.equal(best, g);
    for (let k = 0; k < 4; k++) if (k !== g) assert.ok(row.scores[g] > 1e6 * Math.max(row.scores[k], 1e-300), `group ${g} vs ${k}`);
    const ev = row.groups[g];
    const grp = layout.groups[g];
    assert.equal(ev.re.length, grp.ky.length);
    assert.equal(ev.im.length, grp.ky.length);
    assert.equal(ev.weights.length, grp.ky.length);
    for (let j = 0; j < grp.ky.length; j++) {
      const want = payload.bits[grp.bits[j]] ? 1 : -1;
      assert.equal(Math.sign(ev.re[j]), want, `group ${g} bin ${j}`);
      assert.ok(Math.abs(ev.im[j]) < 1e-3 * Math.abs(ev.re[j]));
      assert.ok(Number.isFinite(ev.weights[j]) && ev.weights[j] > 0);
    }
  }
});

test('extractFrameEvidence on RGBA equals evidence from its own Cr plane and checks the layout size', () => {
  const frame = makeFrame(W, H, 4);
  const row = extractFrameEvidence(frame, W, H, layout);
  assert.equal(row.groups[0].re.length, 256);
  assert.throws(() => extractFrameEvidence(frame, W, H, { ...layout, width: 1024 }), /layout/);
  assert.throws(() => extractFrameEvidence(new Uint8ClampedArray(8), W, H, layout), /does not match/);
});

test('verifyEvidence recovers the payload from group evidence and needs no original message', async () => {
  const byGroup = carriers.planes.map((p) => evidenceFromPlane(offsetPlane(p), W, H, layout));
  const rows = [];
  for (let t = 0; t < 120; t++) rows.push(byGroup[groupForFrame(t, layout)]);
  assert.equal(verifyEvidence.length, 3);
  const r = await verifyEvidence(rows, layout, pub);
  assert.equal(r.verified, true, r.reason);
  assert.equal(r.reason, 'ok');
  assert.equal(r.message, DEFAULT_SAMPLE_MESSAGE);
  assert.deepEqual(r.messageBytes, payload.messageBytes);
  assert.deepEqual(r.signature, payload.signature);
  assert.equal(r.correctedSymbols, 0);
  assert.deepEqual(r.extractedBits, payload.bits);
  assert.deepEqual(r.groupCounts, [30, 30, 30, 30]);
  assert.equal(r.frameCount, 120);
});

test('verifyEvidence rejects a wrong key, absent signal, constant fabricated evidence, and empty input', async () => {
  const byGroup = carriers.planes.map((p) => evidenceFromPlane(offsetPlane(p), W, H, layout));
  const rows = [];
  for (let t = 0; t < 120; t++) rows.push(byGroup[groupForFrame(t, layout)]);
  const wrong = await verifyEvidence(rows, layout, publicKeyFromPrivate(fromHex(fixtures.ed25519.rfc8032[0].seed)));
  assert.equal(wrong.verified, false);
  assert.equal(wrong.reason, 'signature invalid');
  assert.equal(wrong.message, null);
  assert.equal(wrong.messageBytes, null);
  assert.equal(wrong.signature, null);

  const flat = evidenceFromPlane(new Float64Array(W * H).fill(128), W, H, layout);
  const absent = await verifyEvidence(new Array(120).fill(flat), layout, pub);
  assert.equal(absent.verified, false);
  assert.deepEqual(absent.groupCounts, [120, 0, 0, 0]);

  const per = layout.groups[0].ky.length;
  const fabricated = {
    version: 'apcvw-js-v1',
    scores: new Float64Array([1e30, 1e30, 1e30, 1e30]),
    groups: [0, 1, 2, 3].map(() => ({ re: new Float32Array(per).fill(1), im: new Float32Array(per), weights: new Float32Array(per).fill(1) })),
  };
  const fake = await verifyEvidence(new Array(120).fill(fabricated), layout, pub);
  assert.equal(fake.verified, false);

  const empty = await verifyEvidence([], layout, pub);
  assert.equal(empty.verified, false);
  assert.equal(empty.reason, 'no evidence rows');
  assert.deepEqual(empty.groupCounts, [0, 0, 0, 0]);

  await assert.rejects(() => verifyEvidence(rows, layout, new Uint8Array(31)), /32/);
  await assert.rejects(() => verifyEvidence([{ scores: new Float64Array(4), groups: [] }], layout, pub), /row/);
});
