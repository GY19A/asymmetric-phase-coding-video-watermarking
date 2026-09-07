import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPayload, decodePayloadBits, payloadBitCount, messageLengthFromBitCount,
  bytesToBits, bitsToBytes, MAX_MESSAGE_BYTES, DEFAULT_SAMPLE_MESSAGE,
} from '../src/lib/payload.js';
import { rsEncode } from '../src/lib/rs.js';
import { publicKeyFromPrivate } from '../src/lib/identity.js';
import { toHex, fromHex } from '../src/lib/hex.js';
import { fixtures } from './helpers/fixtures.js';

const seed = fromHex(fixtures.framing.seed);
const pub = fromHex(fixtures.framing.publicKey);

test('default sample message measures 31 UTF-8 bytes and frames to 1024 bits', () => {
  const n = new TextEncoder().encode(DEFAULT_SAMPLE_MESSAGE).length;
  assert.equal(n, 31);
  assert.equal(payloadBitCount(n), 1024);
  assert.equal(payloadBitCount(32), 1032);
  assert.equal(MAX_MESSAGE_BYTES, 158);
  assert.equal(payloadBitCount(158), 2040);
  assert.throws(() => payloadBitCount(159), /158/);
  assert.throws(() => payloadBitCount(0), /1/);
  assert.equal(messageLengthFromBitCount(1024), 31);
  assert.equal(messageLengthFromBitCount(1032), 32);
  assert.throws(() => messageLengthFromBitCount(1020), /multiple of 8|bit count/);
  assert.throws(() => messageLengthFromBitCount(776), /bit count|message/);
});

test('bit packing is MSB first and round-trips', () => {
  assert.deepEqual(Array.from(bytesToBits(new Uint8Array([0x80, 0x01]))), [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  const bytes = new Uint8Array([0, 1, 2, 3, 127, 128, 200, 255]);
  assert.deepEqual(bitsToBytes(bytesToBits(bytes)), bytes);
  assert.throws(() => bitsToBytes(new Uint8Array(9)), /multiple of 8/);
});

test('createPayload reproduces the Python framing and RS parity bit for bit', async () => {
  assert.equal(toHex(publicKeyFromPrivate(seed)), fixtures.framing.publicKey);
  for (const c of fixtures.framing.cases) {
    const p = await createPayload(c.message, seed);
    assert.equal(toHex(p.messageBytes), c.messageHex);
    assert.equal(toHex(p.signature), c.signature);
    assert.equal(toHex(p.codedBytes), c.coded);
    assert.equal(p.bitCount, c.bitCount);
    assert.equal(p.bits.length, c.bitCount);
    assert.ok(p.bits instanceof Uint8Array);
    assert.equal(Array.from(p.bits).join(''), c.bits);
  }
});

test('framing header: flag byte 0 then 2-byte big-endian UTF-8 length', async () => {
  const p = await createPayload(fixtures.framing.cases[0].message, seed);
  assert.equal(Array.from(p.bits.subarray(0, 8)).join(''), '00000000');
  assert.equal(Array.from(p.bits.subarray(8, 24)).join(''), '0000000000011111');
  assert.equal(p.codedBytes[0], 0);
  assert.equal(p.codedBytes[1], 0);
  assert.equal(p.codedBytes[2], 31);
  assert.deepEqual(p.codedBytes.subarray(3, 34), p.messageBytes);
  assert.deepEqual(p.codedBytes.subarray(34, 98), p.signature);
});

test('createPayload rejects unsupported messages instead of truncating', async () => {
  await assert.rejects(() => createPayload('', seed), /empty|1/);
  await assert.rejects(() => createPayload('a'.repeat(159), seed), /158/);
  await assert.rejects(() => createPayload('é'.repeat(80), seed), /158/);
  const ok = await createPayload('é'.repeat(79), seed);
  assert.equal(ok.messageBytes.length, 158);
  assert.equal(ok.bitCount, 2040);
  await assert.rejects(() => createPayload(123, seed), /string/);
  await assert.rejects(() => createPayload('x', new Uint8Array(31)), /32/);
});

test('decodePayloadBits verifies from recovered bytes only', async () => {
  const c = fixtures.framing.cases[0];
  const p = await createPayload(c.message, seed);
  const r = decodePayloadBits(p.bits, pub);
  assert.equal(r.verified, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.message, c.message);
  assert.equal(toHex(r.messageBytes), c.messageHex);
  assert.equal(toHex(r.signature), c.signature);
  assert.equal(r.correctedSymbols, 0);
});

test('a wrong public key is rejected with signature invalid', async () => {
  const p = await createPayload(fixtures.framing.cases[0].message, seed);
  const other = publicKeyFromPrivate(fromHex(fixtures.ed25519.rfc8032[0].seed));
  const r = decodePayloadBits(p.bits, other);
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'signature invalid');
  assert.equal(r.message, null);
  assert.equal(r.messageBytes, null);
  assert.equal(r.signature, null);
});

test('channel errors inside the RS budget are corrected and reported', async () => {
  const p = await createPayload(fixtures.framing.cases[1].message, seed);
  const bits = Uint8Array.from(p.bits);
  bits[500] ^= 1;
  bits[9] ^= 1;
  const r = decodePayloadBits(bits, pub);
  assert.equal(r.verified, true);
  assert.equal(r.correctedSymbols, 2);
  assert.equal(r.message, fixtures.framing.cases[1].message);
});

function framedBits(body) {
  return bytesToBits(rsEncode(body));
}

test('tampered message byte with the original signature is rejected', async () => {
  const c = fixtures.framing.cases[0];
  const body = fromHex(c.body);
  body[3] ^= 0x20;
  const r = decodePayloadBits(framedBits(body), pub);
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'signature invalid');
});

test('a single inverted signature bit is rejected', async () => {
  const c = fixtures.framing.cases[0];
  const body = fromHex(c.body);
  body[3 + 31 + 5] ^= 0x04;
  const r = decodePayloadBits(framedBits(body), pub);
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'signature invalid');
});

test('content-bound flag and unknown flags are rejected', async () => {
  const c = fixtures.framing.cases[0];
  const body = fromHex(c.body);
  body[0] = 1;
  assert.equal(decodePayloadBits(framedBits(body), pub).reason, 'content-bound payload not supported');
  body[0] = 7;
  assert.equal(decodePayloadBits(framedBits(body), pub).reason, 'bad flag byte (7)');
});

test('a wrong length header is rejected even when RS decodes cleanly', async () => {
  const c = fixtures.framing.cases[0];
  const body = fromHex(c.body);
  body[2] = 30;
  const r = decodePayloadBits(framedBits(body), pub);
  assert.equal(r.verified, false);
  assert.match(r.reason, /bad length header \(30\)/);
});

test('uniform or absent bits are rejected', () => {
  const zeros = decodePayloadBits(new Uint8Array(1024), pub);
  assert.equal(zeros.verified, false);
  assert.match(zeros.reason, /bad length header|RS decode failed/);
  const ones = decodePayloadBits(new Uint8Array(1024).fill(1), pub);
  assert.equal(ones.verified, false);
});

test('bit arrays of unsupported length throw a clear error', () => {
  assert.throws(() => decodePayloadBits(new Uint8Array(1001), pub), /multiple of 8|bit count/);
  assert.throws(() => decodePayloadBits(new Uint8Array(8), pub), /bit count|message/);
  assert.throws(() => decodePayloadBits(new Uint8Array(1024), new Uint8Array(31)), /32/);
});
