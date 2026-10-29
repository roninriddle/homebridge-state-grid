/**
 * 卡片指标的字段模型。
 *
 * 网上国网能拿到的指标全部集中在这里，显示哪些、按什么顺序显示，由
 * config.json 的 `fields` 数组决定（数组顺序 = 显示顺序，不在数组里 = 不显示）。
 * 分时（峰/谷/平/尖）字段来自日用电接口的 thisPPq/thisVPq/thisNPq/thisTPq，
 * 阶梯档位来自月账单的 levelStdCode，违约金/历史欠费来自余额接口。
 */

export const FIELD_KEYS = [
  'balance',
  'monthEstimateCharge',
  'currentMonthUsage',
  'latestDailyUsage',
  'latestPeakUsage',
  'latestValleyUsage',
  'latestFlatUsage',
  'latestSharpUsage',
  'latestMonthUsage',
  'latestMonthCharge',
  'currentYearUsage',
  'currentYearCharge',
  'monthPeakUsage',
  'monthValleyUsage',
  'monthFlatUsage',
  'monthSharpUsage',
  'ladderLevel',
  'penalty',
  'historyOwe',
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

export type FieldUnit = '元' | 'kWh' | '档';

export interface FieldMeta {
  /** 卡片上显示的标题。balance 的标题会按户号类型动态改为「应交电费」。 */
  label: string;
  unit: FieldUnit;
  /** 是否为估算值，仅在标题未包含预估含义时追加标记。 */
  estimated?: boolean;
}

export const FIELD_META: Record<FieldKey, FieldMeta> = {
  balance: { label: '账户余额', unit: '元' },
  monthEstimateCharge: { label: '本月预估电费', unit: '元', estimated: true },
  currentMonthUsage: { label: '当月用电', unit: 'kWh' },
  latestDailyUsage: { label: '上日用电', unit: 'kWh' },
  latestPeakUsage: { label: '上日峰用电', unit: 'kWh' },
  latestValleyUsage: { label: '上日谷用电', unit: 'kWh' },
  latestFlatUsage: { label: '上日平用电', unit: 'kWh' },
  latestSharpUsage: { label: '上日尖用电', unit: 'kWh' },
  latestMonthUsage: { label: '上月用电', unit: 'kWh' },
  latestMonthCharge: { label: '上月电费', unit: '元' },
  currentYearUsage: { label: '年累计用电', unit: 'kWh' },
  currentYearCharge: { label: '年累计电费', unit: '元' },
  monthPeakUsage: { label: '当月峰用电', unit: 'kWh' },
  monthValleyUsage: { label: '当月谷用电', unit: 'kWh' },
  monthFlatUsage: { label: '当月平用电', unit: 'kWh' },
  monthSharpUsage: { label: '当月尖用电', unit: 'kWh' },
  ladderLevel: { label: '当前阶梯', unit: '档' },
  penalty: { label: '违约金', unit: '元' },
  historyOwe: { label: '历史欠费', unit: '元' },
};

/**
 * 默认展示顺序：账户余额做主数字，本月预估电费与之并列，
 * 其余进入网格。上日分时紧跟「上日用电」，其余分时/阶梯/违约金默认不显示，
 * 用户可在设置页自行添加。
 */
export const DEFAULT_FIELD_ORDER: FieldKey[] = [
  'balance',
  'monthEstimateCharge',
  'currentMonthUsage',
  'latestDailyUsage',
  'latestPeakUsage',
  'latestValleyUsage',
  'latestFlatUsage',
  'latestSharpUsage',
  'latestMonthUsage',
  'latestMonthCharge',
  'currentYearUsage',
  'currentYearCharge',
];

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
