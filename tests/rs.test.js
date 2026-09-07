import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rsEncode, rsDecode, ReedSolomonError, RS_PARITY } from '../src/lib/rs.js';
import { toHex, fromHex } from '../src/lib/hex.js';
import { fixtures } from './helpers/fixtures.js';
import { mulberry32, distinctPositions } from './helpers/testprng.js';

test('RS parameters match the reference RSCodec(30) defaults', () => {
  assert.equal(RS_PARITY, 30);
  assert.deepEqual(fixtures.meta.rs_params, { nsym: 30, nsize: 255, fcr: 0, prim: 0x11d, generator: 2 });
});

test('encode matches Python reedsolo on random inputs of several lengths', () => {
  for (const c of fixtures.rs.encode) {
    const coded = rsEncode(fromHex(c.data));
    assert.equal(toHex(coded), c.coded);
    assert.equal(coded.length, fromHex(c.data).length + RS_PARITY);
  }
});

test('encode matches Python reedsolo on the framed payload bodies', () => {
  for (const c of fixtures.framing.cases) {
    assert.equal(toHex(rsEncode(fromHex(c.body))), c.coded);
  }
});

test('decode of a clean codeword returns the data with zero corrections', () => {
  const { body, coded } = fixtures.rs.original;
  const r = rsDecode(fromHex(coded));
  assert.equal(toHex(r.data), body);
  assert.equal(r.corrected, 0);
});

test('oracle codewords with 1 to 15 symbol errors decode to the original', () => {
  for (const c of fixtures.rs.corrupted) {
    const r = rsDecode(fromHex(c.corrupted));
    assert.equal(toHex(r.data), c.decoded, `errors=${c.errors}`);
    assert.equal(toHex(r.data), fixtures.rs.original.body);
    assert.equal(r.corrected, c.errataCount);
  }
});

test('random error patterns up to 15 symbols are always corrected', () => {
  const rnd = mulberry32(0xc0ffee);
  for (let trial = 0; trial < 200; trial++) {
    const len = 1 + Math.floor(rnd() * 225);
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) data[i] = Math.floor(rnd() * 256);
    const coded = rsEncode(data);
    const e = Math.floor(rnd() * 16);
    const corrupted = Uint8Array.from(coded);
    for (const p of distinctPositions(rnd, coded.length, e)) corrupted[p] ^= 1 + Math.floor(rnd() * 255);
    const r = rsDecode(corrupted);
    assert.deepEqual(r.data, data, `trial ${trial} len ${len} errors ${e}`);
    assert.equal(r.corrected, e);
  }
});

test('beyond 15 errors the decoder never returns the original as a clean decode', () => {
  const original = fixtures.rs.original.body;
  for (const c of fixtures.rs.beyondCapacity) {
    let outcome;
    try {
      const r = rsDecode(fromHex(c.corrupted));
      outcome = toHex(r.data) === original ? 'original' : 'other';
    } catch (err) {
      assert.ok(err instanceof ReedSolomonError, `errors=${c.errors}: ${err}`);
      outcome = 'raised';
    }
    assert.notEqual(outcome, 'original', `errors=${c.errors}`);
    assert.equal(c.equalsOriginal, false);
  }
  const rnd = mulberry32(0xbadc0de);
  const coded = fromHex(fixtures.rs.original.coded);
  let raised = 0;
  let miscorrected = 0;
  for (let trial = 0; trial < 100; trial++) {
    const e = 16 + Math.floor(rnd() * 25);
    const corrupted = Uint8Array.from(coded);
    for (const p of distinctPositions(rnd, coded.length, e)) corrupted[p] ^= 1 + Math.floor(rnd() * 255);
    try {
      const r = rsDecode(corrupted);
      assert.notEqual(toHex(r.data), original, `trial ${trial}: a 16+ error pattern must not decode to the original`);
      miscorrected++;
    } catch (err) {
      assert.ok(err instanceof ReedSolomonError);
      raised++;
    }
  }
  assert.ok(raised > 0);
  assert.equal(raised + miscorrected, 100);
});

test('rejects unsupported sizes explicitly', () => {
  assert.throws(() => rsEncode(new Uint8Array(0)), /length/);
  assert.throws(() => rsEncode(new Uint8Array(226)), /225/);
  assert.throws(() => rsDecode(new Uint8Array(RS_PARITY)), /length/);
  assert.throws(() => rsDecode(new Uint8Array(256)), /255/);
});
