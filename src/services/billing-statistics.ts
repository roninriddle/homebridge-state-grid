/** 结算月、同月份累计及同日区间对比。缺项不补零，不用整月替代部分月份。 */
import type { AccountSnapshot, MonthlyBill } from '../sgcc/types.js';
import { formatDate } from '../sgcc/payloads.js';

export function validMonth(value: unknown): value is string {return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);}
export function validDay(value:unknown):value is string {if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;}
export function nonnegative(value: unknown): value is number {return typeof value === 'number' && Number.isFinite(value) && value >= 0;}
export function shiftMonth(value: string, offset: number): string {
  const index = Number(value.slice(0,4)) * 12 + Number(value.slice(5)) - 1 + offset;
  return `${Math.floor(index / 12)}-${String((index % 12 + 12) % 12 + 1).padStart(2,'0')}`;
}
export function normalizeBills(input: unknown, before: string): MonthlyBill[] {
  if (!Array.isArray(input)) return [];
  const byMonth = new Map<string, MonthlyBill>();
  for (const raw of input) {
    if (!raw || !validMonth(raw.month) || raw.month >= before) continue;
    const previous = byMonth.get(raw.month);
    byMonth.set(raw.month, {month: raw.month,
      usage: nonnegative(raw.usage) ? raw.usage : previous?.usage,
      charge: nonnegative(raw.charge) ? raw.charge : previous?.charge,
      ladderLevel: nonnegative(raw.ladderLevel) ? raw.ladderLevel : previous?.ladderLevel});
  }
  return [...byMonth.values()].sort((a,b)=>a.month.localeCompare(b.month));
}
const rounded = (value: number) => Math.round(value * 100) / 100;
export function compare(current: number | undefined, previous: number | undefined) {
  if (!nonnegative(current) || !nonnegative(previous)) return {current, previous, change: undefined, percent: undefined, reason:'缺少可比数据'};
  const change=rounded(current-previous), percent=previous>0?rounded((current-previous)/previous*100):undefined;
  return {current,previous,change,percent: Number.isFinite(percent)?percent:undefined,reason:previous===0?'去年基期为0，暂无百分比':undefined};
}
export function billingStatistics(snapshot: AccountSnapshot, now=Date.now()) {
  const monthNow=formatDate(new Date(now)).slice(0,7);
  const bills=normalizeBills(snapshot.monthlyBills,monthNow);
  const byMonth=new Map(bills.map(b=>[b.month,b]));
  const latest=[...bills].reverse().find(b=>nonnegative(b.usage)||nonnegative(b.charge));
  const end=latest?.month;
  const previousMonth=end?shiftMonth(end,-12):undefined;
  const previousBill=previousMonth?byMonth.get(previousMonth):undefined;
  const monthly={month:end,previousMonth,usage:compare(latest?.usage,previousBill?.usage),charge:compare(latest?.charge,previousBill?.charge)};
  const year=Number(monthNow.slice(0,4)), throughMonth=end?.startsWith(year+'-')?Number(end.slice(5)):undefined;
  const expected=year&&throughMonth?Array.from({length:throughMonth},(_,i)=>`${year}-${String(i+1).padStart(2,'0')}`):[];
  const currentComplete=!!expected.length&&expected.every(m=>nonnegative(byMonth.get(m)?.usage));
  const previousComplete=!!expected.length&&expected.every(m=>nonnegative(byMonth.get(shiftMonth(m,-12))?.usage));
  const complete=currentComplete&&previousComplete;
  const currentTotal=currentComplete?rounded(expected.reduce((sum,m)=>sum+byMonth.get(m)!.usage!,0)):undefined;
  const previousTotal=previousComplete?rounded(expected.reduce((sum,m)=>sum+byMonth.get(shiftMonth(m,-12))!.usage!,0)):undefined;
  const cumulative={year,previousYear:year?year-1:undefined,throughMonth,complete,...compare(currentTotal,previousTotal),
    reason:complete?compare(currentTotal,previousTotal).reason:!throughMonth?'本年尚无已结算月份':'月份不齐，暂无同月份累计对比'};
  const period=snapshot.lastYearSamePeriod;
  const through=snapshot.currentMonthThrough;
  const start=through?through.slice(0,7)+'-01':undefined;
  const priorStart=start?String(Number(start.slice(0,4))-1)+start.slice(4):undefined;
  const priorEnd=through?String(Number(through.slice(0,4))-1)+through.slice(4):undefined;
  const currentDaysComplete=snapshot.currentMonthPartial===false&&validDay(through)&&through<=formatDate(new Date(now))&&nonnegative(snapshot.currentMonthUsage);
  const dayComparable=currentDaysComplete&&validDay(through)&&(!snapshot.currentMonth||through.startsWith(snapshot.currentMonth))&&validDay(priorEnd)&&!!period&&period.complete&&period.start===priorStart&&period.end===priorEnd;
  const monthToDate={start,through,previousStart:priorStart,previousThrough:priorEnd,...compare(currentDaysComplete?snapshot.currentMonthUsage:undefined,dayComparable?period?.usage:undefined),
    reason:dayComparable?compare(snapshot.currentMonthUsage,period?.usage).reason:'缺少完整的同日区间电量'};
  const trendEnd=end||shiftMonth(monthNow,-1);
  const trend=Array.from({length:12},(_,i)=>{const month=shiftMonth(trendEnd,i-11),bill=byMonth.get(month);return {month,usage:bill?.usage??null,charge:bill?.charge??null};});
  return {monthly,cumulative,monthToDate,trend,trendThrough:trendEnd,historyUpdatedAt:snapshot.historyUpdatedAt||null,
    historyUnavailable:snapshot.historyUnavailable===true,hasHistory:!!latest};
}
export type BillingStatistics=ReturnType<typeof billingStatistics>;
