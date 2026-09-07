import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crPlane, rgbaToYCrCb, yCrCbToRgba, validateRgba } from '../src/lib/color.js';
import { embedFrame } from '../src/lib/embed.js';
import { createLayout } from '../src/lib/layout.js';
import { createCarriers } from '../src/lib/carrier.js';
import { makeFrame } from './helpers/synthetic.js';
import { mulberry32 } from './helpers/testprng.js';

test('forward conversion uses the documented YCrCb constants', () => {
  const red = new Uint8ClampedArray([255, 0, 0, 255]);
  const y = 0.299 * 255;
  assert.ok(Math.abs(crPlane(red, 1, 1)[0] - (0.713 * (255 - y) + 128)) < 1e-9);
  const { cb } = rgbaToYCrCb(red, 1, 1);
  assert.ok(Math.abs(cb[0] - (0.564 * (0 - y) + 128)) < 1e-9);
  const gray = new Uint8ClampedArray([128, 128, 128, 255]);
  const g = rgbaToYCrCb(gray, 1, 1);
  assert.ok(Math.abs(g.y[0] - 128) < 1e-9);
  assert.ok(Math.abs(g.cr[0] - 128) < 1e-9);
  assert.ok(Math.abs(g.cb[0] - 128) < 1e-9);
});

test('a zero modification reproduces every input pixel exactly', () => {
  const frame = makeFrame(64, 32, 11);
  const { y, cr, cb } = rgbaToYCrCb(frame, 64, 32);
  assert.deepEqual(yCrCbToRgba(y, cr, cb, frame, 64, 32), frame);
  const zero = new Float32Array(64 * 32);
  const out = embedFrame(frame, 64, 32, zero);
  assert.ok(out instanceof Uint8ClampedArray);
  assert.notEqual(out, frame);
  assert.deepEqual(out, frame);
  const rnd = mulberry32(3);
  const extreme = new Uint8ClampedArray(64 * 32 * 4);
  for (let i = 0; i < extreme.length; i++) extreme[i] = (i & 3) === 3 ? 200 : Math.floor(rnd() * 256);
  assert.deepEqual(embedFrame(extreme, 64, 32, zero), extreme);
});

test('validateRgba and embedFrame reject wrong sizes and types', () => {
  assert.throws(() => validateRgba(new Uint8ClampedArray(10), 2, 2), /does not match/);
  assert.throws(() => validateRgba([0, 0, 0, 0], 1, 1), /Uint8ClampedArray/);
  assert.throws(() => embedFrame(new Uint8ClampedArray(16), 2, 2, new Float32Array(3)), /plane/);
  assert.throws(() => embedFrame(new Uint8ClampedArray(15), 2, 2, new Float32Array(4)), /does not match/);
});

test('embedFrame modulates Cr only, keeps alpha, and lands near the PSNR target after rounding', async () => {
  const W = 512; const H = 512;
  const layout = await createLayout({ width: W, height: H, nonce: 'color-test', bitCount: 1024 });
  const rnd = mulberry32(9);
  const bits = new Uint8Array(1024);
  for (let i = 0; i < bits.length; i++) bits[i] = rnd() < 0.5 ? 0 : 1;
  const carriers = createCarriers(layout, bits, 42);
  const plane = carriers.planes[1];
  const frame = makeFrame(W, H, 21);
  const marked = embedFrame(frame, W, H, plane);
  assert.equal(marked.length, frame.length);
  for (let p = 3; p < frame.length; p += 4) assert.equal(marked[p], frame[p]);
  const a = rgbaToYCrCb(frame, W, H);
  const b = rgbaToYCrCb(marked, W, H);
  let maxY = 0; let sumY = 0; let maxCb = 0; let sumCb = 0;
  let sxx = 0; let syy = 0; let sxy = 0; let sqErr = 0; let sqDiff = 0;
  const n = W * H;
  for (let i = 0; i < n; i++) {
    const dy = Math.abs(b.y[i] - a.y[i]);
    const dcb = Math.abs(b.cb[i] - a.cb[i]);
    maxY = Math.max(maxY, dy); sumY += dy;
    maxCb = Math.max(maxCb, dcb); sumCb += dcb;
    const d = b.cr[i] - a.cr[i];
    sxx += d * d; syy += plane[i] * plane[i]; sxy += d * plane[i];
    sqErr += (d - plane[i]) * (d - plane[i]);
    sqDiff += d * d;
  }
  assert.ok(maxY < 1.0, `max |dY| ${maxY}`);
  assert.ok(sumY / n < 0.35, `mean |dY| ${sumY / n}`);
  assert.ok(maxCb < 1.2, `max |dCb| ${maxCb}`);
  assert.ok(sumCb / n < 0.4, `mean |dCb| ${sumCb / n}`);
  const corr = sxy / Math.sqrt(sxx * syy);
  assert.ok(corr > 0.98, `Cr difference vs carrier correlation ${corr}`);
  assert.ok(Math.sqrt(sqErr / n) < 0.6, `rms(dCr - carrier) ${Math.sqrt(sqErr / n)}`);
  const psnrCr = 10 * Math.log10((255 * 255) / (sqDiff / n));
  assert.ok(Math.abs(psnrCr - 42) < 0.7, `Cr PSNR ${psnrCr}`);
});
