/** 执行完整 Scriptable 脚本；验证数据和缓存行为，不将宿主桩当作 iPhone 实机验收。 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Script as VmScript } from 'node:vm';
const source = readFileSync('homebridge-ui/public/widgets/国家电网.js','utf8');
const token='a'.repeat(43),account={id:'opaque-id',title:'国家电网',theme:'light',updatedAt:Date.now(),stale:false,region:null,metrics:Array.from({length:12},(_,i)=>({key:'metric'+i,label:'指标'+i,text:i===0?'0.00':'123.45',unit:i===0?'元':'kWh'}))};
async function run(options:{family?:string;parameter?:string;status?:number;offline?:boolean;throwOnHttpError?:boolean;empty?:boolean;cached?:boolean;app?:boolean;setup?:boolean;account?:any}={}) {
 const files=new Map<string,string>();if(options.cached)files.set('/docs/state-grid-widget-cache/'+encodeURIComponent('默认')+'.json',JSON.stringify(options.account||account));
 const profiles=options.setup?{}:{默认:{server:'http://192.0.2.1:19861',token,account:'opaque-id'}};
 const secrets=new Map<string,string>([['homebridge-state-grid.widgets.v1',JSON.stringify(profiles)]]);
 const drawings:any[]=[],images:any[]=[];
 const text:string[]=[],fonts:number[]=[],requests:any[]=[],alerts:any[]=[];let widget:any,complete=false;
 class Stack {
  addText(value:string){text.push(value);return {set font(v:any){fonts.push(v);},textColor:null,lineLimit:0,minimumScaleFactor:0};}
  addImage(value:any){images.push(value);return {}; }
  addStack(){return new Stack();} addSpacer(){} layoutVertically(){} layoutHorizontally(){} bottomAlignContent(){}
 }
 class ListWidget extends Stack {setPadding(){}async presentMedium(){} }
 class Request {
  headers:any;timeoutInterval:any;onRedirect:any;response={statusCode:options.status||200};
  constructor(readonly url:string){requests.push(this);}
  async loadJSON(){if(options.offline||(options.throwOnHttpError&&this.response.statusCode!==200))throw Error('transport');return this.response.statusCode===200?{schemaVersion:1,accounts:options.empty?[]:[options.account||account]}:{error:'not allowed'};}
 }
 const actions=options.setup?[0,0,0]:[0];
 class Alert {
  fields:string[]=[];title='';message='';
  constructor(){alerts.push(this);}addAction(){}addCancelAction(){}addTextField(_:string,v:string){this.fields.push(v);}addSecureTextField(_:string,v:string){this.fields.push(v);}
  async presentSheet(){return actions.shift()??-1;}async presentAlert(){this.fields=['默认','http://192.0.2.1:19861',token];return actions.shift()??-1;}textFieldValue(i:number){return this.fields[i];}
 }
 const context={FileManager:{local:()=>({documentsDirectory:()=>'/docs',joinPath:(a:string,b:string)=>a+'/'+b,fileExists:(p:string)=>files.has(p),createDirectory:()=>{},remove:(p:string)=>files.delete(p),readString:(p:string)=>{if(!files.has(p))throw Error('not found');return files.get(p);},writeString:(p:string,v:string)=>files.set(p,v)})},
 Keychain:{contains:(k:string)=>secrets.has(k),get:(k:string)=>secrets.get(k),set:(k:string,v:string)=>secrets.set(k,v)},Request,Alert,ListWidget,
 DrawContext:class{setFont(){}setTextColor(){}setFillColor(){}fillRect(rect:any){drawings.push(rect);}drawTextInRect(){}getImage(){return 'mock-image';}},Rect:class{constructor(...args:any[]){Object.assign(this,{args});}},
 Color:class{constructor(readonly value:string){}},Font:{systemFont:(n:number)=>n,semiboldSystemFont:(n:number)=>n,boldSystemFont:(n:number)=>n},Size:class{},Device:{screenSize:()=>({width:390,height:844})},
 DateFormatter:class{dateFormat='';timeZone='';string(){return this.dateFormat==='yyyy-MM'?'2026-11':'11-04 12:00';}},URLScheme:{forRunningScript:()=> 'scriptable:///run/test'},
 Script:{setWidget:(v:any)=>widget=v,complete:()=>complete=true},args:{widgetParameter:options.parameter},config:{runsInWidget:!options.app,widgetFamily:options.family||'medium'},Date,JSON,Object,Array,Math,Number,String,Error,encodeURIComponent};
 await new VmScript('(async()=>{'+source+'\n})()').runInNewContext(context,{timeout:2000});
 return {text,fonts,drawings,images,files,secrets,requests,widget,complete,alerts};
}
describe('Scriptable 完整脚本',()=>{
 it.each([['small',2],['medium',4],['large',8]])('%s 尺寸限制指标数，真实零保留，顶部字号最大',async(family,count)=>{
  const r=await run({family:String(family)});expect(r.complete).toBe(true);expect(r.widget).toBeDefined();
  expect(r.text.filter(t=>/^指标\d+$/.test(t))).toHaveLength(Number(count));expect(r.text).toContain('0.00');
  expect(Math.max(...r.fonts)).toBe(family==='small'?22:26);
  expect(r.requests).toHaveLength(1);expect(r.requests[0].headers.Authorization).toBe('Bearer '+token);expect(r.requests[0].onRedirect()).toBeNull();
 });
 it('连接失败时显示带更新时间的离线缓存，首次离线不伪造数据',async()=>{
  const cached=await run({offline:true,cached:true});expect(cached.text.some(s=>s.startsWith('离线缓存'))).toBe(true);expect(cached.text).toContain('0.00');
  const fresh=await run({offline:true});expect(fresh.text).not.toContain('0.00');expect(fresh.text.some(s=>s.includes('连接失败'))).toBe(true);
 });
 it.each([401,403,404])('HTTP %d 撤销缓存，即使宿主 loadJSON 抛错也不继续展示旧数据',async(status)=>{
  for(const throwOnHttpError of [false,true]){const r=await run({status,cached:true,throwOnHttpError});expect(r.files.size).toBe(0);expect(r.text).not.toContain('0.00');expect(r.text.some(s=>s.includes('令牌已失效'))).toBe(true);}
 });
 it('户号停用时移除缓存，未知档案不尝试联网',async()=>{
  const hidden=await run({empty:true,cached:true});expect(hidden.files.size).toBe(0);expect(hidden.text.some(s=>s.includes('户号已停用'))).toBe(true);
  const missing=await run({parameter:'另一台服务器'});expect(missing.requests).toHaveLength(0);expect(missing.text.some(s=>s.includes('另一台服务器'))).toBe(true);
 });
 it('离线跨月缓存仍显示实际月份与截至日，不能冒充本月',async()=>{
  const cached={...account,dataMonth:'2026-10',metrics:[{key:'monthEstimateCharge',label:'当月累计电费估算',text:'21.83',unit:'元',period:'2026-10',through:'2026-10-28',note:'截至10-28 · 参考9月均价0.7571元/度'}]};
  const r=await run({account:cached,offline:true,cached:true});expect(r.text).toContain('10月累计电费估算');expect(r.text).toContain('截至 10-28');expect(r.text.some(s=>s.includes('离线缓存'))).toBe(true);
 });
 it('大号组件绘制12个月趋势，数值区保留前4项；中号保持数值展示',async()=>{
  const data={...account,trendEnabled:true,statistics:{trend:Array.from({length:12},(_,i)=>({month:'2026-'+String(i+1).padStart(2,'0'),usage:i===2?null:i===3?0:i*10,charge:0}))}};
  const large=await run({account:data,family:'large'});expect(large.images).toHaveLength(1);expect(large.drawings).toHaveLength(11);expect(large.text.filter(t=>/^指标\d+$/.test(t))).toHaveLength(4);
  const medium=await run({account:data,family:'medium'});expect(medium.images).toHaveLength(0);expect(medium.text.filter(t=>/^指标\d+$/.test(t))).toHaveLength(4);
 });
 it('首次配置选择户号、将令牌存入钥匙串并预览，脚本文件没有嵌入令牌',async()=>{
  const r=await run({app:true,setup:true});expect(r.complete).toBe(true);const settings=JSON.parse(r.secrets.get('homebridge-state-grid.widgets.v1')!);
  expect(settings.默认).toEqual({server:'http://192.0.2.1:19861',token,account:'opaque-id'});expect(r.text).toContain('0.00');expect(source).not.toContain(token);
 });
});
