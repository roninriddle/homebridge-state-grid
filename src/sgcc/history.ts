/** 历史查询按账户与区间缓存，历史失败不污染当前读数。只调用已有协议客户端。 */
import type { AccountSnapshot, MonthlyBill, PowerAccount } from './types.js';
import type { StateGridClient } from './client.js';
import { StateGridApiError, StateGridError } from './types.js';
import { nonnegative, normalizeBills, shiftMonth, validDay } from '../services/billing-statistics.js';

const TTL=24*3600000;
function canRetain(error:unknown) {return !(error instanceof StateGridError)||error instanceof StateGridApiError||error.name==='StateGridNetworkError';}
export async function queryBillingHistory(client: Pick<StateGridClient,'queryMonthlyBills'|'queryDailyUsage'>,account:PowerAccount,currentBills:MonthlyBill[],snapshot:AccountSnapshot,previous?:AccountSnapshot,currentFailed=false) {
  const now=Date.now(),month=snapshot.currentMonth!,year=Number(month.slice(0,4));
  const prior=previous?.consNo===account.consNoSrc?previous:undefined;
  const checks={...prior?.billingHistoryChecks};
  let bills=normalizeBills([...(prior?.monthlyBills||[]),...currentBills.filter(b=>b.month.startsWith(year+'-'))],month);
  let unavailable=currentFailed||currentBills.some(b=>!b.month.startsWith(year+'-'));
  const loadYear=async(target:number)=>{
    if(target===year)return;
    const checked=checks[String(target)];
    if(Number.isFinite(checked)&&checked<=now&&now-checked<TTL)return;
    try {const result=await client.queryMonthlyBills(account,target);
      const matching=result.filter(b=>b.month.startsWith(target+'-'));
      if(result.length&&!matching.length){unavailable=true;return;}
      bills=normalizeBills([...bills,...matching],month);checks[String(target)]=now;
    }catch(error){if(!canRetain(error))throw error;unavailable=true;}
  };
  await loadYear(year-1);
  const latest=[...bills].reverse().find(b=>nonnegative(b.usage)||nonnegative(b.charge));
  if(latest)await loadYear(Number(latest.month.slice(0,4))-1);
  let samePeriod=prior?.lastYearSamePeriod;
  const through=snapshot.currentMonthThrough;
  if(snapshot.currentMonthPartial===false&&through&&through.startsWith(month)) {
    const end=String(year-1)+through.slice(4),start=String(year-1)+month.slice(4)+'-01';
    const validDate=Number.isFinite(new Date(end+'T00:00:00Z').getTime())&&new Date(end+'T00:00:00Z').toISOString().slice(0,10)===end;
    if(validDate&&(!samePeriod||samePeriod.start!==start||samePeriod.end!==end||samePeriod.queriedAt>now||now-samePeriod.queriedAt>=TTL)) {
      try {const readings=await client.queryDailyUsage(account,start,end);
        const matching=[...new Map(readings.filter(r=>validDay(r.date)&&r.date>=start&&r.date<=end&&nonnegative(r.usage)).map(r=>[r.date,r])).values()].sort((a,b)=>a.date.localeCompare(b.date));
        const allInRange=readings.every(r=>r.date>=start&&r.date<=end);
        const completeDays=matching.length===Number(end.slice(-2))&&matching.every((r,i)=>r.date===start.slice(0,8)+String(i+1).padStart(2,'0'));
        const totalTrusted=allInRange&&matching.at(-1)?.date===end&&nonnegative(readings.total);
        const complete=completeDays||totalTrusted;
        const usage=complete?(completeDays?Math.round(matching.reduce((s,r)=>s+r.usage!,0)*100)/100:readings.total):undefined;
        samePeriod={start,end,usage,complete,queriedAt:now};
      }catch(error){if(!canRetain(error))throw error;unavailable=true;}
    }
  }
  const first=shiftMonth(month,-36);
  return {monthlyBills:bills.filter(b=>b.month>=first),billingHistoryChecks:checks,lastYearSamePeriod:samePeriod,
    historyUpdatedAt:unavailable?prior?.historyUpdatedAt:now,historyUnavailable:unavailable};
}
