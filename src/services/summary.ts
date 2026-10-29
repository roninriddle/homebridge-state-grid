/**
 * 主进程与设置页共用的纯函数：估算、摘要、脱敏、地区提取。
 *
 * 为什么不放 platform.ts / gateway.js 里：这两者跑在不同进程，但都要
 * 对同一份快照做同样的摘要，抽到这里避免两份逻辑漂移。这个模块不 import
 * 任何 Homebridge 东西，所以设置页（`require dist/services/summary.js`）也能用。
 */

import type { AccountSnapshot } from '../sgcc/types.js';

/**
 * 本月电费估算：用最近结算月的**实际均价**反推，而不是硬编码阶梯电价。
 *
 * 这样能自动适配地区差异，误差比固定电价小得多，但仍然只是估算——
 * 卡片上必须带"估算"字样。
 */
export function estimateCharge(snapshot: AccountSnapshot): number | undefined {
  const { latestMonthCharge, latestMonthUsage, currentMonthUsage } = snapshot;
  if (latestMonthCharge === undefined || latestMonthUsage === undefined || currentMonthUsage === undefined || latestMonthUsage <= 0) return undefined;
  const unitPrice = latestMonthCharge / latestMonthUsage;
  if (!Number.isFinite(unitPrice) || unitPrice < 0) return undefined;
  return Math.round(currentMonthUsage * unitPrice * 100) / 100;
}

/**
 * 把 AccountSnapshot 扁平化成可落盘、可展示的摘要。
 * 缺字段统一转 `null`（不补 0），`dailySeries` 只存条数，不把整条序列塞进缓存。
 */
export function summarizeSnapshot(snapshot: AccountSnapshot): Record<string, unknown> {
  return {
    consNo: snapshot.consNo,
    latestDailyUsage: snapshot.latestDailyUsage ?? null,
    latestDailyDate: snapshot.latestDailyDate ?? null,
    currentMonthUsage: snapshot.currentMonthUsage ?? null,
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
    estimate: estimateCharge(snapshot) ?? null,
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
  const region = (address || '').split('*')[0].trim();
  if (!region) return '';
  // 去掉省级前缀（如"河北省"→"石家庄市裕华区"）；直辖市（"北京市"）不含"省"，原样保留。
  return region.replace(/^[\u4e00-\u9fa5]{1,3}省/, '').trim();
}
