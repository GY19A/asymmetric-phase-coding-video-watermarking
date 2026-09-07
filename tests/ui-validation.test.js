// UI slice: input validation for local files, URLs, decoded media metadata,
// and the canonical 1024x512 letterbox plan shown before Import.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_INPUT_BYTES,
  EXCERPT_SECONDS,
  SAMPLE_FPS,
  SAMPLE_COUNT,
  CANONICAL,
  validateFileCandidate,
  validateUrlCandidate,
  validateSourceMetadata,
  planCanonical,
  clampExcerptStart,
  describeInterval,
  formatBytes,
  mediaErrorMessage,
} from "../src/app/validation.js";

test("limits match the confirmed scope", () => {
  assert.equal(MAX_INPUT_BYTES, 40 * 1024 * 1024);
  assert.equal(EXCERPT_SECONDS, 4);
  assert.equal(SAMPLE_FPS, 30);
  assert.equal(SAMPLE_COUNT, 120);
  assert.deepEqual(CANONICAL, { width: 1024, height: 512 });
});

test("validateFileCandidate accepts a normal video file", () => {
  const r = validateFileCandidate({ name: "clip.mp4", size: 5_000_000, type: "video/mp4" });
  assert.equal(r.ok, true);
});

test("validateFileCandidate rejects oversized input with the limit in the message", () => {
  const r = validateFileCandidate({ name: "big.mp4", size: MAX_INPUT_BYTES + 1, type: "video/mp4" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "too-large");
  assert.match(r.message, /40 MB/);
});

test("validateFileCandidate rejects empty files", () => {
  const r = validateFileCandidate({ name: "x.mp4", size: 0, type: "video/mp4" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "empty");
});

test("validateFileCandidate rejects non-video by type and extension, but trusts a video extension when type is blank", () => {
  const bad = validateFileCandidate({ name: "notes.pdf", size: 10, type: "application/pdf" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "not-video");
  const blankType = validateFileCandidate({ name: "clip.webm", size: 10, type: "" });
  assert.equal(blankType.ok, true);
  const mkv = validateFileCandidate({ name: "clip.mkv", size: 10, type: "" });
  assert.equal(mkv.ok, true);
});

test("validateUrlCandidate accepts http and https, rejects everything else", () => {
  assert.equal(validateUrlCandidate("https://example.org/a.mp4").ok, true);
  assert.equal(validateUrlCandidate("http://localhost:19081/media/sintel-demo.mp4").ok, true);
  assert.equal(validateUrlCandidate("").code, "empty");
  assert.equal(validateUrlCandidate("   ").code, "empty");
  assert.equal(validateUrlCandidate("ftp://example.org/a.mp4").code, "not-http");
  assert.equal(validateUrlCandidate("javascript:alert(1)").code, "not-http");
  assert.equal(validateUrlCandidate("not a url").code, "invalid-url");
});

test("validateUrlCandidate returns a normalized URL object string", () => {
  const r = validateUrlCandidate("  HTTPS://Example.org/Clip.mp4  ");
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://example.org/Clip.mp4");
});

test("validateSourceMetadata rejects unreadable, unknown-duration, and too-short media", () => {
  assert.equal(validateSourceMetadata({ duration: 10, videoWidth: 0, videoHeight: 0 }).code, "unreadable");
  assert.equal(validateSourceMetadata({ duration: NaN, videoWidth: 640, videoHeight: 480 }).code, "unknown-duration");
  assert.equal(validateSourceMetadata({ duration: Infinity, videoWidth: 640, videoHeight: 480 }).code, "unknown-duration");
  const short = validateSourceMetadata({ duration: 3.9, videoWidth: 640, videoHeight: 480 });
  assert.equal(short.code, "too-short");
  assert.match(short.message, /4/);
  assert.equal(validateSourceMetadata({ duration: 4.0, videoWidth: 640, videoHeight: 480 }).ok, true);
});

test("planCanonical is identity for a 1024x512 source", () => {
  const p = planCanonical(1024, 512);
  assert.equal(p.scale, 1);
  assert.equal(p.drawWidth, 1024);
  assert.equal(p.drawHeight, 512);
  assert.equal(p.offsetX, 0);
  assert.equal(p.offsetY, 0);
  assert.equal(p.bars, "none");
});

test("planCanonical pillarboxes 16:9 content inside the 2:1 canonical frame", () => {
  const p = planCanonical(1920, 1080);
  assert.ok(Math.abs(p.scale - 512 / 1080) < 1e-9);
  assert.equal(p.drawWidth, 910);
  assert.equal(p.drawHeight, 512);
  assert.equal(p.offsetX, 57);
  assert.equal(p.offsetY, 0);
  assert.equal(p.bars, "sides");
  assert.match(p.description, /1920x1080/);
  assert.match(p.description, /1024x512/);
});

test("planCanonical letterboxes very wide content", () => {
  const p = planCanonical(2048, 512);
  assert.equal(p.scale, 0.5);
  assert.equal(p.drawWidth, 1024);
  assert.equal(p.drawHeight, 256);
  assert.equal(p.offsetY, 128);
  assert.equal(p.bars, "top-bottom");
});

test("planCanonical never upscales beyond the canonical box", () => {
  const p = planCanonical(320, 240);
  assert.equal(p.drawHeight, 512);
  assert.equal(p.drawWidth, 683);
  assert.equal(p.offsetX, 170);
});

test("clampExcerptStart keeps the 4 second window inside the clip", () => {
  assert.equal(clampExcerptStart(0, 4), 0);
  assert.equal(clampExcerptStart(-3, 10), 0);
  assert.equal(clampExcerptStart(9, 10), 6);
  assert.equal(clampExcerptStart(2.5, 10), 2.5);
  assert.equal(clampExcerptStart(NaN, 10), 0);
});

test("describeInterval states the processed window against the full duration", () => {
  const s = describeInterval(2.5, 12.345);
  assert.equal(s, "2.500 s to 6.500 s of 12.345 s");
});

test("formatBytes is human readable", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(929114), "907.3 KB");
  assert.equal(formatBytes(40 * 1024 * 1024), "40.0 MB");
});

test("mediaErrorMessage maps MediaError codes to useful text", () => {
  assert.match(mediaErrorMessage(4), /not supported|unsupported/i);
  assert.match(mediaErrorMessage(3), /decod/i);
  assert.match(mediaErrorMessage(2), /network/i);
  assert.match(mediaErrorMessage(1), /abort/i);
  assert.match(mediaErrorMessage(99), /unknown/i);
});
