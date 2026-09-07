import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/lib/index.js';

test('the public API surface documented in docs/API.md is exported', () => {
  const fns = [
    'generateIdentity', 'publicKeyFromPrivate', 'signMessage', 'verifySignature',
    'createPayload', 'decodePayloadBits', 'payloadBitCount', 'messageLengthFromBitCount', 'bytesToBits', 'bitsToBytes',
    'createLayout', 'gridBins',
    'createCarriers', 'carrierAlpha', 'groupForFrame', 'embedFrame',
    'extractFrameEvidence', 'evidenceFromPlane', 'smoothGroups', 'verifyEvidence',
    'spectrumPreview', 'crPlane', 'residualPlane',
    'toHex', 'fromHex',
  ];
  for (const f of fns) assert.equal(typeof api[f], 'function', f);
  assert.equal(api.LAYOUT_VERSION, 'apcvw-js-v1');
  assert.equal(typeof api.LIBRARY_VERSION, 'string');
  assert.equal(api.GROUPS, 4);
  assert.equal(api.RUN_LENGTH, 30);
  assert.deepEqual(api.BAND, [0.05, 0.12]);
  assert.equal(api.RS_PARITY, 30);
  assert.equal(api.MAX_MESSAGE_BYTES, 158);
  assert.equal(new TextEncoder().encode(api.DEFAULT_SAMPLE_MESSAGE).length, 31);
  assert.equal(api.verifyEvidence.length, 3, 'verifyEvidence takes rows, layout, publicKey and nothing else');
  assert.equal(api.createPayload.length, 2);
});
