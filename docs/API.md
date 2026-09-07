# apcvw-js core API

Package `apcvw-js` 0.1.0, ES modules, entry `src/lib/index.js`. Pure JavaScript with JSDoc types. This document covers the core library only; the demo application, worker, and video I/O live under `src/app/`, `src/worker.js`, and `src/media.js`. Everything runs in the browser or in Node 22 without `crypto.subtle`.

Runtime dependencies (pinned exactly in `package.json`):

| Package | Version | License | Use |
| --- | --- | --- | --- |
| @noble/ed25519 | 3.2.0 | MIT | Ed25519 key derivation, signing, verification |
| @noble/hashes | 2.4.0 | MIT | SHA-512 for Ed25519 (synchronous), SHA-256 for the layout PRNG |

The Reed-Solomon codec (`src/lib/rs.js`) and the FFT (`src/lib/fft.js`) are in-tree reference ports with oracle tests. There is no other dependency.

## What the core library is and is not

- It implements the paper's core signature transport: Ed25519 payload with RS(30), Cr chroma phase carrier in the 0.05 to 0.12 band, G = 4 run-length groups of K = 30 frames, payload-free group identification, local spectral whitening, hard decision, RS decode, signature check.
- Identity geometry only. There is no scale, rotation, or translation search. Frames must be presented at the canonical size they were marked at.
- Layout version `apcvw-js-v1` uses a SHA-256 counter PRNG. It is NOT byte-compatible with the Python reference layouts (numpy PCG64 seeded from `apvw-layout-v1`). A video marked with this library cannot be verified by `apvw.py` and a video marked by `apvw.py` cannot be verified by this library. Framing, RS parity, and signatures are byte-identical to the reference and are tested against Python oracles.
- The four groups draw disjoint bins, as the paper states. The Python reference samples each group independently from the full pool and may overlap. This is a documented difference, not a bug in either.
- Content binding (payload flag 1) is not implemented and is rejected explicitly.
- Nothing has been measured on real video or through a codec. Numbers in `docs/TEST_EVIDENCE.md` come from synthetic frames in Node and are unit-test evidence only. This runtime does not inherit any corpus benchmark from the paper.

## Data types

```ts
type Layout = {
  version: 'apcvw-js-v1';
  width: number; height: number;      // powers of two, 64..8192
  nonce: string;                      // public per-video nonce
  bitCount: number;                   // coded payload bits, = payloadBitCount(messageByteLength)
  groupCount: 4; runLength: 30;
  band: [0.05, 0.12];
  poolSize: number;                   // bins in the band for this frame size
  groups: LayoutGroup[];              // length 4
};
type LayoutGroup = {
  ky: Int32Array;      // 1 <= ky < height/2
  kx: Int32Array;      // -width/2 < kx < width/2 (negative values allowed)
  phases: Float64Array;// [0, 2pi)
  bits: Uint32Array;   // payload bit index per bin; group g covers [g*B/4, (g+1)*B/4)
  bitStart: number; bitEnd: number;
};
type Carriers = { version: 'apcvw-js-v1'; psnrTarget: number; alpha: number; width: number; height: number; planes: Float32Array[] /* 4 planes, width*height each */ };
type EvidenceRow = {
  version: 'apcvw-js-v1';
  scores: Float64Array;   // per group: sum(Re^2) / max(sum(Im^2), 1e-30)
  groups: { re: Float32Array; im: Float32Array; weights: Float32Array }[]; // per group, one entry per bin
};
type VerifyResult = {
  verified: boolean;
  reason: string;                  // 'ok' or a rejection reason (list below)
  message: string | null;          // UTF-8 decode of messageBytes, only when verified
  messageBytes: Uint8Array | null; // only when verified
  signature: Uint8Array | null;    // 64 bytes, only when verified
  correctedSymbols: number | null; // RS symbols corrected; null when RS decoding failed
  extractedBits: Uint8Array;       // hard decisions, length layout.bitCount
  groupCounts: number[];           // frames assigned to each group after smoothing
  frameCount: number;
  softSums: Float64Array;          // accumulated whitened soft values per bit (diagnostic only)
};
```

Bits are `Uint8Array` values 0/1, most significant bit of each byte first.

## Identity

`async generateIdentity(): Promise<{ privateKey: Uint8Array, publicKey: Uint8Array }>`
Random 32-byte RFC 8032 seed from `crypto.getRandomValues`, public key derived with @noble/ed25519. No storage, no network, no fixed key. Throws if `getRandomValues` is missing.

`publicKeyFromPrivate(privateKey: Uint8Array(32)): Uint8Array(32)`
`signMessage(messageBytes: Uint8Array, privateKey: Uint8Array(32)): Uint8Array(64)`
`verifySignature(signature: Uint8Array, messageBytes: Uint8Array, publicKey: Uint8Array(32)): boolean`
Verification returns `false` for any malformed or invalid signature and never throws for signature content. Wrong key length or non-Uint8Array message throws `TypeError`. Verification uses the library default `zip215: true`.

## Payload

`async createPayload(message: string, privateKey: Uint8Array(32)): Promise<{ bits, signature, messageBytes, codedBytes, bitCount }>`
Framing is exactly the reference unbound branch:

```
body  = 0x00 || len(message) as 2-byte big-endian || message (UTF-8) || Ed25519 signature (64 bytes)
coded = body || RS(30) parity          (GF(2^8), prim 0x11d, generator 2, fcr 0, single codeword)
bits  = coded, MSB first
```

31 message bytes give 1024 bits, 32 give 1032. The message must be 1 to 158 UTF-8 bytes (`MAX_MESSAGE_BYTES`), which is the largest single RS codeword. Longer or empty messages throw `RangeError`; nothing is truncated. Non-string input throws `TypeError`.

`DEFAULT_SAMPLE_MESSAGE` is `'APCVW browser demo, signed 2026'`, 31 ASCII bytes. Tests measure the length.

`payloadBitCount(messageByteLength: number): number` = `(1 + 2 + n + 64 + 30) * 8`. Throws for n outside 1..158.
`messageLengthFromBitCount(bitCount: number): number` inverse; throws for unsupported sizes.
`bytesToBits(bytes: Uint8Array): Uint8Array`, `bitsToBytes(bits: ArrayLike<number>): Uint8Array` (length must be a multiple of 8; nonzero counts as 1).

`decodePayloadBits(bits: Uint8Array, publicKey: Uint8Array(32)): { verified, reason, message, messageBytes, signature, correctedSymbols }`
Pure decode step used by `verifyEvidence`. It takes only bits and the public key. Steps: RS decode, flag check, length check, Ed25519 verification over the recovered bytes. Throws only for programming errors (bit count not a supported payload size, malformed key). Rejection reasons:

| reason | meaning |
| --- | --- |
| `RS decode failed (<detail>)` | more than 15 symbol errors or inconsistent correction |
| `payload truncated` | fewer than 3 decoded bytes (cannot happen for supported sizes) |
| `content-bound payload not supported` | flag byte 1 |
| `bad flag byte (<n>)` | flag byte not 0 or 1 |
| `bad length header (<n>)` | length field is 0, does not equal the layout's message length, or does not fill the body exactly |
| `signature invalid` | Ed25519 check failed under the given public key |

`RS_PARITY` = 30. `ReedSolomonError` is exported for callers of the low-level codec.

## Layout

`async createLayout({ width, height, nonce, bitCount }): Promise<Layout>`
Deterministic and public. Algorithm (version `apcvw-js-v1`):

1. Validate: `width` and `height` integers, each a power of two in [64, 8192]; `nonce` a non-empty string; `bitCount` a supported payload size (`messageLengthFromBitCount` must succeed).
2. `pool = gridBins(width, height)`: ky in [1, H/2), kx in (-W/2, W/2), kept when `sqrt((ky/(H/2))^2 + (kx/(W/2))^2)` is in [0.05, 0.12). Same order and values as the reference `grid_bins` (tested against Python for 1024x512, 512x512, 512x256).
3. Require `4 * bitCount/4 <= poolSize`; otherwise throw `RangeError` naming the pool size. For 1024x512 the pool has 2416 bins, enough for the largest supported payload (2040 bits). 512x512 has 1210 bins (fits 1024 bits). 512x256 has 599 and is rejected for 1024 bits.
4. PRNG: `seed = SHA-256("apcvw-js-v1|layout|" || nonce)`, blocks `SHA-256(seed || BE32(i))`, words consumed as big-endian uint32. `nextBelow(n)` is masked rejection sampling; `nextFloat()` is `((a>>>5)*2^26 + (b>>>6)) / 2^53`.
5. One partial Fisher-Yates shuffle draws `bitCount` distinct pool indices; group g takes indices `[g*per, (g+1)*per)` with `per = bitCount/4`. Then for each group in order, `per` phases `nextFloat() * 2pi`.
6. Group g carries payload bits `[g*per, (g+1)*per)`.

`gridBins(width, height, lo = 0.05, hi = 0.12): { ky: Int32Array, kx: Int32Array }`
`assertLayoutMatches(layout, width, height)` throws when a layout was built for another size or is not version `apcvw-js-v1`.
Constants: `GROUPS = 4`, `RUN_LENGTH = 30`, `BAND = [0.05, 0.12]`, `MIN_DIMENSION = 64`, `MAX_DIMENSION = 8192`, `LAYOUT_VERSION = 'apcvw-js-v1'`.

Public decoding metadata to ship with a marked video: `{ version: 'apcvw-js-v1', nonce, width, height, messageByteLength }` plus the 32-byte public key. Nothing else is needed to verify.

## Carriers and embedding

`createCarriers(layout: Layout, bits: Uint8Array, psnrTarget: number): Carriers`
Builds the four group planes once. For group g: `F[ky, kx mod W] += s * alpha * N/2 * exp(i*phase)` and the conjugate at `[(-ky) mod H, (-kx) mod W]`, `s = 2*bit - 1`, `N = W*H`; plane = `Re(ifft2(F))` stored as `Float32Array`. `alpha = carrierAlpha(psnrTarget, per) = sqrt(2 * 255^2 / (10^(psnr/10) * per))`, so the plane power is `per * alpha^2 / 2` and the Cr PSNR equals the target before rounding. Cache the result per strength and reuse it for every frame. Throws when `bits.length !== layout.bitCount` or the target is not a positive finite number.

`carrierAlpha(psnrTarget: number, bitsPerGroup: number): number`

`groupForFrame(frameIndex: number, layout: Layout): number` = `floor(frameIndex / 30) mod 4`. Embed side only. The verifier never calls it.

`embedFrame(rgba: Uint8ClampedArray, width, height, plane: Float32Array): Uint8ClampedArray`
Returns a new RGBA array; the input is untouched. Per pixel:

```
Y  = 0.299 R + 0.587 G + 0.114 B
Cr = 0.713 (R - Y) + 128           Cb = 0.564 (B - Y) + 128     (OpenCV's documented constants, float64)
Cr' = clamp(Cr + plane[i], 0, 255)
R' = Y + (Cr' - 128) / 0.713       B' = Y + (Cb - 128) / 0.564   G' = (Y - 0.299 R' - 0.114 B') / 0.587
output = Math.round(channel) clamped to [0, 255]; alpha copied
```

The inverse is the exact algebraic inverse, so a zero plane reproduces the input byte for byte. Y and Cb change only through the final RGB rounding. Rounding each channel by at most 0.5 bounds |dY| by 0.5 and |dCb| by 0.57; the tests assert |dY| < 1.0 and |dCb| < 1.2 on a synthetic frame. The reference quantizes YCrCb to uint8 before adding the carrier; this library keeps float until the final RGB rounding. Throws for wrong array types or lengths.

## Evidence and verification

`extractFrameEvidence(rgba: Uint8ClampedArray, width, height, layout: Layout): EvidenceRow`
`evidenceFromPlane(plane: Float64Array | Float32Array, width, height, layout: Layout): EvidenceRow`
FFT of the Cr plane (or the given plane). For every bin of every group: `C = F[ky, kx] * exp(-i*phase)`; `re = Re C`, `im = Im C`. This equals the reference `correlate` at identity geometry. `scores[g] = sum(re^2) / max(sum(im^2), 1e-30)`. Whitening follows `local_host_energy`: `hE = sqrt(mean |F|^2)` over the 7x7 spectral neighborhood minus the 3x3 center (40 bins, wrap-around), `weights = 1 / max(hE / median(hE), 1e-6)` with the median taken per group. The soft value of a bin is `re * weight`. Rows store `Float32Array` values; a 1024-bit row is about 12 KB.

`async verifyEvidence(evidenceRows: EvidenceRow[], layout: Layout, publicKey: Uint8Array(32)): Promise<VerifyResult>`
Takes rows, layout, and public key and nothing else. It never receives an expected message, payload, or signature. Steps:

1. Per row, `picked = argmax(scores)` (ties to the lowest index). The received frame index is never used.
2. `smoothGroups(picked, 30)`: mode over the window [i-15, i+15], ties to the lowest group.
3. For each row, add `re * weight` of the smoothed group into `softSums[group.bits[j]]`.
4. `extractedBits = softSums > 0`.
5. `decodePayloadBits(extractedBits, publicKey)`.

Empty input returns `reason: 'no evidence rows'`. Rows that do not match the layout throw `RangeError`. Uniform or absent signal produces all-zero bits and is rejected with `bad length header (0)`. Constant fabricated evidence is rejected because it does not form a valid signed codeword. `message`, `messageBytes`, and `signature` are `null` unless `verified` is true.

`smoothGroups(picked: ArrayLike<number>, runLength: number): number[]`
Reference behavior, including its boundary property: one wrong decision within 15 frames of a run boundary moves that boundary frame to the wrong group. That frame's soft values then add as noise to the wrong bits; it does not by itself break decoding.

## Visualization

`spectrumPreview(source, width, height, { shift = true } = {}): { width, height, shifted, magnitude: Float32Array, rgba: Uint8ClampedArray, min, max }`
`source` is either an RGBA frame (Cr plane is taken) or a `Float32Array`/`Float64Array` plane such as a carrier plane or a residual. `magnitude = log10(1 + |FFT|)`, DC at `(height/2, width/2)` when shifted. `rgba` maps `[min, max]` to gray 0..255 with alpha 255. It is a plot of the computed spectrum, not evidence.

`residualPlane(markedRgba, sourceRgba, width, height): Float64Array` = `Cr(marked) - Cr(source)`.
`crPlane(rgba, width, height): Float64Array`, `rgbaToYCrCb(rgba, width, height): { y, cr, cb }`, `yCrCbToRgba(y, cr, cb, alphaSource, width, height): Uint8ClampedArray`.

## Helpers

`toHex(bytes: Uint8Array): string` lowercase. `fromHex(hex: string): Uint8Array`, either case, throws on odd length or non-hex characters.
`fft(re, im, inverse = false)`, `fft2d(re, im, width, height, inverse = false)` in place on `Float64Array`, power-of-two sizes only. `isPowerOfTwo(n)`.
`LIBRARY_VERSION = '0.1.0'`.

## Minimal usage

```js
import * as apcvw from './src/lib/index.js';

// Sign side
const { privateKey, publicKey } = await apcvw.generateIdentity();
const payload = await apcvw.createPayload(apcvw.DEFAULT_SAMPLE_MESSAGE, privateKey);
const layout = await apcvw.createLayout({ width: 1024, height: 512, nonce: 'video-2026-09-06-001', bitCount: payload.bitCount });
const carriers = apcvw.createCarriers(layout, payload.bits, 42);   // once per strength
for (let t = 0; t < frames.length; t++) {
  const plane = carriers.planes[apcvw.groupForFrame(t, layout)];
  markedFrames[t] = apcvw.embedFrame(frames[t], 1024, 512, plane);
}

// Verify side: needs only the public key and the public metadata
const layout2 = await apcvw.createLayout({ width: 1024, height: 512, nonce: 'video-2026-09-06-001', bitCount: apcvw.payloadBitCount(31) });
const rows = receivedFrames.map((f) => apcvw.extractFrameEvidence(f, 1024, 512, layout2));
const result = await apcvw.verifyEvidence(rows, layout2, publicKey);
// result.verified, result.reason, result.message
```

## Known limitations

- Identity geometry only; any resize, crop, rotation, or shift between marking and verification is out of scope for this version.
- Not compatible with Python `apvw.py` layouts (see above). Cross-implementation verification of video is future work and requires either a PCG64 port or a reference-side option for the `apcvw-js-v1` PRNG.
- Only power-of-two frame sizes from 64 to 8192 on each side; canonical size 1024x512. The UI must resample decoded video frames to the canonical size and back.
- One RS codeword: message 1 to 158 UTF-8 bytes.
- `verifyEvidence` needs all four groups to be present; a clip shorter than 120 frames cannot verify, and the K = 30 smoothing assumes runs of about 30 frames at the received frame rate.
- Evidence rows are kept in memory by the caller. About 12 KB per frame for 1024-bit payloads.
- Whitening weights are computed for every group on every frame. Only the smoothed group's weights are used.
- Performance figures in `docs/TEST_EVIDENCE.md` are Node 22 measurements on synthetic frames, not browser or video measurements.
