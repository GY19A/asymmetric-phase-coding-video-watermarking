// Text, byte, and payload-size helpers for the APCVW browser demo.
// Pure functions. No dependency on the numerical core.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** Reed-Solomon parity bytes used by the reference framing. */
export const RS_PARITY_BYTES = 30;
/** Framing bytes around the message: 1 flag byte, 2 length bytes, 64 signature bytes. */
export const FRAMING_BYTES = 1 + 2 + 64;
/** A single RS(255) codeword. The reference uses one codeword per payload. */
export const RS_CODEWORD_BYTES = 255;
/** Largest message that still fits one codeword: 255 - 30 - 67 = 158 bytes. */
export const MAX_MESSAGE_BYTES = RS_CODEWORD_BYTES - RS_PARITY_BYTES - FRAMING_BYTES;

/** Default sample message. Exactly 31 UTF-8 bytes, which gives a 1024-bit payload. */
export const DEFAULT_MESSAGE = "Signed in the browser, APCVW v1";

export function utf8Encode(text) {
  return encoder.encode(String(text));
}

export function utf8Decode(bytes) {
  return decoder.decode(bytes);
}

export function utf8ByteLength(text) {
  return encoder.encode(String(text)).length;
}

/** Coded payload length in bits for a message of n bytes: (1 + 2 + n + 64 + 30) * 8. */
export function payloadBitLength(messageByteLength) {
  return (FRAMING_BYTES + messageByteLength + RS_PARITY_BYTES) * 8;
}

/**
 * Validate a message for signing. Never truncates. Reports the true byte count
 * so the editor can show it even when the message is too long.
 */
export function validateMessage(text) {
  const bytes = utf8ByteLength(text ?? "");
  if (bytes === 0) {
    return { ok: false, code: "empty", bytes, message: "Enter a message to sign. It must be at least 1 byte." };
  }
  if (bytes > MAX_MESSAGE_BYTES) {
    return {
      ok: false,
      code: "too-long",
      bytes,
      message: `The message is ${bytes} UTF-8 bytes. One Reed-Solomon codeword holds at most ${MAX_MESSAGE_BYTES} message bytes.`,
    };
  }
  return { ok: true, code: "ok", bytes, message: `${bytes} UTF-8 bytes, ${payloadBitLength(bytes)} payload bits.` };
}

const HEX = "0123456789abcdef";

export function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX[b >> 4] + HEX[b & 15];
  }
  return out;
}

export function hexToBytes(hex) {
  const s = String(hex).trim();
  if (/^0x/i.test(s)) throw new Error("hex string must not carry a 0x prefix");
  if (s.length % 2 !== 0) throw new Error("hex string must have an even number of characters");
  if (!/^[0-9a-fA-F]*$/.test(s)) throw new Error("hex string contains non-hex characters");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Insert a space every `size` characters for display. Content is unchanged. */
export function groupHex(hex, size = 8) {
  const s = String(hex);
  const parts = [];
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
  return parts.join(" ");
}

/** Format a number with fixed decimals, or a dash when it is not finite. */
export function fixed(value, decimals = 2) {
  return Number.isFinite(value) ? value.toFixed(decimals) : "-";
}
