import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, publicKeyFromPrivate, signMessage, verifySignature } from '../src/lib/identity.js';
import { toHex, fromHex } from '../src/lib/hex.js';
import { fixtures } from './helpers/fixtures.js';

// RFC 8032, section 7.1, TEST 1 to TEST 3. Values as published in the RFC.
const RFC8032 = [
  {
    seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    message: '',
    signature: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    message: '72',
    signature: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
  {
    seed: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    publicKey: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    message: 'af82',
    signature: '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
  },
];

test('RFC 8032 vectors: key derivation, signing, and verification', () => {
  for (const v of RFC8032) {
    const seed = fromHex(v.seed);
    assert.equal(toHex(publicKeyFromPrivate(seed)), v.publicKey);
    assert.equal(toHex(signMessage(fromHex(v.message), seed)), v.signature);
    assert.equal(verifySignature(fromHex(v.signature), fromHex(v.message), fromHex(v.publicKey)), true);
  }
});

test('RFC 8032 constants agree with the independent Python cryptography oracle', () => {
  assert.deepEqual(fixtures.ed25519.rfc8032, RFC8032);
});

test('a modified message does not verify', () => {
  const v = RFC8032[2];
  const sig = fromHex(v.signature);
  const pk = fromHex(v.publicKey);
  assert.equal(verifySignature(sig, fromHex('af83'), pk), false);
  assert.equal(verifySignature(sig, fromHex('af8200'), pk), false);
  assert.equal(verifySignature(sig, new Uint8Array(0), pk), false);
});

test('a wrong public key does not verify', () => {
  const v = RFC8032[2];
  assert.equal(verifySignature(fromHex(v.signature), fromHex(v.message), fromHex(RFC8032[1].publicKey)), false);
});

test('a tampered or malformed signature does not verify and does not throw', () => {
  const v = RFC8032[1];
  const sig = fromHex(v.signature);
  sig[10] ^= 0x01;
  assert.equal(verifySignature(sig, fromHex(v.message), fromHex(v.publicKey)), false);
  assert.equal(verifySignature(new Uint8Array(63), fromHex(v.message), fromHex(v.publicKey)), false);
  assert.equal(verifySignature(new Uint8Array(64), fromHex(v.message), fromHex(v.publicKey)), false);
});

test('generateIdentity yields a fresh 32-byte seed with a matching public key', async () => {
  const a = await generateIdentity();
  const b = await generateIdentity();
  assert.ok(a.privateKey instanceof Uint8Array && a.privateKey.length === 32);
  assert.ok(a.publicKey instanceof Uint8Array && a.publicKey.length === 32);
  assert.deepEqual(a.publicKey, publicKeyFromPrivate(a.privateKey));
  assert.notDeepEqual(a.privateKey, b.privateKey);
  assert.notDeepEqual(a.publicKey, b.publicKey);
  const msg = new TextEncoder().encode('identity round trip');
  const sig = signMessage(msg, a.privateKey);
  assert.equal(verifySignature(sig, msg, a.publicKey), true);
  assert.equal(verifySignature(sig, msg, b.publicKey), false);
});

test('key helpers reject wrong key sizes', () => {
  assert.throws(() => publicKeyFromPrivate(new Uint8Array(31)));
  assert.throws(() => signMessage(new Uint8Array(1), new Uint8Array(33)));
  assert.throws(() => verifySignature(new Uint8Array(64), new Uint8Array(1), new Uint8Array(31)));
});
