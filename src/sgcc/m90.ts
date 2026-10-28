/**
 * m90 嵌套体构造：把特征映射、性能上下文和哈希助手装配成 tag 4 结构。
 *
 * 单独成模块，是因为 device-token 与回归测试必须走**同一条**装配路径，
 * 否则测试通过也不代表线上 token 正确。
 */

import type { StableProfile } from './turing-profile.js';
import type { FeatureHashTags } from './hash.js';
import { BUILD_MARKER, CHANNEL, PACKAGE_NAME } from './turing-profile.js';
import { serializeTuringNested } from './jce.js';

/** 把 `3_1_x` 形式的值拆成 [key, value] 列表。 */
export function tailMap(value: string): Array<[number, string]> {
  const result: Array<[number, string]> = [];
  for (const entry of value.split(',')) {
    const sep = entry.indexOf('_');
    if (sep < 0) continue;
    const key = Number(entry.slice(0, sep));
    if (!Number.isInteger(key)) continue;
    result.push([key, entry.slice(sep + 1)]);
  }
  return result;
}

export function buildNestedStruct(
  profile: StableProfile,
  features: Map<number | string, string>,
  tags: FeatureHashTags,
  timestampMs: number,
): Buffer {
  const uid = features.get(2018) ?? '0';
  const processContext = `${PACKAGE_NAME}:tools,${uid},untrusted_app,${uid},,init`;

  const feature = (key: number): string => {
    const value = features.get(key);
    if (value === undefined) throw new Error(`feature ${key} missing`);
    return value;
  };

  return serializeTuringNested({
    timestampMs,
    metadata: { 0: 90, 1: '90', 2: BUILD_MARKER, 3: CHANNEL, 4: 2 },
    featureValues: [...profile.nativeFeatureMap(timestampMs).entries()].sort((a, b) => a[0] - b[0]),
    network: ['3.2.3,113', PACKAGE_NAME],
    directValues: [
      [3, feature(303)],
      [8, feature(308)],
      [9, feature(309)],
      [7, processContext],
      [10, tags.tag10],
      [12, tags.tag12],
      [4, profile.directPerformanceContext(timestampMs)],
    ],
    extraMapValues: [[2, '']],
    type8Values: {
      1: features.get(405) ?? '',
      2: features.get(402) ?? '',
      3: features.get(403) ?? '0',
      4: features.get(404) ?? '',
      5: features.get(401) ?? '',
      8: tailMap(features.get(406) ?? ''),
    },
  });
}
