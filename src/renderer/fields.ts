/**
 * 卡片指标的字段模型。
 *
 * 网上国网能拿到的指标有 8 项，卡片上显示哪些、按什么顺序显示，全部由
 * config.json 的 `fields` 数组决定（数组顺序 = 显示顺序，不在数组里 = 不显示）。
 * 这里集中定义字段 key、中文标题、单位与默认顺序，供渲染器和平台层共用。
 */

export const FIELD_KEYS = [
  'balance',
  'monthEstimateCharge',
  'currentMonthUsage',
  'latestDailyUsage',
  'latestMonthUsage',
  'currentYearUsage',
  'currentYearCharge',
  'latestMonthCharge',
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

export interface FieldMeta {
  /** 卡片上显示的标题。balance 的标题会按户号类型动态改为「应交电费」。 */
  label: string;
  unit: '元' | 'kWh';
  /** 是否为估算值，渲染时标题会追加「· 估算」。 */
  estimated?: boolean;
}

export const FIELD_META: Record<FieldKey, FieldMeta> = {
  balance: { label: '账户余额', unit: '元' },
  monthEstimateCharge: { label: '本月预估电费', unit: '元', estimated: true },
  currentMonthUsage: { label: '当月用电', unit: 'kWh' },
  latestDailyUsage: { label: '上日用电', unit: 'kWh' },
  latestMonthUsage: { label: '上月用电', unit: 'kWh' },
  currentYearUsage: { label: '年累计用电', unit: 'kWh' },
  currentYearCharge: { label: '年累计电费', unit: '元' },
  latestMonthCharge: { label: '上月电费', unit: '元' },
};

/** 默认展示顺序：账户余额做主数字，本月预估电费与之并列，其余进网格。 */
export const DEFAULT_FIELD_ORDER: FieldKey[] = [...FIELD_KEYS];

function isFieldKey(value: string): value is FieldKey {
  return (FIELD_KEYS as readonly string[]).includes(value);
}

/**
 * 把 config.json 里的 `fields` 归一化成有序的 key 数组。
 *
 * 兼容两种写法：`["balance", ...]`（字符串数组）和
 * `[{ "key": "balance" }, ...]`（设置页 array-of-object 的产物）。
 * 非法 key 丢弃、重复项去重（保留首次出现位置）；结果为空调回默认顺序，
 * 避免配置写坏后卡片变成空白。
 */
export function normalizeFieldOrder(input: unknown): FieldKey[] {
  if (!Array.isArray(input)) return [...DEFAULT_FIELD_ORDER];
  const result: FieldKey[] = [];
  const seen = new Set<FieldKey>();
  for (const item of input) {
    let raw: string;
    if (typeof item === 'string') raw = item;
    else if (item && typeof item === 'object') raw = String((item as Record<string, unknown>).key ?? '');
    else continue;
    if (isFieldKey(raw) && !seen.has(raw)) {
      seen.add(raw);
      result.push(raw);
    }
  }
  return result.length ? result : [...DEFAULT_FIELD_ORDER];
}
