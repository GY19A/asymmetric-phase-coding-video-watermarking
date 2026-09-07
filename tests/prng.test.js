import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { layoutSeed, CounterPrng, LAYOUT_VERSION } from '../src/lib/prng.js';
import { toHex } from '../src/lib/hex.js';

test('layout seed is SHA-256 over the versioned domain string and the UTF-8 nonce', () => {
  assert.equal(LAYOUT_VERSION, 'apcvw-js-v1');
  const want = createHash('sha256').update('apcvw-js-v1|layout|').update('nonce-1').digest('hex');
  assert.equal(toHex(layoutSeed('nonce-1')), want);
  const want2 = createHash('sha256').update('apcvw-js-v1|layout|').update(Buffer.from('café ☃', 'utf8')).digest('hex');
  assert.equal(toHex(layoutSeed('café ☃')), want2);
  assert.throws(() => layoutSeed(5), /string/);
});

test('counter stream equals SHA-256(seed || BE32(i)) consumed as big-endian uint32 words', () => {
  const seed = layoutSeed('stream-test');
  const prng = new CounterPrng(seed);
  const words = [];
  for (let block = 0; block < 3; block++) {
    const ctr = Buffer.alloc(4);
    ctr.writeUInt32BE(block, 0);
    const digest = createHash('sha256').update(Buffer.from(seed)).update(ctr).digest();
    for (let w = 0; w < 8; w++) words.push(digest.readUInt32BE(w * 4));
  }
  for (const w of words) assert.equal(prng.nextUint32(), w);
});

test('nextFloat is in [0,1) with 53-bit construction and nextBelow covers its range without bias', () => {
  const prng = new CounterPrng(layoutSeed('float-test'));
  for (let i = 0; i < 10000; i++) {
    const f = prng.nextFloat();
    assert.ok(f >= 0 && f < 1);
  }
  const counts = new Array(7).fill(0);
  for (let i = 0; i < 70000; i++) counts[prng.nextBelow(7)]++;
  for (const c of counts) assert.ok(Math.abs(c - 10000) < 600, `bucket ${c}`);
  assert.equal(prng.nextBelow(1), 0);
  assert.throws(() => prng.nextBelow(0));
  assert.throws(() => prng.nextBelow(2 ** 32 + 1));
  assert.throws(() => prng.nextBelow(2.5));
});

test('two generators with the same seed produce the same stream', () => {
  const a = new CounterPrng(layoutSeed('same'));
  const b = new CounterPrng(layoutSeed('same'));
  for (let i = 0; i < 100; i++) assert.equal(a.nextUint32(), b.nextUint32());
  const c = new CounterPrng(layoutSeed('other'));
  assert.notEqual(a.nextUint32(), c.nextUint32());
  assert.throws(() => new CounterPrng(new Uint8Array(16)), /32/);
});
