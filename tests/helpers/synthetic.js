import { mulberry32 } from './testprng.js';

/**
 * Deterministic synthetic RGBA frame for UNIT TESTS ONLY.
 * Each seed yields a different smooth color field with a few rectangles and
 * discs plus per-pixel noise. These frames are not video and carry no codec
 * behavior. Nothing measured on them is evidence about real footage.
 * @param {number} width
 * @param {number} height
 * @param {number} seed
 * @param {{noise?: number}} [opts]
 * @returns {Uint8ClampedArray} RGBA, length width*height*4
 */
export function makeFrame(width, height, seed, opts = {}) {
  const noise = opts.noise ?? 6;
  const rnd = mulberry32(seed);
  const col = () => [40 + rnd() * 175, 40 + rnd() * 175, 40 + rnd() * 175];
  const c0 = col();
  const c1 = col();
  const c2 = col();
  const rects = [];
  for (let i = 0; i < 3; i++) {
    const x0 = Math.floor(rnd() * width * 0.8);
    const y0 = Math.floor(rnd() * height * 0.8);
    rects.push({ x0, y0, x1: x0 + Math.floor(20 + rnd() * width * 0.3), y1: y0 + Math.floor(20 + rnd() * height * 0.3), c: col() });
  }
  const discs = [];
  for (let i = 0; i < 2; i++) {
    discs.push({ cx: rnd() * width, cy: rnd() * height, r: 10 + rnd() * Math.min(width, height) * 0.2, c: col() });
  }
  const out = new Uint8ClampedArray(width * height * 4);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const u = y / height;
    for (let x = 0; x < width; x++) {
      const t = x / width;
      let r = (c0[0] * (1 - t) + c1[0] * t) * (1 - u) + c2[0] * u;
      let g = (c0[1] * (1 - t) + c1[1] * t) * (1 - u) + c2[1] * u;
      let b = (c0[2] * (1 - t) + c1[2] * t) * (1 - u) + c2[2] * u;
      for (const q of rects) {
        if (x >= q.x0 && x < q.x1 && y >= q.y0 && y < q.y1) { r = q.c[0]; g = q.c[1]; b = q.c[2]; }
      }
      for (const d of discs) {
        const dx = x - d.cx; const dy = y - d.cy;
        if (dx * dx + dy * dy < d.r * d.r) { r = d.c[0]; g = d.c[1]; b = d.c[2]; }
      }
      out[p] = Math.round(r + (rnd() - 0.5) * 2 * noise);
      out[p + 1] = Math.round(g + (rnd() - 0.5) * 2 * noise);
      out[p + 2] = Math.round(b + (rnd() - 0.5) * 2 * noise);
      out[p + 3] = 255;
      p += 4;
    }
  }
  return out;
}
