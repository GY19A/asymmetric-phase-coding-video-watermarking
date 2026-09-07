// Public decoding metadata that travels next to a signed output.
// It carries layout parameters only. It never carries the message, the
// signature, a verdict, or private key material.
import { CANONICAL } from "./validation.js";

export const METADATA_FORMAT = "apcvw-js-v1";

/** Fields that would turn metadata into a claimed result. Always stripped on import. */
const CLAIM_FIELDS = new Set(["message", "messageText", "recoveredMessage", "signature", "signatureHex", "verified", "verdict", "result"]);

const REQUIRED_STRINGS = ["nonce", "layoutVersion", "mode"];
const REQUIRED_INTS = ["bitCount", "messageByteLength", "runLength", "groups"];

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

export function buildMetadata(p) {
  for (const key of Object.keys(p)) {
    if (/private|seed|secret/i.test(key)) throw new Error(`metadata must not carry private material (${key})`);
    if (CLAIM_FIELDS.has(key)) throw new Error(`metadata must not carry a message, signature, or verdict (${key})`);
  }
  for (const key of REQUIRED_STRINGS) {
    if (typeof p[key] !== "string" || !p[key]) throw new Error(`metadata field ${key} must be a non-empty string`);
  }
  for (const key of REQUIRED_INTS) {
    if (!isPositiveInt(p[key])) throw new Error(`metadata field ${key} must be a positive integer`);
  }
  const canonical = p.canonical ?? CANONICAL;
  if (!isPositiveInt(canonical.width) || !isPositiveInt(canonical.height)) {
    throw new Error("metadata canonical size must have integer width and height");
  }
  const out = {
    format: METADATA_FORMAT,
    layoutVersion: p.layoutVersion,
    mode: p.mode,
    canonical: { width: canonical.width, height: canonical.height },
    nonce: p.nonce,
    bitCount: p.bitCount,
    messageByteLength: p.messageByteLength,
    runLength: p.runLength,
    groups: p.groups,
  };
  if (p.publicKeyHex) {
    if (!/^[0-9a-f]{64}$/i.test(p.publicKeyHex)) throw new Error("publicKeyHex must be 64 hex characters");
    out.publicKey = p.publicKeyHex.toLowerCase();
  }
  if (p.outputMime) out.outputMime = String(p.outputMime);
  if (Number.isFinite(p.psnrTarget)) out.psnrTarget = p.psnrTarget;
  if (p.band && Number.isFinite(p.band.lo) && Number.isFinite(p.band.hi)) out.band = { lo: p.band.lo, hi: p.band.hi };
  out.channel = "Cr";
  out.note =
    "Public decoding parameters. The message and signature are recovered from pixels at verification time and are not stored here.";
  return out;
}

function fail(code, message) {
  return { ok: false, code, message };
}

export function parseMetadata(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("invalid-json", "The metadata file is not valid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("invalid-json", "The metadata file must contain a JSON object.");
  }
  if (raw.format !== METADATA_FORMAT) {
    return fail("unsupported-format", `Unsupported metadata format "${raw.format}". Expected ${METADATA_FORMAT}.`);
  }
  const ignoredFields = [];
  const metadata = {};
  for (const [key, value] of Object.entries(raw)) {
    if (CLAIM_FIELDS.has(key)) ignoredFields.push(key);
    else metadata[key] = value;
  }
  for (const key of REQUIRED_STRINGS) {
    if (!(key in metadata)) return fail("missing-field", `The metadata is missing the required field "${key}".`);
    if (typeof metadata[key] !== "string" || !metadata[key]) return fail("bad-field", `The metadata field "${key}" must be a non-empty string.`);
  }
  for (const key of REQUIRED_INTS) {
    if (!(key in metadata)) return fail("missing-field", `The metadata is missing the required field "${key}".`);
    if (!isPositiveInt(metadata[key])) return fail("bad-field", `The metadata field "${key}" must be a positive integer.`);
  }
  const c = metadata.canonical;
  if (!c || !isPositiveInt(c.width) || !isPositiveInt(c.height)) {
    return fail("missing-field", 'The metadata is missing a valid "canonical" size.');
  }
  if (c.width !== CANONICAL.width || c.height !== CANONICAL.height) {
    return fail(
      "bad-field",
      `This browser layout supports the canonical size ${CANONICAL.width}x${CANONICAL.height} only. The metadata declares ${c.width}x${c.height}.`,
    );
  }
  if ("publicKey" in metadata) {
    if (typeof metadata.publicKey !== "string" || !/^[0-9a-f]{64}$/i.test(metadata.publicKey)) {
      return fail("bad-public-key", "The metadata public key must be 64 hex characters (32 bytes).");
    }
    metadata.publicKey = metadata.publicKey.toLowerCase();
  }
  return { ok: true, metadata, ignoredFields };
}
