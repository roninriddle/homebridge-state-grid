#!/usr/bin/env python3
"""Generate cross-language golden vectors from the upstream Python implementation.

Usage:
    python3 tools/gen-golden.py --ref /path/to/hass-state-grid

The output (tests/golden-vectors.json) is committed to the repo so that the
TypeScript test suite never needs Python at run time.

Every vector is produced by the *upstream* code, not by a reimplementation,
so a passing TypeScript suite proves byte-level agreement with the reference.
"""

from __future__ import annotations

import argparse
import base64
import json
import pathlib
import shutil
import sys
import tempfile

SEED_B64 = base64.b64encode(bytes(range(32))).decode()
TS = 1_760_000_000_000  # fixed timestamp: 2025-10-09T...Z


def _stage(ref: pathlib.Path) -> pathlib.Path:
    """Copy the two dependency-free modules out of the HA integration package.

    ``state_grid/__init__.py`` imports Home Assistant, so the package cannot be
    imported as-is.  ``crypto`` and ``turing`` have no HA dependency, so they are
    staged into a flat directory and imported as top-level modules.

    The staging directory lives next to this script rather than in the system
    temp dir, because sandboxed runs may not have a writable /tmp.
    """
    src = ref / "custom_components" / "state_grid"
    stage = pathlib.Path(__file__).resolve().parent / ".refstage"
    if (stage / "turing" / "jce.py").is_file():
        return stage
    stage.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src / "crypto.py", stage / "crypto.py")
    shutil.copy2(src / "const.py", stage / "const.py")
    shutil.copytree(src / "turing", stage / "turing")
    return stage


def build_vectors(ref: pathlib.Path) -> dict:
    sys.path.insert(0, str(_stage(ref)))
    import const  # noqa: E402
    import crypto  # noqa: E402
    from turing import device_token, feature_profile, hash_python, jce  # noqa: E402

    profile = feature_profile.StableProfile(
        bytes(range(32)),
        boot_epoch_ms=TS - 7_200_000,
        install_epoch_ms=TS - 86_400_000 * 30,
    )

    vectors: dict = {
        "meta": {
            "generated_from": "stevenjoezhang/hass-state-grid@f3c7910",
            "seed_b64": SEED_B64,
            "timestamp_ms": TS,
            "note": "produced by upstream Python; do not hand-edit",
        }
    }

    # ---- turing hash64 ---------------------------------------------------
    hash_inputs = [
        b"",
        b"A",
        b"hello world",
        b"0123456789abcdef",
        bytes(range(32)),
        "中文特征值".encode(),
        b"x" * 4095,
    ]
    vectors["hash64"] = [
        # 以十六进制字符串输出：64 位结果超出 JSON number 的 2^53 精度，
        # 直接写数字会在 JSON.parse 阶段就失真。
        {"input_hex": raw.hex(), "seed": seed, "out_hex": f"{hash_python.turing_hash64(raw, seed):x}"}
        for raw in hash_inputs
        for seed in (0,)
    ]

    # ---- feature maps ----------------------------------------------------
    native = profile.native_feature_map(TS)
    feature = profile.feature_map(TS, fallback_status_code=-22056, token_nonce="N" * 32)
    vectors["native_feature_map"] = {str(k): v for k, v in native.items()}
    vectors["feature_map"] = {str(k): v for k, v in feature.items()}
    vectors["feature_map_key_order"] = [str(k) for k in feature]

    # ---- feature hash tags ----------------------------------------------
    nested = sorted(profile.native_feature_map(TS).items())
    tag10, tag12 = hash_python.generate_feature_hash_tags(dict(nested), TS)
    vectors["feature_hash_tags"] = {
        "input": {str(k): v for k, v in nested},
        "tag10": tag10,
        "tag12": tag12,
        "buffer_hex": hash_python.build_feature_hash_buffer(
            dict(nested), TS
        ).hex(),
    }

    # ---- jce writer primitives ------------------------------------------
    w = jce.JceWriter()
    w.byte(0, 0)
    w.byte(1, 7)
    w.byte(2, -1)
    w.short(3, 300)
    w.short(4, -300)
    w.int32(5, 70000)
    w.int64(6, 5_000_000_000)
    w.int64(7, 1_760_000_000_000)
    w.string(8, "")
    w.string(9, "x" * 255)
    w.string(10, "x" * 256)
    w.string(14, "high-tag")
    w.string(20, "tag20")
    w.map_int_string(11, [(2, "model"), (1, "brand"), (3, "chan")])
    w.int32(1, 0)
    w.map_int_string(12, [])
    vectors["jce_primitives_hex"] = w.finish().hex()

    # ---- m90 mode-1 body -------------------------------------------------
    identity = profile.identity()
    tag10, tag12 = hash_python.generate_feature_hash_tags(dict(nested), TS)
    uid = feature[2018]
    process_context = f"{identity.package_name}:tools,{uid},untrusted_app,{uid},,init"
    nested_bytes = jce.serialize_turing_nested(
        timestamp_ms=TS,
        metadata={0: 90, 1: "90", 2: "77F2B17A00A92C71", 3: "10000191", 4: 2},
        feature_values=nested,
        network=("3.2.3,113", identity.package_name),
        direct_values=[
            (3, str(feature[303])),
            (8, str(feature[308])),
            (9, str(feature[309])),
            (7, process_context),
            (10, tag10),
            (12, tag12),
            (4, profile.direct_performance_context(TS)),
        ],
        extra_map_values=[(2, "")],
        type8_values={
            1: feature.get(405, ""),
            2: feature.get(402, ""),
            3: feature.get(403, "0"),
            4: feature.get(404, ""),
            5: feature.get(401, ""),
            8: device_token._tail_map(feature.get(406, "")),
        },
    )
    vectors["nested_hex"] = nested_bytes.hex()

    m90 = jce.serialize_m90_full(
        channel=identity.channel,
        brand=identity.brand,
        model=identity.model,
        timestamp_ms=TS,
        cache_flag=1,
        nested_fields=nested_bytes,
        context_value=identity.package_name,
        status_code=-22056,
        status_text="-22056",
        extra_field="Z" * 32,
    )
    vectors["m90_hex"] = m90.hex()

    # ---- xxtea / mode0 / mode1 envelope ---------------------------------
    xxtea_key = b"0123456789abcdef"
    plain = b"\x02" + m90
    vectors["xxtea"] = {
        "key_ascii": xxtea_key.decode(),
        "plain_hex": plain.hex(),
        "cipher_hex": jce.xxtea_encrypt(plain, xxtea_key).hex(),
    }
    vectors["xxtea_default_key"] = {
        "plain_hex": b"hello turing".hex(),
        "cipher_hex": jce.xxtea_encrypt(b"hello turing", None).hex(),
    }
    vectors["mode0_token"] = jce.encode_mode0(m90, timestamp_ms=TS)
    vectors["mode1_nested_hex"] = jce.encode_mode1(
        m90, random_key=xxtea_key
    )
    vectors["mode1_components"] = {
        "deflated_hex": __import__("zlib").compress(plain).hex(),
    }

    # ---- SGCC envelope crypto -------------------------------------------
    vectors["json"] = {
        "cases": [
            {"in": {"a": 1, "b": "中文", "c": [1, 2]}, "out": crypto.compact_json({"a": 1, "b": "中文", "c": [1, 2]})},
            {"in": {}, "out": crypto.compact_json({})},
            {"in": {"z": None, "t": True}, "out": crypto.compact_json({"z": None, "t": True})},
        ]
    }

    key_text = "0123456789abcdef0123456789abcdef"
    sm4_cases = ["hello", "", "中文测试", "x" * 200]
    vectors["sm4"] = {
        "key_text": key_text,
        "cases": [
            {"plain": p, "cipher_hex": crypto.sm4_encrypt_hex(p, key_text)} for p in sm4_cases
        ],
    }

    vectors["sm3"] = [
        {"in": s, "out": crypto.sm3_hex(s)} for s in ["", "hello", "中文", "x" * 300]
    ]

    data_hex = vectors["sm4"]["cases"][0]["cipher_hex"]
    vectors["envelope"] = {
        "key_text": key_text,
        "timestamp": str(TS),
        "data": data_hex,
        "sign": crypto.envelope_sign("SK" * 10, data_hex, str(TS)),
    }
    fixed = crypto.build_request_envelope(
        {"phone": "13800000000", "password": "x"},
        const.SERVER_PUBLIC_KEY_HEX,
        timestamp=str(TS),
        key_text=key_text,
    )
    vectors["build_request_envelope"] = {
        "payload": {"phone": "13800000000", "password": "x"},
        "key_text": key_text,
        "timestamp": str(TS),
        "data": fixed["data"],
        "sign": fixed["sign"],
        "skey_prefix": fixed["skey"][:2],
        "skey_len": len(fixed["skey"]),
    }

    # ---- SM2 round trip (client keypair, both directions) ---------------
    priv = const.CLIENT_PRIVATE_KEY_HEX
    pub = crypto.derive_public_key(priv)
    py_cipher = crypto.sm2_encrypt_key(key_text, "04" + pub)
    vectors["sm2"] = {
        "client_private_key": priv,
        "client_public_key": pub,
        "plaintext": key_text,
        "python_cipher_hex": py_cipher,
        "cipher_format": "04 || C1C2C3(no) C1C3C2, lowercase hex",
    }

    return vectors


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True, help="path to hass-state-grid checkout")
    ap.add_argument("--out", default="tests/golden-vectors.json")
    args = ap.parse_args()

    ref = pathlib.Path(args.ref).resolve()
    vectors = build_vectors(ref)
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(vectors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    print(f"keys: {', '.join(vectors)}")


if __name__ == "__main__":
    main()
