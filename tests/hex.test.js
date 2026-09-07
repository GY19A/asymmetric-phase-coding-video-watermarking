import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex, fromHex } from '../src/lib/hex.js';

test('toHex encodes bytes as lowercase hex', () => {
  assert.equal(toHex(new Uint8Array([0, 1, 254, 255])), '0001feff');
  assert.equal(toHex(new Uint8Array(0)), '');
});

test('fromHex decodes upper and lower case and rejects malformed input', () => {
  assert.deepEqual(fromHex('0001FEff'), new Uint8Array([0, 1, 254, 255]));
  assert.deepEqual(fromHex(''), new Uint8Array(0));
  assert.throws(() => fromHex('abc'), /even/);
  assert.throws(() => fromHex('zz'), /hex/);
  assert.throws(() => fromHex(12), /string/);
});

test('round trip', () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  assert.deepEqual(fromHex(toHex(bytes)), bytes);
});
