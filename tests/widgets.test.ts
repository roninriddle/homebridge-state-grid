import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { PluginStore } from '../src/services/store.js';
import { WidgetServer, WidgetSettings, widgetPayload } from '../src/services/widgets.js';
import { StateGridClient } from '../src/sgcc/client.js';

const require = createRequire(import.meta.url);
const dirs: string[] = [], servers: WidgetServer[] = [];
afterEach(() => {for (const server of servers.splice(0)) server.stop(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sgcc-widget-')); dirs.push(dir);
  const store = new PluginStore(dir), settings = new WidgetSettings(dir);
  store.saveAccountsCache({updatedAt: Date.now(), accounts: [
    {consNo: '1234567890123', name: 'Private Owner', address: 'Private Full Address', title: '国家电网', enabled: true, data: {updatedAt: Date.now(), balance: 0, currentMonthUsage: 12.5, dailySeries: []}},
    {consNo: 'disabled-account', name: 'Hidden Owner', address: '', title: 'Hidden card', enabled: false},
  ]} as any);
  store.saveFields(['balance', 'currentMonthUsage', 'latestMonthCharge']);
  writeFileSync(join(dir,'config.json'), JSON.stringify({platforms:[{platform:'StateGrid',theme:'dark'}]}));
  return {dir, store, settings};
}
async function freePort() {const socket=createServer(); await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve);});const port=(socket.address() as any).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));return port;}
async function listen(f=fixture()) {
  const port=await freePort();f.settings.configure(true,port);const {token}=f.settings.rotateToken();
  const server=new WidgetServer(f.dir); servers.push(server);server.start();
  await vi.waitFor(()=>expect(f.settings.status().listening).toBe(true));
  return {...f,server,port,token,url:`http://127.0.0.1:${port}/v1/widget`};
}
const authorization=(token:string)=>({Authorization:'Bearer '+token});

describe('小组件缓存和隐私',()=>{
  it('默认关闭，明文令牌只返回一次；重建进程后令牌仍有效，可立即撤销或重置',()=>{
    const f=fixture();expect(f.settings.status()).toMatchObject({enabled:false,hasToken:false,listening:false});
    f.settings.configure(true,19861);const a=f.settings.rotateToken().token;
    expect(readFileSync(join(f.settings.directory,'settings.json'),'utf8')).not.toContain(a);
    const other=new WidgetSettings(f.dir);expect(other.authorized('Bearer '+a)).toBe(true);expect(JSON.stringify(other.status())).not.toContain(a);
    const b=other.rotateToken().token;expect(other.authorized('Bearer '+a)).toBe(false);expect(other.authorized('Bearer '+b)).toBe(true);
    other.revokeToken();expect(other.authorized('Bearer '+b)).toBe(false);
    expect(()=>other.configure(true,0)).toThrow('端口');expect(()=>other.configure(true,NaN)).toThrow('端口');
  });
  it('只导出启用户号、选定指标、数值和粗略地区；缺失不是零，真实零保留',()=>{
    const f=fixture();f.settings.rotateToken();const spy=vi.spyOn(StateGridClient.prototype,'ensureLogin');
    const p=widgetPayload(f.dir);expect(p.accounts).toHaveLength(1);expect(p.accounts[0]).toMatchObject({theme:'dark',region:null,stale:false});
    expect(p.accounts[0].metrics.map(m=>[m.key,m.value,m.text])).toEqual([['balance',0,'0.00'],['currentMonthUsage',12.5,'12.50'],['latestMonthCharge',null,'—']]);
    const serialized=JSON.stringify(p);for(const text of ['Private Owner','Private Full Address','1234567890123','disabled-account','Hidden Owner'])expect(serialized).not.toContain(text);
    expect(spy).not.toHaveBeenCalled();expect(widgetPayload(f.dir).accounts[0].id).toBe(p.accounts[0].id);
    f.settings.rotateToken();expect(widgetPayload(f.dir).accounts[0].id).toBe(p.accounts[0].id);
    f.store.setAccountVisibility('1234567890123',false);expect(widgetPayload(f.dir).accounts).toEqual([]);
  });
  it('离线、验证失败和过期快照标记陈旧；无快照全为缺失值，不注入演示数据',()=>{
    const f=fixture();writeFileSync(join(f.dir,'state-grid/cache/status.json'),JSON.stringify({state:'needs_verification'}));
    expect(widgetPayload(f.dir).accounts[0].stale).toBe(true);
    writeFileSync(join(f.dir,'state-grid/cache/status.json'),'{}');expect(widgetPayload(f.dir,Date.now()+27*3600000).accounts[0].stale).toBe(true);
    f.store.saveAccountsCache({updatedAt:Date.now(),accounts:[{consNo:'empty',name:'',address:'',title:'国家电网',enabled:true}]} as any);
    const a=widgetPayload(f.dir).accounts[0];expect(a.updatedAt).toBeNull();expect(a.metrics.every(m=>m.value===null&&m.text==='—')).toBe(true);
  });
});

describe('小组件真实 HTTP 生命周期',()=>{
  it('关闭设置页后仍可多人并发读取，拒绝无令牌和写请求，修改可见性即时生效',async()=>{
    const f=await listen();expect((await fetch(f.url)).status).toBe(401);
    expect((await fetch(f.url+'?token='+f.token)).status).toBe(401);
    expect((await fetch(f.url,{method:'POST',headers:authorization(f.token)})).status).toBe(405);
    expect((await fetch(f.url,{headers:{...authorization(f.token),Origin:'https://example.com'}})).status).toBe(403);
    expect((await fetch(f.url+'/../session.json',{headers:authorization(f.token)})).status).toBe(404);
    const results=await Promise.all(Array.from({length:20},()=>fetch(f.url,{headers:authorization(f.token)})));
    expect(results.every(r=>r.status===200&&r.headers.get('cache-control')==='no-store')).toBe(true);
    expect((await results[0].json()).accounts).toHaveLength(1);
    f.store.setAccountVisibility('1234567890123',false);
    expect((await(await fetch(f.url,{headers:authorization(f.token)})).json()).accounts).toEqual([]);
    f.settings.revokeToken();expect((await fetch(f.url,{headers:authorization(f.token)})).status).toBe(401);
    f.settings.configure(false,f.port);expect((await fetch(f.url,{headers:authorization(f.settings.rotateToken().token)})).status).toBe(401);
    f.server.stop();expect(f.settings.status().listening).toBe(false);
  });
  it('端口冲突不会影响平台，修改端口后能恢复；关闭后释放端口',async()=>{
    const first=await listen();const f=fixture();f.settings.configure(true,first.port);const log=vi.fn();const server=new WidgetServer(f.dir,log);servers.push(server);server.start();
    await vi.waitFor(()=>expect(f.settings.status().error).toContain('端口已被占用'));
    expect(log).toHaveBeenCalledOnce();
    const port=await freePort();f.settings.configure(true,port);
    await vi.waitFor(()=>expect(f.settings.status().listening).toBe(true),{timeout:3000});server.stop();
    const probe=createServer();await new Promise<void>(resolve=>probe.listen(port,'0.0.0.0',resolve));await new Promise<void>(resolve=>probe.close(()=>resolve()));
  });
  it('错误令牌请求限流，已认证设置页管理接口不泄露国网凭据',async()=>{
    const f=await listen();for(let i=0;i<12;i++)expect((await fetch(f.url)).status).toBe(401);
    expect((await fetch(f.url)).status).toBe(429);
    const {UiGateway}=require('../homebridge-ui/lib/gateway.js'),{registerRoutes}=require('../homebridge-ui/lib/routes.js');
    const routes=new Map();const gateway=new UiGateway(f.dir);registerRoutes({onRequest:(p:string,h:Function)=>routes.set(p,h)},gateway);
    expect(await routes.get('/widgets-setting')({enabled:true,port:'oops'})).toMatchObject({ok:false});
    expect(await routes.get('/widgets')()).toMatchObject({ok:true,enabled:true,hasToken:true});
    const token=await routes.get('/widgets-token')();expect(token.token).toHaveLength(43);
    expect(await routes.get('/widgets-revoke')()).toMatchObject({hasToken:false});
  });
});
