import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as tar from 'tar';
import { CHECK_INTERVAL, PluginUpdates, releaseFromApi, unpackRelease } from '../src/services/plugin-updates.js';

const dirs: string[] = [];
afterEach(() => {vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, {recursive:true, force:true});});
function directory() {const d=realpathSync(mkdtempSync(join(tmpdir(),'sgcc-update-')));dirs.push(d);return d;}
function json(file: string, value: unknown) {mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));}
const manifest=(version: string)=>({name:'homebridge-state-grid',version,main:'dist/index.js',engines:{node:'>=22',homebridge:'>=1.8.0'}});
function api(asset?: Buffer) {return {id: 100,tag_name:'v0.8.1',draft:false,prerelease:false,body:'新功能',published_at:'2026-10-30T00:00:00Z',assets:asset?[{name:'homebridge-state-grid-0.8.1.tgz',state:'uploaded',size:asset.length,digest:'sha256:'+createHash('sha256').update(asset).digest('hex'),browser_download_url:'https://github.com/roninriddle/homebridge-state-grid/releases/download/v0.8.1/homebridge-state-grid-0.8.1.tgz'}]:[]};}
async function fixture(options: {mutate?: (root: string)=>void; prepare?: (candidate: string)=>Promise<void>}={}) {
  const d=directory(),root=join(d,'modules/homebridge-state-grid'),storage=join(d,'storage'),source=join(d,'source');
  json(root+'/package.json',manifest('0.8.0'));json(dirname(root)+'/homebridge/package.json',{version:'2.4.0'});
  json(storage+'/state-grid/device.json',{seed:'private-device'});json(storage+'/state-grid/session.json',{token:'private-token'});json(storage+'/config.json',{preserve:true});
  json(storage+'/state-grid/cache/status.json',{pluginVersion:'0.8.0'});
  json(source+'/package/package.json',manifest('0.8.1'));json(source+'/package/npm-shrinkwrap.json',{lockfileVersion:3});
  mkdirSync(source+'/package/dist',{recursive:true});writeFileSync(source+'/package/dist/index.js','module.exports = () => {};');
  options.mutate?.(source+'/package');
  const archive=join(d,'archive.tgz');await tar.c({gzip:true,cwd:source,file:archive},['package']);const payload=readFileSync(archive);
  let clock=Date.UTC(2026,9,30);const raw=api(payload);
  const request=vi.fn(async (url: any) => String(url).includes('/releases/latest') ? new Response(JSON.stringify(raw),{headers:{etag:'release-one'}}) : new Response(payload));
  const updater=new PluginUpdates(storage,root,{fetch:request as any,now:()=>clock,prepare:options.prepare||(async()=>{})});
  return {d,root,storage,source,archive,payload,raw,request,updater,tick:(n=31_000)=>{clock+=n;},now:()=>clock};
}

describe('GitHub 正式版本检查',()=>{
  it('只接受稳定版本和该项目的校验资产，缺资产时仍能提示版本',()=>{
    expect(releaseFromApi(api()).version).toBe('0.8.1');expect(releaseFromApi(api()).asset).toBeUndefined();
    for(const raw of [{...api(),draft:true},{...api(),prerelease:true},{...api(),tag_name:'v0.8.2-beta.1'},{...api(),tag_name:'bad'}])expect(()=>releaseFromApi(raw)).toThrow();
    const raw=api(Buffer.from('asset'));raw.assets[0].browser_download_url='https://evil.example/file.tgz';expect(releaseFromApi(raw).asset).toBeUndefined();
  });
  it('自动启动检查、12 小时缓存、手动限频且从不发送国网凭据',async()=>{
    const f=await fixture();vi.useFakeTimers();f.updater.start();await vi.advanceTimersByTimeAsync(30_000);f.updater.stop();
    expect(f.request).toHaveBeenCalledOnce();await f.updater.check();await f.updater.check(true);expect(f.request).toHaveBeenCalledOnce();
    f.tick(CHECK_INTERVAL+1);await f.updater.check();expect(f.request).toHaveBeenCalledTimes(2);
    const sent=JSON.stringify(f.request.mock.calls);expect(sent).not.toContain('private-device');expect(sent).not.toContain('private-token');expect(sent).not.toContain('Authorization');
  });
  it('可关闭自动检查，手动检查仍可用',async()=>{
    const f=await fixture();f.updater.setEnabled(false);await f.updater.check();expect(f.request).not.toHaveBeenCalled();
    await f.updater.check(true);expect(f.request).toHaveBeenCalledOnce();expect(f.updater.status().enabled).toBe(false);
  });
  it('支持 ETag，失败保留上次结果并退避，区分无正式发布',async()=>{
    const f=await fixture();await f.updater.check();f.tick();
    f.request.mockImplementationOnce(async()=>new Response(null,{status:304}));expect((await f.updater.check(true)).latestVersion).toBe('0.8.1');
    f.tick();f.request.mockImplementationOnce(async()=>new Response('',{status:429,headers:{'x-ratelimit-reset':String((f.now()+7200000)/1000)}}));
    const failed=await f.updater.check(true);expect(failed.error).toContain('限流');expect(failed.latestVersion).toBe('0.8.1');expect(failed.nextCheckAt).toBeGreaterThan(f.now()+3600000);
    f.tick();f.request.mockImplementationOnce(async()=>new Response(null,{status:404}));const absent=await f.updater.check(true);expect(absent.latestVersion).toBeNull();expect(absent.error).toBeNull();
  });
  it('合并并发检查，拒绝旧版本或预览版本降级',async()=>{
    const f=await fixture();await Promise.all([f.updater.check(true),f.updater.check(true)]);expect(f.request).toHaveBeenCalledOnce();
    f.tick();f.raw.tag_name='v0.7.2';expect((await f.updater.check(true)).updateAvailable).toBe(false);
  });
});

describe('隔离安装和文件激活',()=>{
  it('校验、暂存、激活并保留旧包，凭据配置不变；安装后提示重启',async()=>{
    const f=await fixture();const result=await f.updater.install('0.8.1');
    expect(f.updater.installedVersion()).toBe('0.8.1');expect(result.restartRequired).toBe(true);expect(result.runningVersion).toBe('0.8.0');
    expect(JSON.parse(readFileSync(result.operation!.backup!+'/package.json','utf8')).version).toBe('0.8.0');
    expect(JSON.parse(readFileSync(f.storage+'/state-grid/session.json','utf8'))).toEqual({token:'private-token'});
    expect(JSON.parse(readFileSync(f.storage+'/config.json','utf8'))).toEqual({preserve:true});
    expect(existsSync(f.updater.directory+'/install.lock')).toBe(false);
  });
  it('损坏包不解包、不替换正式插件',async()=>{
    const f=await fixture();f.request.mockImplementation(async(url:any)=>String(url).includes('/releases/latest')?new Response(JSON.stringify(f.raw)):new Response('tampered'));
    await expect(f.updater.install('0.8.1')).rejects.toThrow('SHA-256');expect(f.updater.installedVersion()).toBe('0.8.0');
  });
  it('拒绝链接、路径越界和不兼容引擎',async()=>{
    const linked=await fixture({mutate:r=>symlinkSync('/etc/passwd',r+'/dist/link')});
    await expect(unpackRelease(linked.archive,linked.d)).rejects.toThrow('结构');
    const invalid=await fixture({mutate:r=>json(r+'/package.json',{...manifest('0.8.1'),engines:{node:'>=999',homebridge:'>=1.8'}})});
    await expect(invalid.updater.install('0.8.1')).rejects.toThrow('Node.js');expect(invalid.updater.installedVersion()).toBe('0.8.0');
  });
  it('依赖或预检失败保持旧版本和配置，可再次重试',async()=>{
    let fail=true;const f=await fixture({prepare:async()=>{if(fail)throw Error('preflight failed');}});
    await expect(f.updater.install('0.8.1')).rejects.toThrow('preflight');expect(f.updater.installedVersion()).toBe('0.8.0');
    fail=false;await f.updater.install('0.8.1');expect(f.updater.installedVersion()).toBe('0.8.1');
  });
  it('激活时暂存目录丢失会恢复旧插件目录',async()=>{
    const f=await fixture({prepare:async(candidate)=>{rmSync(candidate,{recursive:true,force:true});}});
    await expect(f.updater.install('0.8.1')).rejects.toThrow();
    expect(f.updater.installedVersion()).toBe('0.8.0');expect(existsSync(f.root+'/package.json')).toBe(true);
  });
  it('拒绝重定向到其他站点，不向其发起请求',async()=>{
    const f=await fixture();f.request.mockImplementation(async(url:any)=>String(url).includes('/releases/latest')?new Response(JSON.stringify(f.raw)):new Response(null,{status:302,headers:{location:'https://evil.example/payload'}}));
    await expect(f.updater.install('0.8.1')).rejects.toThrow('不可信');
    expect(f.request.mock.calls.some(args=>String(args[0]).includes('evil.example'))).toBe(false);
    expect(f.updater.installedVersion()).toBe('0.8.0');
  });
  it('拒绝目标变化、并发安装和重复安装',async()=>{
    let release!:()=>void;const f=await fixture({prepare:()=>new Promise<void>(r=>{release=r;})});
    await expect(f.updater.install('0.8.2')).rejects.toThrow('版本已变化');
    const pending=f.updater.install('0.8.1');
    for(let i=0;i<30&&!release;i++)await new Promise(r=>setTimeout(r,10));
    const second=new PluginUpdates(f.storage,f.root,{fetch:f.request as any});await expect(second.install('0.8.1')).rejects.toThrow('正在进行');
    release();await pending;await expect(f.updater.install('0.8.1')).rejects.toThrow('版本已变化');
  });
});
