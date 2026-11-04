/**
 * 主进程与设置页共用的纯函数：估算、摘要、脱敏、地区提取。
 *
 * 为什么不放 platform.ts / gateway.js 里：这两者跑在不同进程，但都要
 * 对同一份快照做同样的摘要，抽到这里避免两份逻辑漂移。这个模块不 import
 * 任何 Homebridge 东西，所以设置页（`require dist/services/summary.js`）也能用。
 */

import type { AccountSnapshot } from '../sgcc/types.js';

import { billingStatistics } from './billing-statistics.js';
import { chargeEstimate, usagePeriod } from './billing-estimate.js';
export { estimateCharge } from './billing-estimate.js';

/**
 * 把 AccountSnapshot 扁平化成可落盘、可展示的摘要。
 * 缺字段统一转 `null`（不补 0），`dailySeries` 只存条数，不把整条序列塞进缓存。
 */
export function summarizeSnapshot(snapshot: AccountSnapshot): Record<string, unknown> {
  const estimate = chargeEstimate(snapshot);
  const period = usagePeriod(snapshot);
  return {
    consNo: snapshot.consNo,
    latestDailyUsage: snapshot.latestDailyUsage ?? null,
    latestDailyDate: snapshot.latestDailyDate ?? null,
    currentMonthUsage: snapshot.currentMonthUsage ?? null,
    currentMonth: period.month ?? null,
    currentMonthLabel: `${period.prefix}用电`,
    currentMonthThrough: snapshot.currentMonthThrough ?? null,
    currentMonthPartial: snapshot.currentMonthPartial ?? null,
    latestMonth: snapshot.latestMonth ?? null,
    latestMonthUsage: snapshot.latestMonthUsage ?? null,
    latestMonthCharge: snapshot.latestMonthCharge ?? null,
    currentYearUsage: snapshot.currentYearUsage ?? null,
    currentYearCharge: snapshot.currentYearCharge ?? null,
    balance: snapshot.balance ?? null,
    amountDue: snapshot.amountDue ?? null,
    latestPeakUsage: snapshot.latestPeakUsage ?? null,
    latestValleyUsage: snapshot.latestValleyUsage ?? null,
    latestFlatUsage: snapshot.latestFlatUsage ?? null,
    latestSharpUsage: snapshot.latestSharpUsage ?? null,
    monthPeakUsage: snapshot.monthPeakUsage ?? null,
    monthValleyUsage: snapshot.monthValleyUsage ?? null,
    monthFlatUsage: snapshot.monthFlatUsage ?? null,
    monthSharpUsage: snapshot.monthSharpUsage ?? null,
    ladderLevel: snapshot.ladderLevel ?? null,
    penalty: snapshot.penalty ?? null,
    historyOwe: snapshot.historyOwe ?? null,
    estimate: estimate.value ?? null,
    estimateInfo: estimate,
    statistics: billingStatistics(snapshot),
    updatedAt: snapshot.updatedAt,
    seriesDays: snapshot.dailySeries?.length ?? 0,
  };
}

/** 户号脱敏：`1234567890` → `1234…7890`。 */
export function maskConsNo(value: string): string {
  const text = String(value);
  return text.length > 8 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
}

/** 手机号脱敏：`13800138000` → `138****8000`。 */
export function maskPhone(value: string): string {
  const text = String(value);
  return text.length >= 11 ? `${text.slice(0, 3)}****${text.slice(-4)}` : text;
}

/**
 * 从脱敏地址提取地区（省/市/区），去掉 `*` 及之后的详细地址与省级前缀。
 * 户号名只显示地区，不暴露脱敏真实姓名。
 */
export function regionFromAddress(address: string): string {
  const prefix = (address || '').split('*')[0].trim();
  // 只保留行政区划，省份也可显示；不把街道、门牌拼到卡片上。
  const match = /^(?:[\u4e00-\u9fa5]{2,12}?(?:省|自治区|特别行政区))?(?:[\u4e00-\u9fa5]{2,10}?(?:市|自治州|地区|盟))?(?:[\u4e00-\u9fa5]{1,10}?区|[\u4e00-\u9fa5]{1,10}?县|[\u4e00-\u9fa5]{1,10}?旗)?/.exec(prefix);
  const region = match?.[0] || '';
  return /社区$|小区$/.test(region) ? region.slice(0, region.lastIndexOf('市') + 1) : region;
}
