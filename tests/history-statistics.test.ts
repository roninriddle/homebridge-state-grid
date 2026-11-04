import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { billingStatistics, compare } from '../src/services/billing-statistics.js';
import { queryBillingHistory } from '../src/sgcc/history.js';
import { StateGridApiError, StateGridAuthenticationError, type AccountSnapshot } from '../src/sgcc/types.js';
import { PluginStore } from '../src/services/store.js';
import { snapshotToCard } from '../src/services/card.js';
import { fieldValues, renderCard } from '../src/renderer/card-svg.js';
import { monthlyTrendSvg } from '../src/renderer/monthly-trend.js';
import { FIELD_KEYS, FIELD_META } from '../src/renderer/fields.js';
const require=createRequire(import.meta.url),{UiGateway}=require('../homebridge-ui/lib/gateway.js'),{registerRoutes}=require('../homebridge-ui/lib/routes.js');
const NOW=Date.parse('2026-11-04T12:00:00+08:00');
const current=Array.from({length:10},(_,i)=>({month:`2026-${String(i+1).padStart(2,'0')}`,usage:100,charge:50}));
const previous=Array.from({length:12},(_,i)=>({month:`2025-${String(i+1).padStart(2,'0')}`,usage:80,charge:40}));
const snapshot=()=>({consNo:'example',name:'test',currentMonth:'2026-11',currentMonthThrough:'2026-11-03',currentMonthPartial:false,currentMonthUsage:28.84,monthlyBills:[...previous,...current],dailySeries:[],updatedAt:NOW,lastYearSamePeriod:{start:'2025-11-01',end:'2025-11-03',usage:88.49,complete:true,queriedAt:NOW}} as AccountSnapshot);
const dirs:string[]=[];afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function dir(){const p=mkdtempSync(join(tmpdir(),'sgcc-history-'));dirs.push(p);return p;}
describe('同比和匹配期间',()=>{
 it('同月、同月份累计、同日区间各自使用匹配基期',()=>{
  const s=billingStatistics(snapshot(),NOW);expect(s.monthly).toMatchObject({month:'2026-10',previousMonth:'2025-10',usage:{percent:25},charge:{percent:25}});
  expect(s.cumulative).toMatchObject({year:2026,previousYear:2025,throughMonth:10,current:1000,previous:800,percent:25,complete:true});
  expect(s.monthToDate).toMatchObject({through:'2026-11-03',previousThrough:'2025-11-03',current:28.84,previous:88.49,percent:-67.41});
  expect(s.trend).toHaveLength(12);expect(s.trend[0].month).toBe('2025-11');expect(s.trend.at(-1)!.month).toBe('2026-10');
 });
 it('核对实查的结算月数据，百分比带符号且不是估算金额',()=>{
  const data=snapshot();data.monthlyBills=data.monthlyBills!.map(b=>b.month==='2026-10'?{...b,usage:1272,charge:1002.72}:b.month==='2025-10'?{...b,usage:860,charge:465.04}:b);
  const stats=billingStatistics(data,NOW);expect(stats.monthly.usage.percent).toBe(47.91);expect(stats.monthly.charge.percent).toBe(115.62);
  const fields=fieldValues(snapshotToCard(data,{title:'国家电网',fields:['latestMonthUsageYoY','latestMonthChargeYoY']},NOW));
  expect(fields.map(f=>f.unit)).toEqual(['%','%']);expect(fields[0].note).toContain('2026-10 / 2025-10');
  expect(renderCard(snapshotToCard(data,{title:'国家电网',fields:['latestMonthUsageYoY']},NOW))).toContain('+47.91');
 });
 it('缺少一个月不伪造同月份累计；保留已完整的本期总量',()=>{
  const data=snapshot();data.monthlyBills=data.monthlyBills!.filter(b=>b.month!=='2025-03');
  const s=billingStatistics(data,NOW);expect(s.cumulative.current).toBe(1000);expect(s.cumulative.previous).toBeUndefined();expect(s.cumulative.percent).toBeUndefined();expect(s.cumulative.complete).toBe(false);
  expect(s.monthly.usage.percent).toBe(25);
 });
 it('零基期无百分比，真实零和缺失在趋势图中不同',()=>{
  expect(compare(10,0)).toMatchObject({change:10,percent:undefined});expect(compare(0,0).percent).toBeUndefined();expect(compare(0,80).percent).toBe(-100);
  const data=snapshot();data.monthlyBills=data.monthlyBills!.filter(b=>b.month!=='2026-04').map(b=>b.month==='2026-05'?{...b,usage:0}:b);
  const s=billingStatistics(data,NOW);expect(s.trend.find(p=>p.month==='2026-04')!.usage).toBeNull();expect(s.trend.find(p=>p.month==='2026-05')!.usage).toBe(0);
  const svg=monthlyTrendSvg(s.trend);expect(svg).toContain('暂无数据');expect(svg).toContain('2026-05 · 0.00');
 });
 it('排除当前未结算月及未来月份，跨年保持结算月同比，本年尚无账单时不冒用上年累计',()=>{
  const data=snapshot();data.monthlyBills!.push({month:'2026-11',usage:999},{month:'2027-01',usage:999},{month:'bad<script>',usage:9});
  expect(billingStatistics(data,NOW).monthly.month).toBe('2026-10');
  const january=billingStatistics({...data,monthlyBills:[{month:'2026-12',usage:150},{month:'2025-12',usage:100}]},Date.parse('2027-01-03T12:00:00+08:00'));
  expect(january.monthly.usage.percent).toBe(50);expect(january.cumulative).toMatchObject({year:2027,complete:false,current:undefined,percent:undefined});
 });
 it('本月缺日、上年区间不同或闰日不存在时，不拿整月账单代替逐日同期',()=>{
  for(const patch of [{currentMonthPartial:true},{lastYearSamePeriod:{start:'2025-11-01',end:'2025-11-30',usage:800,complete:true,queriedAt:NOW}},{currentMonthThrough:'2026-11-05'},{currentMonth:'2028-02',currentMonthThrough:'2028-02-29'}]){
   const s=billingStatistics({...snapshot(),...patch},NOW);expect(s.monthToDate.percent).toBeUndefined();
  }
 });
});
describe('历史查询缓存及容错',()=>{
 function fixture(){vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(NOW);const client={queryMonthlyBills:vi.fn().mockResolvedValue(previous),queryDailyUsage:vi.fn().mockResolvedValue(Object.assign([{date:'2025-11-01',usage:36.31},{date:'2025-11-02',usage:25.46},{date:'2025-11-03',usage:26.72}],{total:744}))};return client;}
 it('完整逐日记录求和优先于不一致总量；保存到快照后重启可复用24小时',async()=>{
  const c=fixture(),a={consNoSrc:'example'} as any,data=snapshot();const history=await queryBillingHistory(c as any,a,current,data);
  expect(history.lastYearSamePeriod).toMatchObject({complete:true,usage:88.49,start:'2025-11-01',end:'2025-11-03'});
  expect(c.queryMonthlyBills).toHaveBeenCalledOnce();expect(c.queryDailyUsage).toHaveBeenCalledOnce();
  const second=await queryBillingHistory(c as any,a,current,data,{...data,...history});expect(second.monthlyBills).toHaveLength(22);expect(c.queryMonthlyBills).toHaveBeenCalledOnce();expect(c.queryDailyUsage).toHaveBeenCalledOnce();
  vi.setSystemTime(NOW+25*3600000);await queryBillingHistory(c as any,a,current,data,{...data,...history});expect(c.queryMonthlyBills).toHaveBeenCalledTimes(2);
 });
 it('不同户号不能复用历史缓存，服务端返回错误年份也不能混入历史',async()=>{
  const c=fixture(),data=snapshot();await queryBillingHistory(c as any,{consNoSrc:'example'} as any,current,data,{...data,consNo:'other',billingHistoryChecks:{2025:NOW}});expect(c.queryMonthlyBills).toHaveBeenCalledOnce();
  c.queryMonthlyBills.mockResolvedValue(current);const h=await queryBillingHistory(c as any,{consNoSrc:'example'} as any,current,data);expect(h.historyUnavailable).toBe(true);expect(h.monthlyBills.every(b=>b.month.startsWith('2026-'))).toBe(true);
 });
 it('历史接口业务失败保留历史并标记，认证错误仍走原有认证恢复',async()=>{
  const c=fixture(),data=snapshot();c.queryMonthlyBills.mockRejectedValue(new StateGridApiError('temporary','unavailable'));
  const h=await queryBillingHistory(c as any,{consNoSrc:'example'} as any,current,data,{...data,historyUpdatedAt:NOW-1000});expect(h.historyUnavailable).toBe(true);expect(h.monthlyBills).toHaveLength(22);expect(h.historyUpdatedAt).toBe(NOW-1000);
  c.queryMonthlyBills.mockRejectedValue(new StateGridAuthenticationError('-201','expired'));await expect(queryBillingHistory(c as any,{consNoSrc:'example'} as any,current,data)).rejects.toBeInstanceOf(StateGridAuthenticationError);
 });
 it('上年接口缺日或返回其他日期时不把缺失补零，区间变化会重新查询',async()=>{
  const c=fixture(),data=snapshot();c.queryDailyUsage.mockResolvedValue([{date:'2025-11-01',usage:2},{date:'2025-11-03',usage:3}] as any);
  const h=await queryBillingHistory(c as any,{consNoSrc:'example'} as any,current,data);expect(h.lastYearSamePeriod?.complete).toBe(false);expect(h.lastYearSamePeriod?.usage).toBeUndefined();
  await queryBillingHistory(c as any,{consNoSrc:'example'} as any,current,{...data,currentMonthThrough:'2026-11-04'},{...data,...h});expect(c.queryDailyUsage).toHaveBeenCalledTimes(2);
 });
});
describe('设置和图表集成',()=>{
 it('新指标可通过原生保存，趋势不是数值占位，两个主数字仍最大',()=>{
  const data=snapshot(),svg=renderCard(snapshotToCard(data,{title:'国家电网',fields:['balance','monthEstimateCharge','latestMonthUsageYoY','monthlyTrend']},NOW));
  expect([...svg.matchAll(/data-role="hero"/g)]).toHaveLength(2);expect(svg).toContain('data-role="monthly-trend"');expect(svg).not.toContain('data-field="monthlyTrend"');
  const only=renderCard(snapshotToCard(data,{title:'国家电网',fields:['monthlyTrend']},NOW));expect(only).toContain('data-role="monthly-trend"');expect(only).not.toContain('data-role="hero"');
  const config=JSON.parse(readFileSync('config.schema.json','utf8'));const keys=config.schema.properties.fields.items.properties.key.oneOf.flatMap((item:any)=>item.enum);for(const key of FIELD_KEYS)expect(keys).toContain(key);
  expect(Object.keys(FIELD_META)).toHaveLength(FIELD_KEYS.length);
 });
 it('统计页只读缓存，不写配置、不查询国网；未知户号返回错误',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(NOW);const d=dir(),store=new PluginStore(d);store.saveAccountsCache({updatedAt:NOW,accounts:[{consNo:'example',title:'国家电网',enabled:true,data:snapshot()}]} as any);
  const gateway=new UiGateway(d),routes=new Map();registerRoutes({onRequest:(p:string,h:Function)=>routes.set(p,h)},gateway);const login=vi.spyOn(gateway,'ensureClient');
  const response=await routes.get('/statistics-cache')({});expect(response.statistics.monthly.usage.percent).toBe(25);expect(response.usageChart).toContain('<svg');expect(response.chargeChart).toContain('电费');expect(login).not.toHaveBeenCalled();
  expect(await routes.get('/statistics-cache')({consNo:'foreign'})).toMatchObject({ok:false});
 });
});
