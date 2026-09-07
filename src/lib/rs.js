/**
 * Reed-Solomon codec over GF(2^8), parameter-compatible with the Python
 * `reedsolo` RSCodec(30) defaults used by the reference implementation:
 * primitive polynomial 0x11d, generator alpha = 2, first consecutive root 0,
 * codeword size 255, systematic encoding (data followed by parity).
 *
 * This is a reference port, not a dependency. It is tested against oracle
 * codewords produced by reedsolo (tests/fixtures/oracle.json). Decoding uses
 * syndromes, Berlekamp-Massey, Chien search, and the Forney algorithm, and
 * re-checks the syndromes after correction. With 30 parity symbols it
 * corrects at most 15 symbol errors. Beyond that it throws or returns a
 * different codeword; the signature check downstream rejects the latter.
 * @module rs
 */

export const RS_PARITY = 30;
export const RS_NSIZE = 255;
export const RS_MAX_DATA = RS_NSIZE - RS_PARITY;

const PRIM = 0x11d;
const GENERATOR = 2;
const FCR = 0;

export class ReedSolomonError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReedSolomonError';
  }
}

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIM;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function gfDiv(a, b) {
  if (b === 0) throw new ReedSolomonError('division by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

function gfInv(a) {
  if (a === 0) throw new ReedSolomonError('inverse of zero');
  return EXP[255 - LOG[a]];
}

function gfPow(a, p) {
  const e = (((LOG[a] * p) % 255) + 255) % 255;
  return EXP[e];
}

/** Polynomial product, coefficients stored highest degree first. */
function polyMul(p, q) {
  const r = new Uint8Array(p.length + q.length - 1);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === 0) continue;
    for (let j = 0; j < q.length; j++) r[i + j] ^= gfMul(p[i], q[j]);
  }
  return r;
}

const generatorCache = new Map();
function generatorPoly(nsym) {
  let g = generatorCache.get(nsym);
  if (g) return g;
  g = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) g = polyMul(g, new Uint8Array([1, gfPow(GENERATOR, i + FCR)]));
  generatorCache.set(nsym, g);
  return g;
}

/**
 * Systematic RS encode: returns data followed by `nsym` parity bytes.
 * @param {Uint8Array} data 1 to 225 bytes for nsym = 30
 * @param {number} [nsym]
 * @returns {Uint8Array}
 */
export function rsEncode(data, nsym = RS_PARITY) {
  if (!(data instanceof Uint8Array)) throw new TypeError('rsEncode expects a Uint8Array');
  if (data.length < 1) throw new RangeError('rsEncode: data length must be at least 1 byte');
  if (data.length + nsym > RS_NSIZE) {
    throw new RangeError(`rsEncode: data length must be at most ${RS_NSIZE - nsym} bytes for a single codeword`);
  }
  const gen = generatorPoly(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) out[i + j] ^= gfMul(gen[j], coef);
  }
  out.set(data);
  return out;
}

function syndromes(msg, nsym) {
  const s = new Uint8Array(nsym);
  for (let j = 0; j < nsym; j++) {
    const x = gfPow(GENERATOR, j + FCR);
    let y = msg[0];
    for (let k = 1; k < msg.length; k++) y = gfMul(y, x) ^ msg[k];
    s[j] = y;
  }
  return s;
}

function allZero(a) {
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) return false;
  return true;
}

/** Berlekamp-Massey. Returns the error locator, lowest degree first, Lambda[0] = 1. */
function berlekampMassey(S, N) {
  let C = new Uint8Array(N + 1);
  let B = new Uint8Array(N + 1);
  C[0] = 1;
  B[0] = 1;
  let L = 0;
  let m = 1;
  let b = 1;
  for (let n = 0; n < N; n++) {
    let d = S[n];
    for (let i = 1; i <= L; i++) d ^= gfMul(C[i], S[n - i]);
    if (d === 0) {
      m++;
      continue;
    }
    const coef = gfDiv(d, b);
    const T = Uint8Array.from(C);
    for (let i = 0; i + m <= N; i++) {
      if (B[i] !== 0) C[i + m] ^= gfMul(coef, B[i]);
    }
    if (2 * L <= n) {
      L = n + 1 - L;
      B = T;
      b = d;
      m = 1;
    } else {
      m++;
    }
  }
  return C.slice(0, L + 1);
}

/** Chien search: storage indices k whose locator X_k = alpha^(n-1-k) satisfies Lambda(1/X_k) = 0. */
function chienSearch(lambda, n) {
  const positions = [];
  for (let k = 0; k < n; k++) {
    const xinv = gfPow(GENERATOR, -(n - 1 - k));
    let y = 0;
    let xp = 1;
    for (let i = 0; i < lambda.length; i++) {
      y ^= gfMul(lambda[i], xp);
      xp = gfMul(xp, xinv);
    }
    if (y === 0) positions.push(k);
  }
  return positions;
}

/** Forney: e_k = Omega(1/X_k) / prod_{j != k} (1 + X_j / X_k), with Omega = S * Lambda mod x^nsym (fcr = 0). */
function forneyCorrect(msg, S, lambda, positions, n) {
  const nsym = S.length;
  const omega = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) {
    if (S[i] === 0) continue;
    for (let j = 0; j < lambda.length && i + j < nsym; j++) omega[i + j] ^= gfMul(S[i], lambda[j]);
  }
  const X = positions.map((k) => gfPow(GENERATOR, n - 1 - k));
  for (let i = 0; i < X.length; i++) {
    const xinv = gfInv(X[i]);
    let num = 0;
    let xp = 1;
    for (let j = 0; j < nsym; j++) {
      num ^= gfMul(omega[j], xp);
      xp = gfMul(xp, xinv);
    }
    let den = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) den = gfMul(den, 1 ^ gfMul(X[j], xinv));
    }
    if (den === 0) throw new ReedSolomonError('could not find error magnitude');
    msg[positions[i]] ^= gfDiv(num, den);
  }
}

/**
 * Decode a single RS codeword. Throws ReedSolomonError when the errors exceed
 * the correction capacity or the corrected word is inconsistent.
 * @param {Uint8Array} codeword data plus parity, 31 to 255 bytes for nsym = 30
 * @param {number} [nsym]
 * @returns {{data: Uint8Array, corrected: number, positions: number[]}}
 */
export function rsDecode(codeword, nsym = RS_PARITY) {
  if (!(codeword instanceof Uint8Array)) throw new TypeError('rsDecode expects a Uint8Array');
  const n = codeword.length;
  if (n <= nsym) throw new RangeError(`rsDecode: codeword length must exceed the ${nsym} parity bytes`);
  if (n > RS_NSIZE) throw new RangeError(`rsDecode: codeword length must be at most ${RS_NSIZE}`);
  const msg = Uint8Array.from(codeword);
  const synd = syndromes(msg, nsym);
  if (allZero(synd)) return { data: msg.slice(0, n - nsym), corrected: 0, positions: [] };
  const lambda = berlekampMassey(synd, nsym);
  const L = lambda.length - 1;
  if (L * 2 > nsym) throw new ReedSolomonError(`too many errors to correct (locator degree ${L})`);
  const positions = chienSearch(lambda, n);
  if (positions.length !== L) {
    throw new ReedSolomonError(`could not locate errors (Chien search found ${positions.length}, locator degree ${L})`);
  }
  forneyCorrect(msg, synd, lambda, positions, n);
  if (!allZero(syndromes(msg, nsym))) throw new ReedSolomonError('could not correct message (syndromes remain)');
  return { data: msg.slice(0, n - nsym), corrected: positions.length, positions };
}
