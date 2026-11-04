import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Script, createContext } from 'node:vm';
const require = createRequire(import.meta.url), {UiGateway}=require('../homebridge-ui/lib/gateway.js'),{registerRoutes}=require('../homebridge-ui/lib/routes.js');
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function page(options:{copy?:boolean;modernCopy?:boolean;scriptFailure?:boolean}={}) {
 const dir=mkdtempSync(join(tmpdir(),'sgcc-widget-ui-'));dirs.push(dir);const gateway=new UiGateway(dir),routes=new Map();registerRoutes({onRequest:(p:string,h:Function)=>routes.set(p,h)},gateway);
 const elements=new Map<string,any>();
 function element(id:string){if(!elements.has(id)){const hidden=new Set(['hidden']);elements.set(id,{value:'',textContent:'',disabled:false,checked:false,listeners:new Map(),focus:vi.fn(),select:vi.fn(),setSelectionRange:vi.fn(),classList:{add:(k:string)=>hidden.add(k),remove:(k:string)=>hidden.delete(k),toggle:(k:string,v:boolean)=>v?hidden.add(k):hidden.delete(k),contains:(k:string)=>hidden.has(k)},addEventListener(k:string,fn:Function){this.listeners.set(k,fn);}});}return elements.get(id);}
 const request=vi.fn(async(p:string,payload:any)=>{if(p==='/widgets-script'&&options.scriptFailure)return {ok:false,message:'读取失败'};return routes.get(p)?routes.get(p)(payload):{ok:true};});
 const copy=vi.fn(()=>options.copy===true),modern=vi.fn(options.modernCopy?async()=>{}:async()=>{throw Error('Permission denied');});
 const confirm=vi.fn(()=>{throw Error('sandbox forbids modals');});const blob=vi.fn(),url=vi.fn(()=> 'blob:test-script');
 const context=createContext({window:{homebridge:{request},location:{hostname:'192.0.2.1'}},document:{getElementById:element,execCommand:copy},confirm,navigator:{clipboard:{writeText:modern}},Blob:class{constructor(parts:any){blob(parts);}},URL:{createObjectURL:url,revokeObjectURL:vi.fn()},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1});
 new Script(readFileSync('homebridge-ui/public/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)![1]).runInContext(context);
 const run=(code:string)=>new Script(code).runInContext(context);
 const click=(id:string)=>element(id).listeners.get('click')();
 return {gateway,request,element,run,click,copy,modern,confirm,blob};
}
describe('Homebridge 沙盒中的小组件设置',()=>{
 it('禁止系统弹窗时仍可首次生成，已有令牌须页内确认；取消不重置，撤销后清空文本',async()=>{
  const p=page();await p.run('loadWidgets()');await p.click('widgetRotate');
  const first=p.element('widgetToken').value;expect(first).toHaveLength(43);expect(p.element('widgetRotate').textContent).toBe('重置令牌');expect(p.confirm).not.toHaveBeenCalled();expect(p.gateway.widgets.status().hasToken).toBe(true);
  await p.click('widgetRotate');expect(p.element('widgetResetConfirm').classList.contains('hidden')).toBe(false);expect(p.element('widgetToken').value).toBe(first);
  await p.click('widgetResetCancel');expect(p.element('widgetResetConfirm').classList.contains('hidden')).toBe(true);
  await p.click('widgetRotate');await p.click('widgetResetYes');expect(p.element('widgetToken').value).not.toBe(first);
  await p.click('widgetRevoke');expect(p.element('widgetToken').value).toBe('');expect(p.gateway.widgets.status().hasToken).toBe(false);
 });
 it('HTTP 下无需现代剪贴板权限，用户点击时同步复制完整脚本；下载与原文件逐字一致',async()=>{
  const p=page({copy:true});await p.run('loadWidgets()');await p.run('loadWidgetScript()');await p.click('widgetCopyScript');
  const original=readFileSync('homebridge-ui/public/widgets/国家电网.js','utf8');expect(p.element('widgetScript').value).toBe(original);expect(p.blob).toHaveBeenCalledWith([original]);
  expect(p.request).toHaveBeenCalledWith('/widgets-script');expect(p.copy).toHaveBeenCalledWith('copy');expect(p.modern).not.toHaveBeenCalled();expect(p.element('widgetTip').textContent).toBe('脚本已复制。');
 });
 it('两个剪贴板接口均被拒绝时选中完整脚本，并明确提示手动复制，不误报成功',async()=>{
  const p=page();await p.run('loadWidgetScript()');await p.click('widgetCopyScript');
  expect(p.element('widgetScriptPanel').classList.contains('hidden')).toBe(false);expect(p.element('widgetScript').select).toHaveBeenCalled();
  expect(p.element('widgetScript').setSelectionRange).toHaveBeenCalledWith(0,p.element('widgetScript').value.length);
  expect(p.element('widgetTip').textContent).toContain('脚本已选中');expect(p.element('widgetTip').textContent).not.toContain('已复制');
  await p.click('widgetSelectScript');expect(p.element('widgetScript').select).toHaveBeenCalledTimes(2);
 });
 it('安全上下文可使用现代剪贴板补救，令牌和脚本共享同一手动复制兜底',async()=>{
  const p=page({modernCopy:true});await p.run('loadWidgets()');await p.click('widgetRotate');await p.click('widgetCopyToken');
  expect(p.modern).toHaveBeenCalledWith(p.element('widgetToken').value);expect(p.element('widgetTip').textContent).toBe('令牌已复制。');
 });
 it('脚本读取失败会提示错误并可重试，不下载 HTML 或空脚本',async()=>{
  const p=page({scriptFailure:true});await p.click('widgetShowScript');expect(p.element('widgetTip').textContent).toBe('读取失败');expect(p.blob).not.toHaveBeenCalled();
  await p.click('widgetShowScript');expect(p.request.mock.calls.filter(([path])=>path==='/widgets-script')).toHaveLength(2);
 });
});
