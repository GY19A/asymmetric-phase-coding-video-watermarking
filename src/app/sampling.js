// Deterministic sampling of the four second excerpt into 120 slots at 30 fps,
// and the duplication plan used when a source presents fewer frames.
// Pure functions. The signer uses groupForSampleIndex; the verifier never does.

/** Tolerance in frames for timestamp noise below a slot boundary (about 3 microseconds at 30 fps). */
const SLOT_EPSILON_FRAMES = 1e-4;

/** Slot index for a presented media time, or -1 when outside the excerpt. */
export function sampleSlotFor(mediaTime, start, fps, count) {
  const slot = Math.floor((mediaTime - start) * fps + SLOT_EPSILON_FRAMES);
  if (slot < 0 || slot >= count) return -1;
  return slot;
}

/**
 * Given which slots received a distinct frame, choose a source slot for every
 * output frame. Gaps repeat the nearest earlier captured frame. Leading gaps use
 * the first captured frame. This is plain frame duplication, a frame-rate
 * conversion the protocol is designed to tolerate.
 */
export function fillMissingSlots(filled) {
  const n = filled.length;
  const first = filled.indexOf(true);
  if (first < 0) throw new Error("no frames were captured inside the excerpt");
  const sourceSlot = new Array(n);
  let last = first;
  let duplicated = 0;
  let distinct = 0;
  for (let i = 0; i < n; i++) {
    if (filled[i]) {
      last = i;
      distinct++;
      sourceSlot[i] = i;
    } else {
      duplicated++;
      sourceSlot[i] = last;
    }
  }
  return { sourceSlot, duplicated, distinct };
}

export function samplingSummary(filled) {
  const total = filled.length;
  let distinct = 0;
  for (const f of filled) if (f) distinct++;
  const duplicated = total - distinct;
  let text = `${distinct} distinct source frames in ${total} slots`;
  if (duplicated > 0) text += `, ${duplicated} duplicated to keep 30 fps`;
  return { total, distinct, duplicated, text };
}

/** Run-length group for a sample index: floor(i / K) mod G. Signer side only. */
export function groupForSampleIndex(index, runLength = 30, groups = 4) {
  return Math.floor(index / runLength) % groups;
}

export function frameIntervalMs(fps) {
  return 1000 / fps;
}
