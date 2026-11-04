/** 累计电费折算及时间口径；不是月底预测，也不模拟阶梯/峰谷计费。 */
import type { AccountSnapshot } from '../sgcc/types.js';
import { formatDate } from '../sgcc/payloads.js';

export interface ChargeEstimate {
  value?: number;
  label: string;
  note: string;
  month?: string;
  through?: string;
  referenceMonth?: string;
  unitPrice?: number;
  reason?: string;
}
function month(value: unknown): value is string {return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);}
function day(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function nonnegative(value: unknown): value is number {return typeof value === 'number' && Number.isFinite(value) && value >= 0;}
export function monthName(value: string, now = Date.now()): string {
  return (value.slice(0, 4) === formatDate(new Date(now)).slice(0, 4) ? '' : Number(value.slice(0, 4)) + '年') + Number(value.slice(5)) + '月';
}
export function usagePeriod(snapshot: AccountSnapshot, now = Date.now()) {
  const today = formatDate(new Date(now));
  const through = day(snapshot.currentMonthThrough) ? snapshot.currentMonthThrough : undefined;
  // 老缓存没有显式月份，优先使用电量截至日期；更新时间仅用于识别月份，不冒充数据截至日。
  const sampledMonth = Number.isFinite(snapshot.updatedAt) && snapshot.updatedAt > 0 ? formatDate(new Date(snapshot.updatedAt)).slice(0, 7) : undefined;
  const period = month(snapshot.currentMonth) ? snapshot.currentMonth : through?.slice(0, 7) || sampledMonth;
  const current = period === today.slice(0, 7);
  const prefix = period ? current ? '当月' : monthName(period, now) : '月份未知';
  return {month: period, through, today, current, prefix};
}
export function chargeEstimate(snapshot: AccountSnapshot, now = Date.now()): ChargeEstimate {
  const period = usagePeriod(snapshot, now);
  const reference = month(snapshot.latestMonth) ? snapshot.latestMonth : undefined;
  const result: ChargeEstimate = {label: period.month ? `${period.prefix}累计电费估算` : '累计电费估算（月份未知）',
    note: '', month: period.month, through: period.through, referenceMonth: reference};
  const unavailable = (reason: string) => ({...result, reason, note: reason});
  if (!period.month || !period.through) return unavailable('缺少电量截至日期，暂不估算');
  if (period.through.slice(0, 7) !== period.month || period.through > period.today) return unavailable('电量日期不一致，暂不估算');
  if (snapshot.currentMonthPartial !== false) return unavailable(snapshot.currentMonthPartial ? '电量不完整，暂不估算' : '电量覆盖范围未确认，暂不估算');
  const {currentMonthUsage: usage, latestMonthUsage: billedUsage, latestMonthCharge: billedCharge} = snapshot;
  if (!nonnegative(usage)) return unavailable('累计电量缺失或无效，暂不估算');
  if (!reference || reference >= period.month || !nonnegative(billedUsage) || billedUsage <= 0 || !nonnegative(billedCharge)) return unavailable('缺少有效参考账单，暂不估算');
  const unitPrice = billedCharge / billedUsage;
  const value = Math.round(usage * unitPrice * 100) / 100;
  if (!Number.isFinite(unitPrice) || !Number.isFinite(value)) return unavailable('估算结果无效');
  return {...result, value, unitPrice,
    note: `截至${period.through.slice(5)} · 参考${monthName(reference, now)}均价${unitPrice.toFixed(4)}元/度`};
}
export function estimateCharge(snapshot: AccountSnapshot): number | undefined {return chargeEstimate(snapshot).value;}
