// Rendering guard for verification results.
// The view model is the only path from a library result to the screen.
// It accepts a positive verdict only when the result is a strict boolean true
// carrying a 64-byte signature and recovered message bytes, and it never reads
// a claimed message, signature, or verdict from metadata or context.
import { utf8Decode, bytesToHex } from "./text.js";

export const SCOPE_NOTE =
  "VERIFIED means the recovered message carries a valid Ed25519 signature under the supplied public key. " +
  "It does not establish who recorded the footage, legal ownership, or resistance to signature transplantation.";

function isBytes(v) {
  return v instanceof Uint8Array;
}

function toPlainArray(v) {
  if (Array.isArray(v)) return v.slice();
  if (v && typeof v.length === "number" && ArrayBuffer.isView(v)) return Array.from(v);
  return null;
}

export function verdictViewModel(result, ctx = {}) {
  const publicKeyHex = typeof ctx.publicKeyHex === "string" ? ctx.publicKeyHex : null;
  const base = {
    publicKeyHex,
    keyId: publicKeyHex ? publicKeyHex.slice(0, 8) : null,
    scopeNote: SCOPE_NOTE,
    messageText: null,
    messageBytes: null,
    messageByteLength: null,
    signatureHex: null,
    correctedSymbols: null,
    groupCounts: null,
    messageIsUnverified: false,
    reason: null,
  };

  if (!result || typeof result !== "object") {
    return { ...base, state: "pending", label: "Not run", reason: "Verification has not run." };
  }

  const sig = isBytes(result.signature) && result.signature.length === 64 ? result.signature : null;
  const msg = isBytes(result.messageBytes) ? result.messageBytes : null;
  const corrected = Number.isInteger(result.correctedSymbols) ? result.correctedSymbols : null;
  const groupCounts = toPlainArray(result.groupCounts);
  const libReason = typeof result.reason === "string" && result.reason.trim() ? result.reason.trim() : null;
  const common = { ...base, correctedSymbols: corrected, groupCounts };

  if (result.verified === true) {
    if (!sig || !msg) {
      return {
        ...common,
        state: "inconsistent",
        label: "NOT VERIFIED",
        reason:
          "The library reported verified without a 64-byte signature and recovered message bytes. " +
          "The result is treated as not verified.",
      };
    }
    return {
      ...common,
      state: "verified",
      label: "VERIFIED",
      reason: libReason ?? "signature valid under the supplied public key",
      messageText: utf8Decode(msg),
      messageBytes: msg,
      messageByteLength: msg.length,
      signatureHex: bytesToHex(sig),
    };
  }

  return {
    ...common,
    state: "rejected",
    label: "NOT VERIFIED",
    reason: libReason ?? "no reason supplied by the library",
    messageText: msg ? utf8Decode(msg) : null,
    messageBytes: msg,
    messageByteLength: msg ? msg.length : null,
    messageIsUnverified: !!msg,
    signatureHex: sig ? bytesToHex(sig) : null,
  };
}
