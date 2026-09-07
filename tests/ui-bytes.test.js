// UI slice: UTF-8 byte accounting, hex helpers, and payload size arithmetic.
// These are pure functions used by the message editor and inspector.
import test from "node:test";
import assert from "node:assert/strict";
import {
  utf8ByteLength,
  utf8Encode,
  utf8Decode,
  bytesToHex,
  hexToBytes,
  groupHex,
  payloadBitLength,
  validateMessage,
  DEFAULT_MESSAGE,
  MAX_MESSAGE_BYTES,
  RS_PARITY_BYTES,
  FRAMING_BYTES,
} from "../src/app/text.js";

test("utf8ByteLength counts encoded bytes, not code units", () => {
  assert.equal(utf8ByteLength(""), 0);
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("é"), 2); // e acute
  assert.equal(utf8ByteLength("中文"), 6); // two CJK characters
  assert.equal(utf8ByteLength("\u{1F600}"), 4); // one emoji, two UTF-16 units
  assert.equal(utf8ByteLength("a\u{1F600}b"), 6);
});

test("utf8ByteLength replaces a lone surrogate with U+FFFD (3 bytes)", () => {
  assert.equal(utf8ByteLength("\uD800"), 3);
  assert.equal(utf8Encode("\uD800").length, 3);
});

test("utf8Encode and utf8Decode round trip", () => {
  const s = "Signed é 中 \u{1F600}";
  const bytes = utf8Encode(s);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(utf8Decode(bytes), s);
});

test("DEFAULT_MESSAGE is exactly 31 UTF-8 bytes and yields a 1024-bit payload", () => {
  assert.equal(utf8ByteLength(DEFAULT_MESSAGE), 31);
  assert.equal(payloadBitLength(utf8ByteLength(DEFAULT_MESSAGE)), 1024);
});

test("payloadBitLength follows the reference framing: (1+2+n+64+30)*8", () => {
  assert.equal(FRAMING_BYTES, 1 + 2 + 64);
  assert.equal(RS_PARITY_BYTES, 30);
  assert.equal(payloadBitLength(31), 1024);
  assert.equal(payloadBitLength(32), 1032);
  assert.equal(payloadBitLength(1), (1 + 97) * 8);
});

test("MAX_MESSAGE_BYTES is the single RS codeword limit: 255 - 30 - 67 = 158", () => {
  assert.equal(MAX_MESSAGE_BYTES, 158);
});

test("validateMessage rejects empty and over-long, accepts the limit exactly", () => {
  assert.deepEqual(validateMessage("").ok, false);
  assert.equal(validateMessage("").code, "empty");
  const atLimit = validateMessage("a".repeat(158));
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.bytes, 158);
  const over = validateMessage("a".repeat(159));
  assert.equal(over.ok, false);
  assert.equal(over.code, "too-long");
  assert.equal(over.bytes, 159);
  // 53 CJK characters are 159 bytes even though only 53 code units.
  const multibyte = validateMessage("中".repeat(53));
  assert.equal(multibyte.ok, false);
  assert.equal(multibyte.bytes, 159);
  assert.match(over.message, /158/);
});

test("validateMessage never truncates: returned bytes reflect the full input", () => {
  const r = validateMessage("x".repeat(300));
  assert.equal(r.bytes, 300);
  assert.equal(r.ok, false);
});

test("bytesToHex is lowercase and zero padded", () => {
  assert.equal(bytesToHex(new Uint8Array([0, 255, 16, 1])), "00ff1001");
  assert.equal(bytesToHex(new Uint8Array([])), "");
});

test("hexToBytes accepts upper case and surrounding whitespace", () => {
  assert.deepEqual(Array.from(hexToBytes(" 00FF10 ")), [0, 255, 16]);
});

test("hexToBytes rejects odd length, 0x prefix, and non-hex characters", () => {
  assert.throws(() => hexToBytes("abc"), /even/i);
  assert.throws(() => hexToBytes("0xff"), /hex/i);
  assert.throws(() => hexToBytes("zz"), /hex/i);
});

test("groupHex splits long hex into readable groups without changing content", () => {
  const hex = "0123456789abcdef0123456789abcdef";
  const grouped = groupHex(hex, 8);
  assert.equal(grouped, "01234567 89abcdef 01234567 89abcdef");
  assert.equal(grouped.replace(/\s+/g, ""), hex);
});
