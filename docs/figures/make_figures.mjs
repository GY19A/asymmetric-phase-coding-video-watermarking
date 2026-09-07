// Generates the README figures from a real run of the library in Node (no browser, no UI).
// Every figure is computed from actual data produced by this script: the Sintel excerpt is
// decoded with ffmpeg, marked with the library, re-encoded with ffmpeg (H.264 and VP9),
// decoded again, and verified with the public key alone. Outputs go to docs/img/ as raw
// binary dumps plus a JSON record; plot_figures.py turns them into PNGs.
//
//   node docs/figures/make_figures.mjs
//
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as apcvw from "../../src/lib/index.js";

const W = 1024, H = 512, FRAMES = 120, FPS = 30;
const SRC = "public/media/sintel-demo.mp4";
const OUT = "docs/figures/data";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

function ff(args, input) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error("ffmpeg failed: " + r.stderr.toString());
  return r.stdout;
}
function decodeRgba(path) {
  const raw = ff(["-i", path, "-frames:v", String(FRAMES), "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
  const n = Math.floor(raw.length / (W * H * 4));
  const frames = [];
  for (let t = 0; t < n; t++) frames.push(new Uint8ClampedArray(raw.buffer, raw.byteOffset + t * W * H * 4, W * H * 4));
  return frames;
}
function encode(frames, path, codecArgs) {
  const buf = Buffer.concat(frames.map((f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength)));
  ff(["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-", ...codecArgs, path], buf);
  return readFileSync(path).length;
}
const hex = apcvw.toHex;
const t0 = performance.now();
const record = { width: W, height: H, frames: FRAMES, fps: FPS, source: SRC };

// 1. Identity and payload
const { privateKey, publicKey } = await apcvw.generateIdentity();
const message = "Copyright 2026 Phi Lab Foundation";
const payload = await apcvw.createPayload(message, privateKey);
record.identity = { publicKey: hex(publicKey) };
record.payload = { message, messageBytes: payload.messageBytes.length, bitCount: payload.bitCount, signature: hex(payload.signature), framing: `(1 + 2 + ${payload.messageBytes.length} + 64 + 30) * 8 = ${payload.bitCount}` };
writeFileSync(join(OUT, "payload_bits.bin"), Buffer.from(payload.bits));

// 2. Layout
const nonce = "readme-figures-2026-09-07";
const layout = await apcvw.createLayout({ width: W, height: H, nonce, bitCount: payload.bitCount });
const pool = apcvw.gridBins(W, H);
record.layout = { nonce, version: layout.version, poolSize: pool.ky.length, groups: layout.groups.length, binsPerGroup: layout.groups[0].ky.length, band: layout.band };
writeFileSync(join(OUT, "layout.json"), JSON.stringify({ pool: { ky: Array.from(pool.ky), kx: Array.from(pool.kx) }, groups: layout.groups.map((g) => ({ ky: Array.from(g.ky), kx: Array.from(g.kx), phases: Array.from(g.phases) })) }));

// 3. Carriers and embedding
const src = decodeRgba(SRC);
if (src.length < FRAMES) throw new Error(`only ${src.length} source frames`);
const psnrTarget = 42;
const carriers = apcvw.createCarriers(layout, payload.bits, psnrTarget);
writeFileSync(join(OUT, "carrier_plane_g0.f32"), Buffer.from(carriers.planes[0].buffer));
const marked = [];
let te = performance.now();
for (let t = 0; t < FRAMES; t++) marked.push(apcvw.embedFrame(src[t], W, H, carriers.planes[apcvw.groupForFrame(t, layout)]));
record.embed = { psnrTarget, alpha: carriers.alpha, msPerFrame: (performance.now() - te) / FRAMES };
writeFileSync(join(OUT, "frame0_source.rgba"), Buffer.from(src[0].buffer, src[0].byteOffset, src[0].byteLength));
writeFileSync(join(OUT, "frame0_marked.rgba"), Buffer.from(marked[0]));
// residual and PSNR of the Cr plane before any codec
{
  const res = apcvw.residualPlane(marked[0], src[0], W, H);
  let se = 0; for (let i = 0; i < res.length; i++) se += res[i] * res[i];
  record.embed.crPsnrBeforeCodec = 10 * Math.log10(255 * 255 / (se / res.length));
  writeFileSync(join(OUT, "residual0_before_codec.f64"), Buffer.from(res.buffer));
}

// 4. Encode with two real codecs, decode, verify with the public key alone
const codecs = {
  h264_crf23: ["-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p"],
  h264_crf28: ["-c:v", "libx264", "-preset", "medium", "-crf", "28", "-pix_fmt", "yuv420p"],
  vp9_crf33: ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "33", "-pix_fmt", "yuv420p"],
};
record.codecs = {};
for (const [name, args] of Object.entries(codecs)) {
  const path = join(OUT, `marked_${name}.${name.startsWith("vp9") ? "webm" : "mp4"}`);
  const bytes = encode(marked, path, args);
  const dec = decodeRgba(path);
  const rows = dec.map((f) => apcvw.extractFrameEvidence(f, W, H, layout));
  const tv = performance.now();
  const result = await apcvw.verifyEvidence(rows, layout, publicKey);
  const wrongKey = await apcvw.verifyEvidence(rows, layout, (await apcvw.generateIdentity()).publicKey);
  // bit error rate before RS, against the payload actually embedded
  let errs = 0; for (let i = 0; i < payload.bits.length; i++) if (result.extractedBits[i] !== payload.bits[i]) errs++;
  // per-frame group scores (for the temporal figure)
  const scores = rows.map((r) => Array.from(r.scores));
  record.codecs[name] = { bytes, framesDecoded: dec.length, verified: result.verified, reason: result.reason, message: result.message, signatureMatches: result.signature ? hex(result.signature) === hex(payload.signature) : false, correctedSymbols: result.correctedSymbols, rawBitErrors: errs, rawBer: errs / payload.bits.length, groupCounts: result.groupCounts, wrongKey: { verified: wrongKey.verified, reason: wrongKey.reason }, verifyMs: performance.now() - tv };
  writeFileSync(join(OUT, `scores_${name}.json`), JSON.stringify(scores));
  writeFileSync(join(OUT, `softsums_${name}.f64`), Buffer.from(result.softSums.buffer));
  if (name === "h264_crf23") {
    writeFileSync(join(OUT, "frame0_decoded_h264.rgba"), Buffer.from(dec[0].buffer, dec[0].byteOffset, dec[0].byteLength));
    const res = apcvw.residualPlane(dec[0], src[0], W, H);
    writeFileSync(join(OUT, "residual0_after_h264.f64"), Buffer.from(res.buffer));
  }
  rmSync(path);
}

// 5. Unmarked source through the verifier (negative control)
{
  const rows = src.map((f) => apcvw.extractFrameEvidence(f, W, H, layout));
  const r = await apcvw.verifyEvidence(rows, layout, publicKey);
  record.unmarkedControl = { verified: r.verified, reason: r.reason };
  writeFileSync(join(OUT, "scores_unmarked.json"), JSON.stringify(rows.map((x) => Array.from(x.scores))));
}

// 6. Strength ladder: Cr PSNR vs raw bit errors after H.264 CRF 23 (one clip)
record.ladder = [];
for (const p of [48, 46, 44, 42, 40, 38, 36]) {
  const c = apcvw.createCarriers(layout, payload.bits, p);
  const m = []; for (let t = 0; t < FRAMES; t++) m.push(apcvw.embedFrame(src[t], W, H, c.planes[apcvw.groupForFrame(t, layout)]));
  const path = join(OUT, "ladder.mp4"); encode(m, path, codecs.h264_crf23);
  const dec = decodeRgba(path); rmSync(path);
  const rows = dec.map((f) => apcvw.extractFrameEvidence(f, W, H, layout));
  const r = await apcvw.verifyEvidence(rows, layout, publicKey);
  let errs = 0; for (let i = 0; i < payload.bits.length; i++) if (r.extractedBits[i] !== payload.bits[i]) errs++;
  // full-frame RGB PSNR of the marked frame 0 against the source, before codec
  let se = 0; for (let i = 0; i < src[0].length; i++) if (i % 4 !== 3) { const d = m[0][i] - src[0][i]; se += d * d; }
  record.ladder.push({ psnrTarget: p, rgbPsnrFrame0: 10 * Math.log10(255 * 255 / (se / (W * H * 3))), rawBitErrors: errs, verified: r.verified, correctedSymbols: r.correctedSymbols });
}

// 7. Spectra of frame 0 for the figure (source, marked, decoded), Cr plane
for (const [name, f] of [["source", src[0]], ["marked", marked[0]]]) {
  const sp = apcvw.spectrumPreview(f, W, H);
  writeFileSync(join(OUT, `spectrum_${name}.f32`), Buffer.from(sp.magnitude.buffer));
}
{
  const dec = new Uint8ClampedArray(readFileSync(join(OUT, "frame0_decoded_h264.rgba")).buffer);
  const sp = apcvw.spectrumPreview(dec, W, H);
  writeFileSync(join(OUT, "spectrum_decoded_h264.f32"), Buffer.from(sp.magnitude.buffer));
}

record.totalSeconds = (performance.now() - t0) / 1000;
record.node = process.version;
writeFileSync(join(OUT, "record.json"), JSON.stringify(record, null, 2));
console.log(JSON.stringify({ codecs: record.codecs, unmarked: record.unmarkedControl, ladder: record.ladder.map((l) => [l.psnrTarget, l.rawBitErrors, l.verified]), seconds: record.totalSeconds.toFixed(1) }, null, 1));
