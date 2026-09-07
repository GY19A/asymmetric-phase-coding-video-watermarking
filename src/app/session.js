// Protocol session state for the five-step demo.
// Pure, immutable updates. Changing an input invalidates every result that
// depends on it, so a stale output can never be shown next to new inputs.
import { DEFAULT_MESSAGE } from "./text.js";

export const STEPS = Object.freeze([
  Object.freeze({ index: 1, id: "identity", title: "Generate identity", verb: "Generate" }),
  Object.freeze({ index: 2, id: "source", title: "Load a video", verb: "Import" }),
  Object.freeze({ index: 3, id: "embed", title: "Embed signature", verb: "Embed" }),
  Object.freeze({ index: 4, id: "verify", title: "Extract and verify", verb: "Verify" }),
  Object.freeze({ index: 5, id: "inspect", title: "Inspect the signal", verb: "Inspect" }),
]);

/** Which stored results become invalid when a field changes. */
const DEPENDENTS = Object.freeze({
  identity: ["payload", "marked", "verification", "inspect"],
  message: ["payload", "marked", "verification", "inspect"],
  nonce: ["marked", "verification", "inspect"],
  source: ["marked", "verification", "inspect"],
  payload: ["marked", "verification", "inspect"],
  marked: ["verification", "inspect"],
  verification: ["inspect"],
  inspect: [],
  strength: [],
});

export function createSession() {
  return {
    identity: null,
    message: DEFAULT_MESSAGE,
    nonce: "",
    payload: null,
    source: null,
    marked: null,
    verification: null,
    inspect: null,
    strength: { mode: "auto", psnr: 42 },
    activeStep: 1,
  };
}

export function stepStatuses(state) {
  const done = [
    !!state.identity,
    !!state.source,
    !!state.marked,
    !!state.verification,
    !!state.inspect,
  ];
  const ready = [
    true,
    done[0],
    done[0] && done[1],
    done[2],
    done[2],
  ];
  return STEPS.map((step, i) => ({
    ...step,
    status: done[i] ? "done" : ready[i] ? "ready" : "locked",
  }));
}

export function firstIncompleteStep(state) {
  const st = stepStatuses(state);
  const found = st.find((s) => s.status !== "done");
  return found ? found.index : STEPS.length;
}

/** Return a new state with `field` set and every dependent result cleared. */
export function applyChange(state, field, value) {
  if (!Object.prototype.hasOwnProperty.call(DEPENDENTS, field)) {
    throw new Error(`unknown session field: ${field}`);
  }
  const next = { ...state, [field]: value };
  for (const dep of DEPENDENTS[field]) next[dep] = null;
  next.activeStep = Math.min(state.activeStep, firstIncompleteStep(next));
  return next;
}

/** Embed needs a signed payload in addition to an identity and a source. */
export function canEmbed(state) {
  return !!state.identity && !!state.source && !!state.payload;
}

/** Activate a step if it is done or ready. Locked steps are refused. */
export function setActiveStep(state, index) {
  if (!Number.isInteger(index) || index < 1 || index > STEPS.length) return state;
  const status = stepStatuses(state)[index - 1].status;
  if (status === "locked") return state;
  if (state.activeStep === index) return state;
  return { ...state, activeStep: index };
}
