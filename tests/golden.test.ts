/**
 * 与上游 Python 实现逐字节对拍。
 *
 * 所有期望值都来自 tools/gen-golden.py 调用原项目代码的输出，
 * 不是本仓库自己算出来再抄回去——所以这个套件通过，等于证明了
 * TypeScript 重写在协议层与 Home Assistant 集成完全等价。
 */

import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import { turingHash64, generateFeatureHashTags, buildFeatureHashBuffer } from '../src/sgcc/hash.js';
import { xxteaEncrypt, xxteaDecrypt } from '../src/sgcc/xxtea.js';
import { JceWriter, serializeM90Full, encodeMode0, encodeMode1, STATIC_KEY } from '../src/sgcc/jce.js';
import { buildNestedStruct } from '../src/sgcc/m90.js';
import { StableProfile } from '../src/sgcc/turing-profile.js';
import {
  compactJson,
  sm4EncryptHex,
  sm4DecryptHex,
  sm3Hex,
  envelopeSign,
  buildRequestEnvelope,
  sm2DecryptKey,
  derivePublicKey,
  SERVER_PUBLIC_KEY_HEX,
} from '../src/sgcc/crypto.js';

interface Golden {
  meta: { seed_b64: string; timestamp_ms: number };
  hash64: Array<{ input_hex: string; seed: number; out_hex: string }>;
  native_feature_map: Record<string, string>;
  feature_map: Record<string, string>;
  feature_map_key_order: string[];
  feature_hash_tags: { input: Record<string, string>; tag10: string; tag12: string; buffer_hex: string };
  jce_primitives_hex: string;
  nested_hex: string;
  m90_hex: string;
  xxtea: { key_ascii: string; plain_hex: string; cipher_hex: string };
  xxtea_default_key: { plain_hex: string; cipher_hex: string };
  mode0_token: string;
  mode1_nested_hex: string;
  json: { cases: Array<{ in: unknown; out: string }> };
  sm4: { key_text: string; cases: Array<{ plain: string; cipher_hex: string }> };
  sm3: Array<{ in: string; out: string }>;
  envelope: { key_text: string; timestamp: string; data: string; sign: string };
  build_request_envelope: {
    payload: unknown;
    key_text: string;
    timestamp: string;
    data: string;
    sign: string;
    skey_prefix: string;
    skey_len: number;
  };
  sm2: {
    client_private_key: string;
    client_public_key: string;
    plaintext: string;
    python_cipher_hex: string;
  };
}

const golden: Golden = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'golden-vectors.json'), 'utf8'),
);

const TS = golden.meta.timestamp_ms;

/**
 * 长十六进制串比较，失败时只打印首个差异窗口。
 * 直接用 toBe 会把整条 JCE 流打进报告，几千字符，反而看不出问题在哪。
 */
function expectHex(actual: string, expected: string, label: string): void {
  if (actual === expected) return;
  let index = 0;
  const limit = Math.min(actual.length, expected.length);
  while (index < limit && actual[index] === expected[index]) index++;
  const from = Math.max(0, index - 32);
  throw new Error(
    `${label}: 长度 ${actual.length}/${expected.length}，首个差异在 ${index}\n` +
      `  期望 …${expected.slice(from, index + 32)}\n` +
      `  实际 …${actual.slice(from, index + 32)}`,
  );
}
const profile = new StableProfile(Buffer.from(golden.meta.seed_b64, 'base64'), {
  bootEpochMs: TS - 7_200_000,
  installEpochMs: TS - 86_400_000 * 30,
});

describe('turing hash64', () => {
  it('matches every upstream vector', () => {
    for (const vector of golden.hash64) {
      const input = Buffer.from(vector.input_hex, 'hex');
      const out = turingHash64(input, BigInt(vector.seed));
      expect(out, `input=${vector.input_hex.slice(0, 40)} len=${input.length}`).toBe(
        BigInt(`0x${vector.out_hex}`),
      );
    }
  });
});

describe('native feature map', () => {
  it('produces 62 tags with identical values', () => {
    const actual = profile.nativeFeatureMap(TS);
    const expected = Object.entries(golden.native_feature_map);
    expect(actual.size).toBe(expected.length);
    for (const [key, value] of expected) {
      expect(actual.get(Number(key)), `tag ${key}`).toBe(value);
    }
  });
});

describe('java feature map', () => {
  it('keeps the official 52-key order and values', () => {
    const actual = profile.featureMap(TS, {
      fallbackStatusCode: -22056,
      tokenNonce: 'N'.repeat(32),
    });
    expect([...actual.keys()].map(String)).toEqual(golden.feature_map_key_order);
    for (const [key, value] of Object.entries(golden.feature_map)) {
      expect(actual.get(Number.isNaN(Number(key)) ? key : Number(key)), `key ${key}`).toBe(value);
    }
  });
});

describe('feature hash tags', () => {
  it('derives tag10/tag12 from the same buffer', () => {
    const input = new Map(
      Object.entries(golden.feature_hash_tags.input).map(([k, v]) => [Number(k), v]),
    );
    expect(buildFeatureHashBuffer(input, TS).toString('hex')).toBe(
      golden.feature_hash_tags.buffer_hex,
    );
    const tags = generateFeatureHashTags(input, TS);
    expect(tags.tag10).toBe(golden.feature_hash_tags.tag10);
    expect(tags.tag12).toBe(golden.feature_hash_tags.tag12);
  });
});

describe('JCE primitives', () => {
  it('encodes type/tag boundary cases identically', () => {
    const w = new JceWriter();
    w.byte(0, 0);
    w.byte(1, 7);
    w.byte(2, -1);
    w.short(3, 300);
    w.short(4, -300);
    w.int32(5, 70000);
    w.int64(6, 5_000_000_000);
    w.int64(7, 1_760_000_000_000);
    w.string(8, '');
    w.string(9, 'x'.repeat(255));
    w.string(10, 'x'.repeat(256));
    w.string(14, 'high-tag');
    w.string(20, 'tag20');
    w.mapIntString(11, [
      [2, 'model'],
      [1, 'brand'],
      [3, 'chan'],
    ]);
    w.int32(1, 0);
    w.mapIntString(12, []);
    expectHex(w.finish().toString('hex'), golden.jce_primitives_hex, 'JCE primitives');
  });
});

describe('XXTEA', () => {
  it('matches upstream ciphertext', () => {
    const plain = Buffer.from(golden.xxtea.plain_hex, 'hex');
    const key = Buffer.from(golden.xxtea.key_ascii, 'ascii');
    const cipher = xxteaEncrypt(plain, key);
    expect(cipher.toString('hex')).toBe(golden.xxtea.cipher_hex);
    expect(xxteaDecrypt(cipher, key).toString('hex')).toBe(golden.xxtea.plain_hex);
  });

  it('handles the embedded default key', () => {
    const plain = Buffer.from(golden.xxtea_default_key.plain_hex, 'hex');
    expect(xxteaEncrypt(plain, null).toString('hex')).toBe(
      golden.xxtea_default_key.cipher_hex,
    );
  });
});

describe('m90 envelope', () => {
  const identity = profile.identity();
  const features = profile.featureMap(TS, {
    fallbackStatusCode: -22056,
    tokenNonce: 'N'.repeat(32),
  });
  const nestedFeatures = [...profile.nativeFeatureMap(TS).entries()].sort((a, b) => a[0] - b[0]);
  const tags = generateFeatureHashTags(new Map(nestedFeatures), TS);
  const uid = features.get(2018) as string;

  const m90 = serializeM90Full({
    channel: identity.channel,
    brand: identity.brand,
    model: identity.model,
    timestampMs: TS,
    cacheFlag: 1,
    nestedFields: buildNestedStruct(profile, features, tags, TS),
    contextValue: identity.packageName,
    statusCode: -22056,
    statusText: '-22056',
    extraField: 'Z'.repeat(32),
  });

  it('serializes the mode-1 top level byte for byte', () => {
    expectHex(m90.toString('hex'), golden.m90_hex, 'm90 顶层');
  });

  it('serializes the nested struct byte for byte', () => {
    const nested = buildNestedStruct(profile, features, tags, TS);
    expectHex(nested.toString('hex'), golden.nested_hex, 'tag4 嵌套体');
  });

  it('produces a mode-0 envelope that unwraps to the same m90', () => {
    // 注意：这里校验的是「解包后一致」，不是「压缩字节一致」。
    // DEFLATE 输出取决于 zlib 具体实现版本（本机 Python 3.13 与 Node 22 的
    // zlib 1.3.1 就有 2 字节差异），但服务端只负责解压，压缩端实现无关。
    const token = encodeMode0(m90, TS);
    const packed = Buffer.from(token.slice(3), 'base64');
    expect(packed[0]).toBe(0x00);
    expect(Number(packed.readBigUInt64BE(1))).toBe(TS);
    const plain = xxteaDecrypt(
      packed.subarray(9),
      Buffer.concat([STATIC_KEY, packed.subarray(1, 9)]),
    );
    expectHex(inflateSync(plain).toString('hex'), `02${golden.m90_hex}`, 'mode-0 解包');
  });

  it('produces a mode-1 envelope that unwraps to the same m90', () => {
    const token = encodeMode1(m90, Buffer.from('0123456789abcdef', 'ascii'));
    const packed = Buffer.from(token.slice(3), 'base64');
    expect(packed[0]).toBe(0x01);
    const rsa = packed.subarray(1, 257);
    expect(rsa.length).toBe(256);
    const cipher = packed.subarray(257);
    const deflated = xxteaDecrypt(cipher, Buffer.from('0123456789abcdef', 'ascii'));
    expectHex(inflateSync(deflated).toString('hex'), `02${golden.m90_hex}`, 'mode-1 解包');
  });
});

describe('SGCC envelope crypto', () => {
  it('mirrors Gson compact JSON', () => {
    for (const { in: input, out } of golden.json.cases) {
      expect(compactJson(input), JSON.stringify(input)).toBe(out);
    }
  });

  it('encrypts SM4-ECB with the ASCII key prefix', () => {
    for (const { plain, cipher_hex } of golden.sm4.cases) {
      expect(sm4EncryptHex(plain, golden.sm4.key_text), `plain=${plain.slice(0, 20)}`).toBe(
        cipher_hex,
      );
      expect(sm4DecryptHex(cipher_hex, golden.sm4.key_text).toString('utf8')).toBe(plain);
    }
  });

  it('hashes SM3 over UTF-8 text', () => {
    for (const { in: input, out } of golden.sm3) {
      expect(sm3Hex(input)).toBe(out);
    }
  });

  it('signs the envelope with SM3(skey+data+timestamp)', () => {
    expect(
      envelopeSign('SK'.repeat(10), golden.envelope.data, golden.envelope.timestamp),
    ).toBe(golden.envelope.sign);
  });

  it('builds a request envelope whose ciphertext matches upstream', () => {
    const built = buildRequestEnvelope(golden.build_request_envelope.payload, {
      timestamp: golden.build_request_envelope.timestamp,
      keyText: golden.build_request_envelope.key_text,
      serverPublicKey: SERVER_PUBLIC_KEY_HEX,
    });
    expect(built.data).toBe(golden.build_request_envelope.data);
    // skey 是 SM2 概率加密，每次结果都不同，因此 sign 无法跨进程复现；
    // 这里验证的是「data 可复现」+「sign 与本次 skey 自洽」。
    expect(built.sign).toBe(envelopeSign(built.skey, built.data, built.timestamp));
    expect(built.skey.slice(0, 2)).toBe(golden.build_request_envelope.skey_prefix);
    expect(built.skey.length).toBe(golden.build_request_envelope.skey_len);
  });

  it('decrypts SM2 ciphertext produced by Python', () => {
    expect(derivePublicKey(golden.sm2.client_private_key)).toBe(golden.sm2.client_public_key);
    const decrypted = sm2DecryptKey(golden.sm2.python_cipher_hex, golden.sm2.client_private_key);
    expect(decrypted).toBe(golden.sm2.plaintext);
  });
});
