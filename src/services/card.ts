/** 预览、快照、视频共用的数据转换；不取数、不写配置。 */
import type { AccountSnapshot } from '../sgcc/types.js';
import type { CardData } from '../renderer/card-svg.js';
import type { FieldKey } from '../renderer/fields.js';
import { estimateCharge } from './summary.js';

export function snapshotToCard(snapshot: AccountSnapshot, options: {title: string; region?: string; theme?: 'light' | 'dark'; fields?: FieldKey[]; staleNote?: string}): CardData {
  return {
    ...snapshot,
    ...options,
    primaryValue: snapshot.balance ?? snapshot.amountDue,
    primaryLabel: snapshot.balance !== undefined ? '账户余额' : '应交电费',
    monthEstimateCharge: estimateCharge(snapshot),
    dailySeries: snapshot.dailySeries ?? [],
  };
}

export function cachedSnapshot(value: unknown): AccountSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!Number.isFinite(raw.updatedAt)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(raw)) if (item !== null) result[key] = item;
  result.dailySeries = Array.isArray(raw.dailySeries) ? raw.dailySeries : [];
  return result as unknown as AccountSnapshot;
}
