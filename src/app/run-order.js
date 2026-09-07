// The single source of truth for the order in which the full demonstration
// runs, and for which walkthrough card each step belongs to. ui.js iterates
// RUN_STEPS to call its step functions by name, and walkthrough.js uses the
// same list to derive card order, per-card timings, and run status. Neither
// file keeps a second copy of this list.

export const RUN_STEPS = Object.freeze([
  Object.freeze({ fn: "doGenerate", card: "identity" }),
  Object.freeze({ fn: "doPrepareBuiltin", card: "source" }),
  Object.freeze({ fn: "doImport", card: "source" }),
  Object.freeze({ fn: "doSign", card: "payload" }),
  Object.freeze({ fn: "doEmbed", card: "embed" }),
  Object.freeze({ fn: "doVerify", card: "verify" }),
  Object.freeze({ fn: "doWrongKey", card: "controls" }),
  Object.freeze({ fn: "doUnmarked", card: "controls" }),
  Object.freeze({ fn: "doInspect", card: "inspect" }),
]);

/** Card ids in run order, each once. */
export const CARD_ORDER = Object.freeze([...new Set(RUN_STEPS.map((s) => s.card))]);

/** Step function names that belong to one card, in run order. */
export function stepsForCard(cardId) {
  return RUN_STEPS.filter((s) => s.card === cardId).map((s) => s.fn);
}

/** The card a step function reports into, or null for an unknown name. */
export function cardForStep(fn) {
  const found = RUN_STEPS.find((s) => s.fn === fn);
  return found ? found.card : null;
}
