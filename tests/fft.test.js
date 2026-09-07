import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft, fft2d, isPowerOfTwo } from '../src/lib/fft.js';
import { mulberry32 } from './helpers/testprng.js';

function directDft(re, im, inverse) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < n; k++) {
    let sr = 0; let si = 0;
    for (let t = 0; t < n; t++) {
      const ang = (sign * 2 * Math.PI * k * t) / n;
      sr += re[t] * Math.cos(ang) - im[t] * Math.sin(ang);
      si += re[t] * Math.sin(ang) + im[t] * Math.cos(ang);
    }
    outRe[k] = inverse ? sr / n : sr;
    outIm[k] = inverse ? si / n : si;
  }
  return { re: outRe, im: outIm };
}

function directDft2d(re, im, width, height) {
  const outRe = new Float64Array(width * height);
  const outIm = new Float64Array(width * height);
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      let sr = 0; let si = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const ang = -2 * Math.PI * ((v * y) / height + (u * x) / width);
          const i = y * width + x;
          sr += re[i] * Math.cos(ang) - im[i] * Math.sin(ang);
          si += re[i] * Math.sin(ang) + im[i] * Math.cos(ang);
        }
      }
      outRe[v * width + u] = sr;
      outIm[v * width + u] = si;
    }
  }
  return { re: outRe, im: outIm };
}

function randomComplex(n, rnd) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) { re[i] = rnd() * 2 - 1; im[i] = rnd() * 2 - 1; }
  return { re, im };
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

test('isPowerOfTwo', () => {
  assert.equal(isPowerOfTwo(1), true);
  assert.equal(isPowerOfTwo(1024), true);
  assert.equal(isPowerOfTwo(0), false);
  assert.equal(isPowerOfTwo(1000), false);
  assert.equal(isPowerOfTwo(-8), false);
});

test('1D forward FFT matches a direct DFT', () => {
  const rnd = mulberry32(1);
  for (const n of [1, 2, 4, 8, 16, 64, 256]) {
    const { re, im } = randomComplex(n, rnd);
    const want = directDft(re, im, false);
    const gotRe = Float64Array.from(re);
    const gotIm = Float64Array.from(im);
    fft(gotRe, gotIm, false);
    assert.ok(maxAbsDiff(gotRe, want.re) < 1e-9 * n, `n=${n}`);
    assert.ok(maxAbsDiff(gotIm, want.im) < 1e-9 * n, `n=${n}`);
  }
});

test('1D inverse FFT matches a direct inverse DFT and round-trips', () => {
  const rnd = mulberry32(2);
  for (const n of [2, 8, 32, 128]) {
    const { re, im } = randomComplex(n, rnd);
    const want = directDft(re, im, true);
    const gotRe = Float64Array.from(re);
    const gotIm = Float64Array.from(im);
    fft(gotRe, gotIm, true);
    assert.ok(maxAbsDiff(gotRe, want.re) < 1e-12, `n=${n}`);
    assert.ok(maxAbsDiff(gotIm, want.im) < 1e-12, `n=${n}`);
    fft(gotRe, gotIm, false);
    assert.ok(maxAbsDiff(gotRe, re) < 1e-12);
    assert.ok(maxAbsDiff(gotIm, im) < 1e-12);
  }
});

test('2D FFT matches a direct 2D DFT on a non-square grid', () => {
  const rnd = mulberry32(3);
  const width = 8; const height = 4;
  const { re, im } = randomComplex(width * height, rnd);
  const want = directDft2d(re, im, width, height);
  const gotRe = Float64Array.from(re);
  const gotIm = Float64Array.from(im);
  fft2d(gotRe, gotIm, width, height, false);
  assert.ok(maxAbsDiff(gotRe, want.re) < 1e-10);
  assert.ok(maxAbsDiff(gotIm, want.im) < 1e-10);
  fft2d(gotRe, gotIm, width, height, true);
  assert.ok(maxAbsDiff(gotRe, re) < 1e-12);
  assert.ok(maxAbsDiff(gotIm, im) < 1e-12);
});

test('2D FFT of a real image is conjugate symmetric', () => {
  const rnd = mulberry32(4);
  const width = 16; const height = 8;
  const re = new Float64Array(width * height);
  for (let i = 0; i < re.length; i++) re[i] = rnd() * 255;
  const im = new Float64Array(width * height);
  fft2d(re, im, width, height, false);
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const a = v * width + u;
      const b = ((height - v) % height) * width + ((width - u) % width);
      assert.ok(Math.abs(re[a] - re[b]) < 1e-9);
      assert.ok(Math.abs(im[a] + im[b]) < 1e-9);
    }
  }
});

test('non power-of-two sizes are rejected', () => {
  assert.throws(() => fft(new Float64Array(6), new Float64Array(6), false), /power of two/);
  assert.throws(() => fft2d(new Float64Array(24), new Float64Array(24), 6, 4, false), /power of two/);
  assert.throws(() => fft(new Float64Array(8), new Float64Array(4), false), /length/);
});
