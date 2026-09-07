// UI slice: deterministic 120-slot sampling of the four second excerpt,
// frame duplication plan for sources below 30 fps, and cadence math.
import test from "node:test";
import assert from "node:assert/strict";
import {
  sampleSlotFor,
  fillMissingSlots,
  samplingSummary,
  groupForSampleIndex,
  frameIntervalMs,
} from "../src/app/sampling.js";

test("sampleSlotFor maps presented times to 30 fps slots inside the excerpt", () => {
  const start = 2.0;
  assert.equal(sampleSlotFor(start, start, 30, 120), 0);
  assert.equal(sampleSlotFor(start + 1 / 30, start, 30, 120), 1);
  assert.equal(sampleSlotFor(start + 119 / 30, start, 30, 120), 119);
  assert.equal(sampleSlotFor(start + 3.99999, start, 30, 120), 119);
});

test("sampleSlotFor returns -1 outside the excerpt", () => {
  assert.equal(sampleSlotFor(1.9, 2.0, 30, 120), -1);
  assert.equal(sampleSlotFor(6.0, 2.0, 30, 120), -1);
  assert.equal(sampleSlotFor(6.5, 2.0, 30, 120), -1);
});

test("sampleSlotFor tolerates tiny timestamp noise below a frame boundary", () => {
  const start = 0;
  // 1/30 minus one microsecond still belongs to slot 1 in practice.
  assert.equal(sampleSlotFor(1 / 30 - 1e-6, start, 30, 120), 1);
  // Half a frame early is slot 0.
  assert.equal(sampleSlotFor(1 / 60, start, 30, 120), 0);
});

test("fillMissingSlots duplicates the nearest earlier captured frame", () => {
  const plan = fillMissingSlots([true, false, true, false, false]);
  assert.deepEqual(plan.sourceSlot, [0, 0, 2, 2, 2]);
  assert.equal(plan.duplicated, 3);
  assert.equal(plan.distinct, 2);
});

test("fillMissingSlots uses the first captured frame for leading gaps", () => {
  const plan = fillMissingSlots([false, false, true, true]);
  assert.deepEqual(plan.sourceSlot, [2, 2, 2, 3]);
  assert.equal(plan.duplicated, 2);
});

test("fillMissingSlots fails loudly when nothing was captured", () => {
  assert.throws(() => fillMissingSlots([false, false]), /no frames/i);
});

test("samplingSummary reports observed distinct frames and duplication honestly", () => {
  const filled = new Array(120).fill(true);
  for (let i = 0; i < 120; i += 5) filled[i] = false; // 24 gaps, like a 24 fps source
  const s = samplingSummary(filled);
  assert.equal(s.total, 120);
  assert.equal(s.distinct, 96);
  assert.equal(s.duplicated, 24);
  assert.match(s.text, /96 distinct/);
  assert.match(s.text, /24 duplicated/);
  const clean = samplingSummary(new Array(120).fill(true));
  assert.match(clean.text, /120 distinct/);
  assert.equal(/duplicated/.test(clean.text), false);
});

test("groupForSampleIndex follows the run-length cycle G=4, K=30 for the signer only", () => {
  assert.equal(groupForSampleIndex(0, 30, 4), 0);
  assert.equal(groupForSampleIndex(29, 30, 4), 0);
  assert.equal(groupForSampleIndex(30, 30, 4), 1);
  assert.equal(groupForSampleIndex(89, 30, 4), 2);
  assert.equal(groupForSampleIndex(119, 30, 4), 3);
  assert.equal(groupForSampleIndex(120, 30, 4), 0);
});

test("frameIntervalMs is 1000/fps", () => {
  assert.ok(Math.abs(frameIntervalMs(30) - 33.3333) < 1e-3);
  assert.equal(frameIntervalMs(25), 40);
});
