# Core library test evidence: RED and GREEN record

Date: 2026-09-06. Working tree: `git_release/` only. Nothing outside it was modified (`git status` shows no modified tracked files; the only untracked entries outside this directory predate this work).

## Environment

| Component | Version |
| --- | --- |
| Node | v22.23.2 (test runner `node --test`, single thread) |
| npm | 10.9.8 |
| OS | Linux 6.17.0-23-generic |
| @noble/ed25519 | 3.2.0 (MIT) |
| @noble/hashes | 2.4.0 (MIT) |
| Python (oracle fixtures only) | 3.12.2, numpy 1.26.4, reedsolo 1.7.0, cryptography 50.0.0, CPU with `CUDA_VISIBLE_DEVICES=''` |

Oracle fixtures: `tests/fixtures/oracle.json`, produced by `tests/fixtures/make_fixtures.py`. The script copies the unbound branch of `encode_payload` and `grid_bins` verbatim from the read-only reference and never imports the reference module. It records RFC 8032 vectors recomputed with `cryptography`, framing and RS parity for 31 and 32 byte messages under a fixed seed, RS parity for random data of 6 lengths, 12 corrupted codewords with 1 to 15 errors, 4 codewords with 16 to 30 errors, and the exact `grid_bins` pools for 1024x512 (2416 bins), 512x512 (1210), and 512x256 (599).

## Method

Tests were written before the modules they import existed. Two phases, each with a recorded RED run, an implementation step, and a GREEN run. Raw runner output is kept under `.dev/logs/`. core library test files are always listed explicitly because `tests/` also received `ui-*.test.js` files from the demo application while this work was in progress (see the last section).

core library command (also `npm run test:core`):

```
node --test tests/hex.test.js tests/ed25519.test.js tests/rs.test.js tests/payload.test.js \
  tests/fft.test.js tests/carrier.test.js tests/prng.test.js tests/layout.test.js \
  tests/color.test.js tests/evidence.test.js tests/pipeline.test.js tests/negative.test.js \
  tests/spectrum.test.js tests/api.test.js
```

## Phase 1: hex, Ed25519, Reed-Solomon, framing, FFT, carrier numerics, PRNG, layout

RED (`.dev/logs/phase1_red.log`), before `src/lib/` existed:

```
# tests 8
# pass 0
# fail 8
exit=1
```

All eight files failed with `ERR_MODULE_NOT_FOUND` (24 occurrences in the log).

GREEN progression (`.dev/logs/phase1_green.log` holds the final run):

1. First run after implementation: 55 tests, 52 pass, 3 fail. Causes: the FFT and layout error messages said "powers of two" while the tests match `/power of two/`; wording changed in the implementation. The payload test used 1000 bits as an unsupported size, but 1000 bits is a legal 28-byte payload; the test now uses 1001 bits.
2. Second run: 54 pass, 1 fail. The layout test had the same 1000-bit mistake; changed to 1001.
3. Third run: `# tests 55 / # pass 55 / # fail 0`, exit 0.

One test edit was made before the first GREEN run: the carrier conjugate-symmetry check compared `im[a]` with `-im[b]` through `assert.equal`, which uses `Object.is` and treats 0 and -0 as different. It now uses `===`. The intent is unchanged.

## Phase 2: color and embedding, evidence and verification, pipeline, tamper variants, spectrum, API surface

RED (`.dev/logs/phase2_red.log`), with Phase 1 modules present but `embed.js`, `evidence.js`, `spectrum.js`, and `index.js` absent:

```
# tests 6
# pass 0
# fail 6
exit=1
```

GREEN progression (`.dev/logs/phase2_green.log` holds the first run):

1. First run: 25 tests, 23 pass, 2 fail. Causes: the smoothing test assumed that a wrong decision 15 frames from a run boundary is absorbed; the reference mode filter over a 31-frame window has a 16-to-15 majority at the boundary, so that flip moves exactly the boundary frame. The test now asserts that actual property, plus the clean and interior cases. The spectrum `max` field was computed in float64 while `magnitude` is a Float32Array (6.665943622589111 vs 6.665943474906447); the implementation now takes min and max from the stored float32 values.
2. Rerun of the two files: 9 pass, 0 fail.

## Final GREEN, all slice A files (`.dev/logs/final_green.log`)

```
# tests 80
# suites 0
# pass 80
# fail 0
# cancelled 0
# skipped 0
# todo 0
exit=0
real 0m12.281s
```

| File | Tests | What it covers |
| --- | --- | --- |
| tests/hex.test.js | 3 | hex round trip, malformed input |
| tests/ed25519.test.js | 7 | RFC 8032 TEST 1 to 3, Python oracle agreement, modified message, wrong key, tampered and malformed signatures, fresh identities, key size checks |
| tests/rs.test.js | 8 | parameters, parity equals reedsolo on 6 random lengths and the framed bodies, clean decode, 12 oracle corruptions, 200 random patterns up to 15 errors, 4 oracle plus 100 random patterns of 16 to 40 errors, size limits |
| tests/payload.test.js | 14 | 31-byte sample gives 1024 bits and 32 gives 1032, MSB-first packing, bit-exact framing vs Python, header layout, length limits without truncation, decode from recovered bytes only, wrong key, corrected channel errors, tampered message byte, inverted signature bit, flag 1 and unknown flags, wrong length header, uniform bits, unsupported lengths |
| tests/fft.test.js | 6 | 1D forward and inverse vs direct DFT, 2D vs direct DFT on 8x4, conjugate symmetry of a real image, size checks |
| tests/carrier.test.js | 6 | amplitude formula, sparse spectrum conjugate symmetry and magnitude alpha N/2, plane mean and power and 42 dB, FFT sampling recovers signs with no leakage into another group, four cached planes and sign inversion, K=30 group cycle |
| tests/prng.test.js | 4 | seed is SHA-256 of domain string and nonce, counter stream word-exact against node:crypto, float range and unbiased integers, determinism |
| tests/layout.test.js | 7 | pool equals Python grid_bins exactly for three sizes, determinism and version tag, equal contiguous disjoint in-band groups with phases in range, nonce and bit count change the layout, 2040-bit payload fits 1024x512, explicit rejections, no payload material in the layout |
| tests/color.test.js | 4 | documented constants, exact round trip with a zero plane, size checks, Cr-only modulation with PSNR near target after rounding |
| tests/evidence.test.js | 5 | reference smoothing incl. boundary property, pure-carrier group scores and signs, RGBA extraction and layout mismatch, verification from rows without any original message, wrong key and absent signal and constant fabricated rows and empty input |
| tests/pipeline.test.js | 5 | 1024x512, 120 synthetic frames: per-frame group identification, verification with recovered bytes, wrong key, unmarked frames, wrong nonce |
| tests/negative.test.js | 6 | 512x512 through pixels: sanity positive, tampered message byte, inverted signature bit, content-bound flag, corrected coded-bit inversion, inverted soft values |
| tests/spectrum.test.js | 4 | shifted log magnitude and grayscale RGBA, carrier bins and mirrors are the only peaks, residual correlates with the carrier and shows the bins, input checks |
| tests/api.test.js | 1 | exported surface, constants, `verifyEvidence` arity of 3 |

## Mandatory tests from CORE_TASK.md

1. Ed25519 RFC 8032 vectors, modified message and wrong key fail: `tests/ed25519.test.js`.
2. Framing and RS parity agree with Python reedsolo; recovery at 15 or fewer errors; more than 15 never yields the original or a false signature pass: `tests/rs.test.js`, `tests/payload.test.js`.
3. FFT forward and inverse against direct DFT; carrier conjugate symmetry, mean, power: `tests/fft.test.js`, `tests/carrier.test.js`.
4. Real RGBA embed to evidence to recovered payload and valid signature on independently generated synthetic frames; clean unmarked and wrong key reject: `tests/pipeline.test.js` (1024x512), `tests/negative.test.js` (512x512).
5. Known wrong variants (inverted payload and signature bits, constant fabricated evidence, wrong nonce): `tests/negative.test.js`, `tests/pipeline.test.js`, `tests/evidence.test.js`, `tests/payload.test.js`.
6. Deterministic layout, bounded ranges, no original message needed at verification: `tests/layout.test.js`, `tests/evidence.test.js`, `tests/api.test.js`.

## Measured values (synthetic frames in Node; unit-test evidence only, not video evidence)

Pipeline at 1024x512, 120 frames, 4 runs of 30, PSNR target 42 dB, message `DEFAULT_SAMPLE_MESSAGE` (31 bytes, 1024 bits):

- per-frame group identification from sum(Re^2)/sum(Im^2): 120 of 120 correct
- bit errors before RS: 0 of 1024; corrected symbols: 0; verified with the original message and signature bytes recovered
- wrong public key: `signature invalid`; unmarked frames: rejected; wrong nonce: rejected
- extraction of 120 frames: about 2.5 s in the test run

Reed-Solomon: 200 random patterns of 0 to 15 errors on random data of 1 to 225 bytes all corrected exactly with the exact error count reported. 100 random patterns of 16 to 40 errors never returned the original; the Python oracle raised for all four of its beyond-capacity cases and this decoder rejected them too.

Color and embedding at 42 dB on a 512x512 synthetic frame (assertion bounds that passed): max |dY| < 1.0, mean |dY| < 0.35, max |dCb| < 1.2, correlation of the Cr difference with the carrier plane > 0.98, rms(dCr - carrier) < 0.6, Cr PSNR within 0.7 dB of the target.

Timing, Node v22.23.2, one thread, 1024x512 (`.dev/logs` not kept for this ad hoc run; numbers from the console):

| Operation | Time |
| --- | --- |
| createCarriers (four planes) | 97 ms |
| embedFrame | 9.5 ms per frame |
| extractFrameEvidence | 22.3 ms per frame |
| verifyEvidence, 120 rows | 1.8 ms |
| spectrumPreview | 32.7 ms |
| evidence row size, 1024 bits | about 12.3 KB |

These are not browser measurements and say nothing about codec robustness or the paper's corpus results.

## What this record does not show

- No real video, codec round trip, frame-rate change, or geometric transform was tested. Frames are synthetic (`tests/helpers/synthetic.js`).
- No cross-verification of marked frames with the Python reference. Layout version `apcvw-js-v1` is not byte-compatible with the Python layouts by design in this slice. The Python oracle covers framing, RS parity and decoding, Ed25519 vectors, and the `grid_bins` pool exactly.
- Whitening is exercised on synthetic host content only.
