#!/usr/bin/env python3
"""Test-oracle fixture generator for apcvw-js (Slice A).

Run on CPU only:  CUDA_VISIBLE_DEVICES='' python3 tests/fixtures/make_fixtures.py

This script never imports the reference module (it would import torch).
Two pieces of the read-only reference WACV2027/supplementary/code/apvw.py are
copied verbatim into this oracle namespace: the unbound branch of
encode_payload (payload framing plus RS coding) and grid_bins (carrier band on
the DFT grid). Everything else here is independent test scaffolding.
"""
import hashlib
import importlib.metadata as md
import json
import os
import platform
import sys

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

import numpy as np
import reedsolo
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

RS_PARITY = 30
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "oracle.json")


# --- copied verbatim from the reference (unbound branch of encode_payload) ---
def encode_payload_unbound(message: bytes, sk):
    sig = sk.sign(message)
    body = b"\x00" + len(message).to_bytes(2, "big") + message + sig
    coded = bytes(reedsolo.RSCodec(RS_PARITY).encode(body))
    bits = np.unpackbits(np.frombuffer(coded, np.uint8)).astype(np.int64)
    return sig, body, coded, bits


# --- copied verbatim from the reference ---
def grid_bins(shape, lo, hi):
    H, W = shape
    ky = np.arange(1, H // 2)
    kx = np.arange(-(W // 2) + 1, W // 2)
    KY, KX = np.meshgrid(ky, kx, indexing="ij")
    r = np.sqrt((KY / (H / 2.0)) ** 2 + (KX / (W / 2.0)) ** 2)
    m = (r >= lo) & (r < hi)
    return np.stack([KY[m], KX[m]], axis=1)


def payload_bits_len(message_len: int) -> int:
    return (1 + 2 + message_len + 64 + RS_PARITY) * 8


def main():
    rng = np.random.default_rng(20260906)
    fx = {
        "meta": {
            "generator": "tests/fixtures/make_fixtures.py",
            "python": platform.python_version(),
            "numpy": np.__version__,
            "reedsolo": md.version("reedsolo"),
            "cryptography": md.version("cryptography"),
            "rs_params": {"nsym": RS_PARITY, "nsize": 255, "fcr": 0,
                          "prim": 0x11D, "generator": 2},
            "note": "encode_payload (unbound) and grid_bins copied verbatim "
                    "from the read-only reference; no torch import.",
        }
    }

    # 1. Ed25519: RFC 8032 section 7.1 vectors recomputed with `cryptography`.
    rfc = [
        ("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", ""),
        ("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", "72"),
        ("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7", "af82"),
    ]
    vecs = []
    for seed_hex, msg_hex in rfc:
        sk = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed_hex))
        vecs.append({
            "seed": seed_hex,
            "publicKey": sk.public_key().public_bytes_raw().hex(),
            "message": msg_hex,
            "signature": sk.sign(bytes.fromhex(msg_hex)).hex(),
        })
    fx["ed25519"] = {"rfc8032": vecs}

    # 2. Framing oracle for fixed seed and 31 / 32 byte ASCII messages.
    seed = hashlib.sha256(b"apcvw-js fixture seed 2026-09-06").digest()
    sk = Ed25519PrivateKey.from_private_bytes(seed)
    msgs = [b"APCVW browser demo, signed 2026", b"APCVW browser demo, signed 2026!"]
    assert len(msgs[0]) == 31 and len(msgs[1]) == 32
    framing = []
    for m in msgs:
        sig, body, coded, bits = encode_payload_unbound(m, sk)
        assert len(bits) == payload_bits_len(len(m))
        framing.append({
            "message": m.decode("ascii"),
            "messageHex": m.hex(),
            "signature": sig.hex(),
            "body": body.hex(),
            "coded": coded.hex(),
            "bitCount": int(len(bits)),
            "bits": "".join(str(int(b)) for b in bits),
        })
    fx["framing"] = {
        "seed": seed.hex(),
        "publicKey": sk.public_key().public_bytes_raw().hex(),
        "cases": framing,
    }

    # 3. RS(30) parity on random data of several lengths (single codeword).
    rs = reedsolo.RSCodec(RS_PARITY)
    enc = []
    for L in (1, 20, 98, 99, 160, 225):
        data = rng.integers(0, 256, L, dtype=np.uint8).tobytes()
        enc.append({"data": data.hex(), "coded": bytes(rs.encode(data)).hex()})
    fx["rs"] = {"encode": enc}

    # 4. Corrupted codewords: <=15 symbol errors decode to the original.
    _, body, coded, _ = encode_payload_unbound(msgs[0], sk)
    cases = []
    for e in (1, 5, 10, 15):
        for trial in range(3):
            c = bytearray(coded)
            pos = rng.choice(len(c), size=e, replace=False)
            for p in pos:
                c[p] ^= int(rng.integers(1, 256))
            dec, _, errata = rs.decode(bytes(c))
            assert bytes(dec) == body, "oracle must recover the original body"
            cases.append({"errors": int(e), "corrupted": bytes(c).hex(),
                          "decoded": bytes(dec).hex(),
                          "errataCount": int(len(errata))})
    beyond = []
    for e in (16, 18, 20, 30):
        c = bytearray(coded)
        pos = rng.choice(len(c), size=e, replace=False)
        for p in pos:
            c[p] ^= int(rng.integers(1, 256))
        try:
            dec, _, _ = rs.decode(bytes(c))
            outcome = "returned"
            dec_hex = bytes(dec).hex()
        except reedsolo.ReedSolomonError as ex:
            outcome = "raised"
            dec_hex = None
        beyond.append({"errors": int(e), "corrupted": bytes(c).hex(),
                       "outcome": outcome, "decoded": dec_hex,
                       "equalsOriginal": dec_hex == body.hex()})
    fx["rs"]["corrupted"] = cases
    fx["rs"]["beyondCapacity"] = beyond
    fx["rs"]["original"] = {"body": body.hex(), "coded": coded.hex()}

    # 5. grid_bins pools for canonical power-of-two shapes (exact order).
    pools = {}
    for (H, W) in ((512, 1024), (512, 512), (256, 512)):
        p = grid_bins((H, W), 0.05, 0.12)
        pools[f"{W}x{H}"] = {"width": W, "height": H, "count": int(len(p)),
                             "sha256": hashlib.sha256(
                                 p.astype(np.int32).tobytes()).hexdigest(),
                             "bins": p.astype(int).tolist()}
    fx["gridBins"] = pools

    with open(OUT, "w") as f:
        json.dump(fx, f, separators=(",", ":"))
    print(f"wrote {OUT}")
    print("framing bitCounts:", [c["bitCount"] for c in framing])
    print("pool sizes:", {k: v["count"] for k, v in pools.items()})
    print("beyond capacity:", [(b["errors"], b["outcome"], b["equalsOriginal"])
                               for b in beyond])


if __name__ == "__main__":
    main()
