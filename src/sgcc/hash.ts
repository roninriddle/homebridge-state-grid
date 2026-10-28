/**
 * 倒序无符号 64 位乘法哈希，复刻 TuringFD 原生 `sub_40f154`。
 *
 * 全部使用 BigInt，因为中间乘积会超过 2^53。测试用 `tests/golden-vectors.json`
 * 里由上游 Python 生成的向量逐字节校验。
 */

const MASK64 = (1n << 64n) - 1n;
const MULTIPLIER = 0xc6a4a7935bd1e995n;
const TAIL_CONST = 0x118727c03fb9ffc6n;
const LCG_MULTIPLIER = 214013n;
const LCG_INCREMENT = 2531011n;

function u64(value: bigint): bigint {
  return value & MASK64;
}

function mix47(value: bigint): bigint {
  const v = u64(value);
  return u64(v ^ (v >> 47n));
}

/** 读取小端 8 字节无符号整数。 */
function readLe64(data: Uint8Array, offset: number): bigint {
  let word = 0n;
  for (let i = 7; i >= 0; i--) {
    word = (word << 8n) | BigInt(data[offset + i]);
  }
  return word;
}

export function turingHash64(data: Uint8Array, seed = 0n): bigint {
  const length = BigInt(data.length);
  let state = u64(u64(length * MULTIPLIER) ^ u64(seed));

  const blocks = Math.floor(data.length / 8);
  for (let index = 0; index < blocks; index++) {
    let wordMix = mix47(u64(readLe64(data, index * 8) * MULTIPLIER));
    wordMix = u64(wordMix * MULTIPLIER);
    state = u64((wordMix ^ state) * MULTIPLIER);
  }

  const tailOffset = blocks * 8;
  const tailLength = data.length - tailOffset;
  const at = (i: number) => BigInt(data[tailOffset + i]);

  if (tailLength >= 7) state ^= at(6) << 48n;
  if (tailLength >= 6) state ^= at(5) << 40n;
  if (tailLength >= 5) state ^= at(4) << 32n;
  if (tailLength >= 4) state ^= at(3) << 24n;
  if (tailLength >= 3) state ^= at(2) << 16n;
  if (tailLength >= 2) state ^= TAIL_CONST & (at(1) << 8n);
  if (tailLength >= 1) state ^= at(0);
  if (tailLength > 0) state = u64(state * MULTIPLIER);

  state = mix47(state);
  state = u64(state * MULTIPLIER);
  return mix47(state);
}

/**
 * 复刻 `sub_439e3c` 的哈希缓冲区构造：按整数键升序拼接 UTF-8 值，
 * 然后每四个条目推进一次 15 位 LCG（种子为请求时间戳）。
 */
export function buildFeatureHashBuffer(
  features: ReadonlyMap<number, string> | Record<number, string>,
  timestampMs: number,
): Uint8Array {
  if (timestampMs < 0) throw new RangeError('timestampMs must be non-negative');
  const entries = toSortedEntries(features);
  const parts = entries.map(([, value]) => value);

  let state = BigInt(timestampMs);
  const groups = Math.ceil(entries.length / 4);
  for (let i = 0; i < groups; i++) {
    state = ((state * LCG_MULTIPLIER + LCG_INCREMENT) >> 16n) & 0x7fffn;
    parts.push(state.toString(16));
  }
  return Buffer.from(parts.join(''), 'utf8');
}

function toSortedEntries(
  features: ReadonlyMap<number, string> | Record<number, string>,
): Array<[number, string]> {
  const raw: Array<[number, string]> =
    features instanceof Map
      ? [...features.entries()]
      : Object.entries(features).map(([k, v]) => [Number(k), String(v)]);
  return raw.sort((a, b) => a[0] - b[0]);
}

export interface FeatureHashTags {
  tag10: string;
  tag12: string;
}

/** 返回直接映射用的 tag-10 / tag-12 摘要值。 */
export function generateFeatureHashTags(
  features: ReadonlyMap<number, string> | Record<number, string>,
  timestampMs: number,
): FeatureHashTags {
  const buffer = buildFeatureHashBuffer(features, timestampMs);
  const digest = turingHash64(buffer).toString(16);
  return { tag10: `01${digest}`, tag12: digest };
}
