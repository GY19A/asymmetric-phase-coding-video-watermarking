import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayout } from '../src/lib/layout.js';
import { carrierAlpha, buildCarrierSpectrum, buildCarrierPlane, createCarriers, groupForFrame } from '../src/lib/carrier.js';
import { fft2d } from '../src/lib/fft.js';
import { mulberry32 } from './helpers/testprng.js';

const WIDTH = 1024;
const HEIGHT = 512;
const layout = await createLayout({ width: WIDTH, height: HEIGHT, nonce: 'carrier-test-nonce', bitCount: 1024 });
const rnd = mulberry32(77);
const bits = new Uint8Array(1024);
for (let i = 0; i < bits.length; i++) bits[i] = rnd() < 0.5 ? 0 : 1;

function signsFor(group) {
  const g = layout.groups[group];
  const s = new Float64Array(g.bits.length);
  for (let j = 0; j < s.length; j++) s[j] = 2 * bits[g.bits[j]] - 1;
  return s;
}

test('alpha follows the reference per-frame PSNR amplitude formula', () => {
  const per = 256;
  const want = Math.sqrt((2 * 255 * 255) / (10 ** (42 / 10) * per));
  assert.ok(Math.abs(carrierAlpha(42, per) - want) < 1e-15);
  assert.ok(carrierAlpha(36, per) > carrierAlpha(42, per));
  assert.throws(() => carrierAlpha(NaN, per));
  assert.throws(() => carrierAlpha(42, 0));
});

test('carrier spectrum is conjugate symmetric and lives only on layout bins', () => {
  const alpha = carrierAlpha(42, 256);
  const { re, im } = buildCarrierSpectrum(layout, 0, signsFor(0), alpha);
  assert.equal(re.length, WIDTH * HEIGHT);
  let nonzero = 0;
  for (let v = 0; v < HEIGHT; v++) {
    for (let u = 0; u < WIDTH; u++) {
      const a = v * WIDTH + u;
      const b = ((HEIGHT - v) % HEIGHT) * WIDTH + ((WIDTH - u) % WIDTH);
      assert.ok(re[a] === re[b]);
      assert.ok(im[a] === -im[b]);
      if (re[a] !== 0 || im[a] !== 0) nonzero++;
    }
  }
  assert.equal(nonzero, 2 * 256);
  const g = layout.groups[0];
  const n = WIDTH * HEIGHT;
  for (let j = 0; j < 256; j++) {
    const idx = g.ky[j] * WIDTH + ((g.kx[j] + WIDTH) % WIDTH);
    const mag = Math.hypot(re[idx], im[idx]);
    assert.ok(Math.abs(mag - (alpha * n) / 2) < 1e-6 * mag);
  }
});

test('carrier plane is real, zero mean, and has the target power', () => {
  const alpha = carrierAlpha(42, 256);
  const plane = buildCarrierPlane(layout, 1, signsFor(1), alpha);
  assert.ok(plane instanceof Float32Array);
  assert.equal(plane.length, WIDTH * HEIGHT);
  let sum = 0; let sq = 0;
  for (let i = 0; i < plane.length; i++) { sum += plane[i]; sq += plane[i] * plane[i]; }
  const mean = sum / plane.length;
  const power = sq / plane.length;
  const wantPower = (256 * alpha * alpha) / 2;
  assert.ok(Math.abs(mean) < 1e-6, `mean ${mean}`);
  assert.ok(Math.abs(power - wantPower) / wantPower < 1e-4, `power ${power} want ${wantPower}`);
  const psnr = 10 * Math.log10((255 * 255) / power);
  assert.ok(Math.abs(psnr - 42) < 1e-3, `psnr ${psnr}`);
});

test('FFT of the plane sampled at bins and rotated by the phase recovers the signs', () => {
  const alpha = carrierAlpha(42, 256);
  const group = 2;
  const signs = signsFor(group);
  const plane = buildCarrierPlane(layout, group, signs, alpha);
  const re = Float64Array.from(plane);
  const im = new Float64Array(re.length);
  fft2d(re, im, WIDTH, HEIGHT, false);
  const g = layout.groups[group];
  const expect = (alpha * WIDTH * HEIGHT) / 2;
  for (let j = 0; j < g.ky.length; j++) {
    const idx = g.ky[j] * WIDTH + ((g.kx[j] + WIDTH) % WIDTH);
    const c = Math.cos(g.phases[j]); const s = Math.sin(g.phases[j]);
    const cr = re[idx] * c + im[idx] * s;
    const ci = im[idx] * c - re[idx] * s;
    assert.ok(Math.abs(cr - signs[j] * expect) < 1e-2 * expect, `bin ${j}: ${cr} vs ${signs[j] * expect}`);
    assert.ok(Math.abs(ci) < 1e-2 * expect, `bin ${j}: imag ${ci}`);
  }
  const other = layout.groups[(group + 1) % 4];
  for (let j = 0; j < other.ky.length; j++) {
    const idx = other.ky[j] * WIDTH + ((other.kx[j] + WIDTH) % WIDTH);
    assert.ok(Math.hypot(re[idx], im[idx]) < 1e-3 * expect);
  }
});

test('createCarriers returns four planes per strength and sign inversion negates them', () => {
  const carriers = createCarriers(layout, bits, 42);
  assert.equal(carriers.planes.length, 4);
  assert.equal(carriers.psnrTarget, 42);
  assert.ok(Math.abs(carriers.alpha - carrierAlpha(42, 256)) < 1e-15);
  for (const p of carriers.planes) {
    assert.ok(p instanceof Float32Array);
    assert.equal(p.length, WIDTH * HEIGHT);
  }
  let diff = 0;
  for (let i = 0; i < 1000; i++) diff += Math.abs(carriers.planes[0][i] - carriers.planes[1][i]);
  assert.ok(diff > 0);
  const inverted = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) inverted[i] = 1 - bits[i];
  const neg = createCarriers(layout, inverted, 42);
  for (let i = 0; i < WIDTH * HEIGHT; i += 997) {
    assert.ok(Math.abs(carriers.planes[3][i] + neg.planes[3][i]) < 1e-6);
  }
  assert.throws(() => createCarriers(layout, new Uint8Array(1000), 42), /bit/);
  assert.throws(() => createCarriers(layout, bits, 0), /psnr/i);
});

test('groupForFrame cycles K=30 frame runs over the four groups (embed side only)', () => {
  assert.equal(layout.runLength, 30);
  assert.equal(groupForFrame(0, layout), 0);
  assert.equal(groupForFrame(29, layout), 0);
  assert.equal(groupForFrame(30, layout), 1);
  assert.equal(groupForFrame(89, layout), 2);
  assert.equal(groupForFrame(119, layout), 3);
  assert.equal(groupForFrame(120, layout), 0);
  assert.throws(() => groupForFrame(-1, layout));
});
