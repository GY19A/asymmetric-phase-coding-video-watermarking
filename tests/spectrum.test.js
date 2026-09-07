import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spectrumPreview, residualPlane } from '../src/lib/spectrum.js';
import { createLayout } from '../src/lib/layout.js';
import { createCarriers } from '../src/lib/carrier.js';
import { embedFrame } from '../src/lib/embed.js';
import { makeFrame } from './helpers/synthetic.js';
import { mulberry32 } from './helpers/testprng.js';

test('spectrumPreview returns a shifted log-magnitude plane and grayscale RGBA for an RGBA frame', () => {
  const W = 256; const H = 128;
  const frame = makeFrame(W, H, 8);
  const s = spectrumPreview(frame, W, H);
  assert.equal(s.width, W);
  assert.equal(s.height, H);
  assert.equal(s.shifted, true);
  assert.ok(s.magnitude instanceof Float32Array);
  assert.equal(s.magnitude.length, W * H);
  assert.ok(s.rgba instanceof Uint8ClampedArray);
  assert.equal(s.rgba.length, W * H * 4);
  let maxIdx = 0;
  for (let i = 1; i < s.magnitude.length; i++) if (s.magnitude[i] > s.magnitude[maxIdx]) maxIdx = i;
  assert.equal(maxIdx, (H / 2) * W + W / 2, 'DC lands at the center after the shift');
  assert.equal(s.max, s.magnitude[maxIdx]);
  for (let p = 0; p < s.rgba.length; p += 4) {
    assert.equal(s.rgba[p], s.rgba[p + 1]);
    assert.equal(s.rgba[p], s.rgba[p + 2]);
    assert.equal(s.rgba[p + 3], 255);
  }
  assert.equal(s.rgba[maxIdx * 4], 255);
  const unshifted = spectrumPreview(frame, W, H, { shift: false });
  assert.equal(unshifted.shifted, false);
  assert.equal(unshifted.magnitude[0], s.magnitude[maxIdx]);
});

test('spectrum of a carrier plane peaks exactly at the layout bins and their mirrors', async () => {
  const W = 512; const H = 512;
  const layout = await createLayout({ width: W, height: H, nonce: 'spectrum-test', bitCount: 1024 });
  const rnd = mulberry32(5);
  const bits = new Uint8Array(1024);
  for (let i = 0; i < bits.length; i++) bits[i] = rnd() < 0.5 ? 0 : 1;
  const carriers = createCarriers(layout, bits, 42);
  const s = spectrumPreview(carriers.planes[2], W, H);
  const hot = new Set();
  const g = layout.groups[2];
  for (let j = 0; j < g.ky.length; j++) {
    const ky = g.ky[j]; const kx = ((g.kx[j] % W) + W) % W;
    const a = ((ky + H / 2) % H) * W + ((kx + W / 2) % W);
    const b = (((H - ky) % H + H / 2) % H) * W + (((W - kx) % W + W / 2) % W);
    assert.ok(s.magnitude[a] > 4, `bin ${j} magnitude ${s.magnitude[a]}`);
    assert.ok(s.magnitude[b] > 4, `mirror ${j} magnitude ${s.magnitude[b]}`);
    hot.add(a); hot.add(b);
  }
  assert.equal(hot.size, 512);
  let checked = 0;
  for (let i = 0; i < W * H && checked < 2000; i += 131) {
    if (hot.has(i)) continue;
    assert.ok(s.magnitude[i] < 0.01, `non-bin ${i} magnitude ${s.magnitude[i]}`);
    checked++;
  }
});

test('residualPlane is the Cr difference and its spectrum exposes the carrier', async () => {
  const W = 512; const H = 512;
  const layout = await createLayout({ width: W, height: H, nonce: 'residual-test', bitCount: 1024 });
  const bits = new Uint8Array(1024).fill(1);
  const carriers = createCarriers(layout, bits, 42);
  const src = makeFrame(W, H, 33);
  const marked = embedFrame(src, W, H, carriers.planes[0]);
  const res = residualPlane(marked, src, W, H);
  assert.ok(res instanceof Float64Array);
  assert.equal(res.length, W * H);
  let sxx = 0; let syy = 0; let sxy = 0;
  for (let i = 0; i < res.length; i++) {
    sxx += res[i] * res[i]; syy += carriers.planes[0][i] * carriers.planes[0][i]; sxy += res[i] * carriers.planes[0][i];
  }
  assert.ok(sxy / Math.sqrt(sxx * syy) > 0.98);
  const s = spectrumPreview(res, W, H);
  const g = layout.groups[0];
  for (let j = 0; j < g.ky.length; j++) {
    const idx = ((g.ky[j] + H / 2) % H) * W + ((((g.kx[j] % W) + W) % W + W / 2) % W);
    assert.ok(s.magnitude[idx] > 3.8, `bin ${j} magnitude ${s.magnitude[idx]}`);
  }
});

test('spectrumPreview rejects unsupported input', () => {
  assert.throws(() => spectrumPreview(new Float32Array(10), 5, 2), /power of two/);
  assert.throws(() => spectrumPreview(new Float32Array(10), 4, 4), /length/);
  assert.throws(() => spectrumPreview([1, 2, 3, 4], 2, 2), /source/);
  assert.throws(() => spectrumPreview(new Uint8ClampedArray(15), 2, 2), /does not match/);
});
