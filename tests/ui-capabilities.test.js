// UI slice: runtime capability detection and recorder codec choice.
// Pure functions with an injected environment so they run under Node.
import test from "node:test";
import assert from "node:assert/strict";
import {
  RECORDER_CANDIDATES,
  chooseRecorderMime,
  describeMime,
  detectCapabilities,
} from "../src/app/capabilities.js";

test("candidate list prefers WebM VP9 then VP8, and never requests WebM H.264", () => {
  assert.equal(RECORDER_CANDIDATES[0], "video/webm;codecs=vp9");
  assert.equal(RECORDER_CANDIDATES[1], "video/webm;codecs=vp8");
  for (const c of RECORDER_CANDIDATES) {
    assert.equal(/h264|avc/i.test(c), false, `candidate ${c} must not request H.264`);
  }
});

test("chooseRecorderMime returns the first supported candidate or null", () => {
  const onlyVp8 = (m) => m === "video/webm;codecs=vp8";
  assert.equal(chooseRecorderMime(onlyVp8), "video/webm;codecs=vp8");
  assert.equal(chooseRecorderMime(() => false), null);
  assert.equal(chooseRecorderMime(() => true), "video/webm;codecs=vp9");
  const onlyMp4 = (m) => m === "video/mp4";
  assert.equal(chooseRecorderMime(onlyMp4), "video/mp4");
});

test("describeMime labels container and codec truthfully", () => {
  assert.deepEqual(describeMime("video/webm;codecs=vp9"), { container: "WebM", codec: "VP9" });
  assert.deepEqual(describeMime("video/webm;codecs=vp8"), { container: "WebM", codec: "VP8" });
  assert.deepEqual(describeMime("video/webm; codecs=\"vp8, opus\""), { container: "WebM", codec: "VP8" });
  assert.equal(describeMime("video/webm").codec, "not disclosed by the recorder");
  assert.equal(describeMime("video/mp4").container, "MP4");
  assert.deepEqual(describeMime("video/mp4;codecs=avc1.42E01E"), { container: "MP4", codec: "H.264 (avc1.42E01E)" });
  assert.deepEqual(describeMime("video/webm;codecs=h264"), { container: "WebM", codec: "H.264 (h264)" });
  assert.equal(describeMime("video/x-matroska;codecs=avc1").container, "Matroska");
  assert.equal(describeMime("").container, "unknown");
});

function fullEnv(overrides = {}) {
  return {
    MediaRecorder: { isTypeSupported: () => true },
    canvasCaptureStream: true,
    videoFrameCallback: true,
    getRandomValues: true,
    Worker: true,
    isSecureContext: false,
    subtleCrypto: false,
    ...overrides,
  };
}

test("detectCapabilities reports ok on a plain HTTP origin with the needed pieces", () => {
  const c = detectCapabilities(fullEnv());
  assert.equal(c.ok, true);
  assert.deepEqual(c.blockers, []);
  assert.equal(c.recorder.supported, true);
  assert.equal(c.recorder.mime, "video/webm;codecs=vp9");
  assert.equal(c.secureContext, false);
  assert.equal(c.subtleCrypto, false);
});

test("detectCapabilities blocks without MediaRecorder or a supported codec, without faking output", () => {
  const none = detectCapabilities(fullEnv({ MediaRecorder: undefined }));
  assert.equal(none.ok, false);
  assert.ok(none.blockers.some((b) => /MediaRecorder/.test(b)));
  const noCodec = detectCapabilities(fullEnv({ MediaRecorder: { isTypeSupported: () => false } }));
  assert.equal(noCodec.ok, false);
  assert.equal(noCodec.recorder.mime, null);
});

test("detectCapabilities blocks without captureStream, worker, or randomness", () => {
  assert.equal(detectCapabilities(fullEnv({ canvasCaptureStream: false })).ok, false);
  assert.equal(detectCapabilities(fullEnv({ Worker: false })).ok, false);
  assert.equal(detectCapabilities(fullEnv({ getRandomValues: false })).ok, false);
});

test("missing requestVideoFrameCallback is a warning, not a blocker", () => {
  const c = detectCapabilities(fullEnv({ videoFrameCallback: false }));
  assert.equal(c.ok, true);
  assert.ok(c.warnings.some((w) => /requestVideoFrameCallback/.test(w)));
});
