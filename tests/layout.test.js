import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridBins, createLayout, GROUPS, RUN_LENGTH, BAND } from '../src/lib/layout.js';
import { fixtures } from './helpers/fixtures.js';

test('gridBins equals the Python reference grid_bins pool exactly, in order', () => {
  for (const key of Object.keys(fixtures.gridBins)) {
    const f = fixtures.gridBins[key];
    const { ky, kx } = gridBins(f.width, f.height);
    assert.equal(ky.length, f.count, key);
    assert.equal(kx.length, f.count, key);
    for (let i = 0; i < f.count; i++) {
      assert.equal(ky[i], f.bins[i][0], `${key} bin ${i} ky`);
      assert.equal(kx[i], f.bins[i][1], `${key} bin ${i} kx`);
    }
  }
});

function plain(layout) {
  return JSON.stringify(layout, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));
}

test('createLayout is deterministic, versioned, and carries the frozen constants', async () => {
  const a = await createLayout({ width: 1024, height: 512, nonce: 'demo-nonce', bitCount: 1024 });
  const b = await createLayout({ width: 1024, height: 512, nonce: 'demo-nonce', bitCount: 1024 });
  assert.equal(plain(a), plain(b));
  assert.equal(a.version, 'apcvw-js-v1');
  assert.equal(a.groupCount, 4);
  assert.equal(GROUPS, 4);
  assert.equal(a.runLength, 30);
  assert.equal(RUN_LENGTH, 30);
  assert.deepEqual(a.band, [0.05, 0.12]);
  assert.deepEqual(BAND, [0.05, 0.12]);
  assert.equal(a.width, 1024);
  assert.equal(a.height, 512);
  assert.equal(a.nonce, 'demo-nonce');
  assert.equal(a.bitCount, 1024);
  assert.equal(a.poolSize, fixtures.gridBins['1024x512'].count);
  assert.equal(a.groups.length, 4);
});

test('groups are equal, contiguous, disjoint, inside the band, with phases in [0, 2pi)', async () => {
  const layout = await createLayout({ width: 1024, height: 512, nonce: 'demo-nonce', bitCount: 1024 });
  const seen = new Set();
  const covered = new Uint8Array(1024);
  for (let g = 0; g < 4; g++) {
    const grp = layout.groups[g];
    assert.equal(grp.ky.length, 256);
    assert.equal(grp.kx.length, 256);
    assert.equal(grp.phases.length, 256);
    assert.equal(grp.bits.length, 256);
    assert.equal(grp.bitStart, g * 256);
    assert.equal(grp.bitEnd, (g + 1) * 256);
    for (let j = 0; j < 256; j++) {
      assert.equal(grp.bits[j], g * 256 + j);
      covered[grp.bits[j]]++;
      const ky = grp.ky[j]; const kx = grp.kx[j];
      assert.ok(ky >= 1 && ky < 256);
      assert.ok(kx > -512 && kx < 512);
      const r = Math.sqrt((ky / 256) * (ky / 256) + (kx / 512) * (kx / 512));
      assert.ok(r >= 0.05 && r < 0.12, `r=${r}`);
      const key = `${ky},${kx}`;
      assert.ok(!seen.has(key), `duplicate bin ${key}`);
      seen.add(key);
      assert.ok(grp.phases[j] >= 0 && grp.phases[j] < 2 * Math.PI);
    }
  }
  for (const c of covered) assert.equal(c, 1);
});

test('the nonce and the bit count change the layout', async () => {
  const a = await createLayout({ width: 1024, height: 512, nonce: 'nonce-A', bitCount: 1024 });
  const b = await createLayout({ width: 1024, height: 512, nonce: 'nonce-B', bitCount: 1024 });
  const c = await createLayout({ width: 1024, height: 512, nonce: 'nonce-A', bitCount: 1032 });
  assert.notEqual(plain(a.groups[0].ky), plain(b.groups[0].ky));
  assert.notEqual(plain(a.groups[0].phases), plain(b.groups[0].phases));
  assert.equal(c.groups[0].ky.length, 258);
  assert.equal(c.bitCount, 1032);
});

test('the largest supported message still fits the canonical 1024x512 frame', async () => {
  const layout = await createLayout({ width: 1024, height: 512, nonce: 'max', bitCount: 2040 });
  assert.equal(layout.groups[0].ky.length, 510);
});

test('unsupported dimensions and bit counts are rejected explicitly', async () => {
  await assert.rejects(() => createLayout({ width: 1000, height: 512, nonce: 'n', bitCount: 1024 }), /power of two/);
  await assert.rejects(() => createLayout({ width: 1024, height: 500, nonce: 'n', bitCount: 1024 }), /power of two/);
  await assert.rejects(() => createLayout({ width: 512, height: 256, nonce: 'n', bitCount: 1024 }), /pool|bins/);
  await assert.rejects(() => createLayout({ width: 16, height: 16, nonce: 'n', bitCount: 1024 }), /64|small|pool|bins/);
  await assert.rejects(() => createLayout({ width: 1024, height: 512, nonce: 'n', bitCount: 1001 }), /bit count|multiple of 8/);
  await assert.rejects(() => createLayout({ width: 1024, height: 512, nonce: 'n', bitCount: 100 }), /bit count|message/);
  await assert.rejects(() => createLayout({ width: 1024, height: 512, nonce: 5, bitCount: 1024 }), /nonce/);
  await assert.rejects(() => createLayout({ width: 1024, height: 512, nonce: '', bitCount: 1024 }), /nonce/);
});

test('the layout carries public geometry only, never payload material', async () => {
  const layout = await createLayout({ width: 1024, height: 512, nonce: 'public', bitCount: 1024 });
  const forbidden = ['message', 'messageBytes', 'signature', 'payload', 'privateKey', 'publicKey', 'bitsValue'];
  for (const k of forbidden) assert.ok(!(k in layout), k);
  assert.deepEqual(Object.keys(layout.groups[0]).sort(), ['bitEnd', 'bitStart', 'bits', 'kx', 'ky', 'phases']);
  assert.ok(layout.groups[0].bits instanceof Uint32Array);
  assert.ok(layout.groups[0].ky instanceof Int32Array);
  assert.ok(layout.groups[0].phases instanceof Float64Array);
});
