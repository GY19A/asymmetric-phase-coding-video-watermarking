/**
 * Small deterministic PRNG for TEST DATA ONLY (error positions, synthetic pixels).
 * Never used by the library. Not cryptographic.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Distinct integer positions in [0, n) chosen with the test PRNG. */
export function distinctPositions(rnd, n, count) {
  const chosen = new Set();
  while (chosen.size < count) chosen.add(Math.floor(rnd() * n));
  return [...chosen];
}
