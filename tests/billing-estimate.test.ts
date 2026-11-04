import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chargeEstimate } from '../src/services/billing-estimate.js';
import { snapshotToCard } from '../src/services/card.js';
import { fieldValues, renderCard } from '../src/renderer/card-svg.js';
import { StateGridClient } from '../src/sgcc/client.js';
import { StateGridPlatform } from '../src/platform.js';
import { PluginStore } from '../src/services/store.js';
import { widgetPayload } from '../src/services/widgets.js';
import type { AccountSnapshot } from '../src/sgcc/types.js';
const require=createRequire(import.meta.url),{UiGateway}=require('../homebridge-ui/lib/gateway.js');
const NOW=Date.parse('2026-11-04T12:00:00+08:00');
const base:AccountSnapshot={consNo:'sample',name:'sample',currentMonth:'2026-11',currentMonthUsage:28.84,currentMonthThrough:'2026-11-03',currentMonthPartial:false,latestMonth:'2026-10',latestMonthUsage:479,latestMonthCharge:362.65,dailySeries:[],updatedAt:NOW};
const dirs:string[]=[];afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function storage(){const d=mkdtempSync(join(tmpdir(),'sgcc-billing-'));dirs.push(d);return d;}
describe('累计电费估算口径',()=>{
 it('按已获取累计电量折算，不外推月底；明确截至日和参考账单均价',()=>{
  const e=chargeEstimate(base,NOW);expect(e).toMatchObject({label:'当月累计电费估算',value:21.83,month:'2026-11',through:'2026-11-03',referenceMonth:'2026-10'});
  expect(e.note).toBe('截至11-03 · 参考10月均价0.7571元/度');expect(e.unitPrice).toBeCloseTo(362.65/479);
 });
 it('跨月旧缓存使用实际月份，包括没有显式月份的旧版本缓存',()=>{
  const e=chargeEstimate({...base,currentMonth:undefined,currentMonthUsage:1136.66,currentMonthThrough:'2026-10-28',latestMonth:'2026-09',latestMonthUsage:1794,latestMonthCharge:1414.21,updatedAt:Date.parse('2026-10-29T23:22:56+08:00')},NOW);
  expect(e).toMatchObject({label:'10月累计电费估算',month:'2026-10',value:896.03});expect(e.note).toContain('参考9月均价');
 });
 it('按北京时间跨月，跨年旧缓存标明年份；更新时间不能冒充截至日期',()=>{
  const old={...base,currentMonth:'2026-12',currentMonthThrough:'2026-12-30',latestMonth:'2026-11',updatedAt:Date.parse('2026-12-31T22:00:00+08:00')};
  expect(chargeEstimate(old,Date.parse('2026-12-31T16:00:00Z')).label).toBe('2026年12月累计电费估算');
  const missing=chargeEstimate({...base,currentMonth:undefined,currentMonthThrough:undefined},NOW);expect(missing.value).toBeUndefined();expect(missing.note).toContain('缺少电量截至日期');
 });
 it('缺日或覆盖未确认时暂停估算，真实零仍为零',()=>{
  expect(chargeEstimate({...base,currentMonthPartial:true},NOW)).toMatchObject({reason:'电量不完整，暂不估算'});
  expect(chargeEstimate({...base,currentMonthPartial:undefined},NOW).value).toBeUndefined();
  expect(chargeEstimate({...base,currentMonthUsage:0},NOW).value).toBe(0);
  expect(chargeEstimate({...base,latestMonthCharge:0},NOW).value).toBe(0);
 });
 it('缺失、负值、非有限数据或账单期间不一致不能产出金额',()=>{
  for(const patch of [{currentMonthUsage:NaN},{currentMonthUsage:-1},{latestMonthCharge:Infinity},{latestMonthCharge:-1},{latestMonthUsage:0},{latestMonthUsage:undefined},{latestMonth:undefined},{latestMonth:'2026-11'},{currentMonthThrough:'2026-11-05'},{currentMonthThrough:'2026-11-31'},{currentMonthThrough:'2026-10-28'}]){
   const e=chargeEstimate({...base,...patch} as AccountSnapshot,NOW);expect(e.value).toBeUndefined();expect(e.reason).toBeTruthy();
  }
 });
 it('卡片保留两个大数字和日期说明；估算移到下方仍有可见说明',()=>{
  const card=snapshotToCard(base,{title:'国家电网',fields:['balance','monthEstimateCharge','currentMonthUsage']},NOW);const svg=renderCard(card);
  expect(svg).toContain('当月累计电费估算');expect(svg).toContain('截至11-03');expect(svg).toContain('0.7571');expect(svg).toContain('21.83');expect(svg).not.toContain('本月预估');
  expect([...svg.matchAll(/data-role="hero"/g)]).toHaveLength(2);
  const moved=renderCard({...card,fields:['balance','currentMonthUsage','monthEstimateCharge']});expect(moved).toMatch(/y="674"[^>]*>截至11-03/);
 });
 it('跨月未超过26小时也标为旧缓存，不能继续显示当月',()=>{
  const snapshot={...base,currentMonth:'2026-10',currentMonthThrough:'2026-10-31',latestMonth:'2026-09',updatedAt:Date.parse('2026-10-31T23:50:00+08:00')};
  const card=snapshotToCard(snapshot,{title:'国家电网',fields:['monthEstimateCharge','currentMonthUsage']},Date.parse('2026-11-01T00:10:00+08:00'));
  expect(card.staleNote).toContain('10月缓存');expect(fieldValues(card).map(f=>f.label)).toEqual(['10月累计电费估算','10月用电']);
 });
 it('设置页及小组件实时重算旧摘要，输出相同月份和日期说明，不改原缓存',()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(NOW);
  const dir=storage(),store=new PluginStore(dir);const snapshot={...base,currentMonth:undefined,currentMonthThrough:'2026-10-28',latestMonth:'2026-09'};
  store.saveAccountsCache({updatedAt:NOW,accounts:[{consNo:'sample',title:'国家电网',name:'',address:'',enabled:true,data:snapshot,snapshot:{estimate:999}}]} as any);store.saveFields(['monthEstimateCharge','currentMonthUsage']);
  const file=join(dir,'state-grid/cache/accounts-cache.json'),before=readFileSync(file,'utf8');
  const summary=new UiGateway(dir).cachedAccounts().accounts[0].snapshot;expect(summary.estimateInfo.label).toBe('10月累计电费估算');
  const widget=widgetPayload(dir,NOW).accounts[0];expect(widget.stale).toBe(true);expect(widget.metrics[0]).toMatchObject({label:summary.estimateInfo.label,value:summary.estimateInfo.value,note:summary.estimateInfo.note,period:'2026-10',through:'2026-10-28'});
  expect(readFileSync(file,'utf8')).toBe(before);
 });
 it('日读数去重，缺月初时标部分；官方累计总量仍优先',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(NOW);
  const client=new StateGridClient({profile:{} as any,username:'sample',password:'sample'}) as any;
  client.queryDailyUsage=vi.fn().mockResolvedValue([{date:'2026-11-02',usage:3},{date:'2026-11-02',usage:4}]);client.queryBalance=vi.fn().mockResolvedValue(null);client.queryMonthlyBills=vi.fn().mockResolvedValue([{month:'2026-10',usage:479,charge:362.65}]);
  const snapshot=await client.snapshot({consNoSrc:'sample'});expect(snapshot).toMatchObject({currentMonth:'2026-11',currentMonthUsage:4,currentMonthPartial:true});expect(chargeEstimate(snapshot,NOW).value).toBeUndefined();
  client.queryDailyUsage.mockResolvedValue(Object.assign([{date:'2026-11-03',usage:4}],{total:28.84}));
  const total=await client.snapshot({consNoSrc:'sample'});expect(chargeEstimate(total,NOW).value).toBe(21.83);
 });
 it('跨月监测只重绘卡片，不触发登录；一个月内不重复重绘',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-31T23:59:55+08:00'));
  const dir=storage(),p=new StateGridPlatform({info:vi.fn(),warn:vi.fn(),debug:vi.fn(),error:vi.fn()} as any,{} as any,{user:{storagePath:()=>dir},on:()=>{}} as any) as any;
  const entry={snapshot:base,paintedMonth:'2026-10',camera:{stopStream:vi.fn()}};p.entries.set('sample',entry);p.paint=vi.fn(async()=>{entry.paintedMonth='2026-11';});p.startConfigWatcher();
  await vi.advanceTimersByTimeAsync(8000);expect(p.paint).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(8000);expect(p.paint).toHaveBeenCalledOnce();p.stop();
 });
});
