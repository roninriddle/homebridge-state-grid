import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// 执行真实设置页脚本，模拟 Homebridge 的底部保存按钮与异步请求。
function ui(requestFields = async (payload: any) => ({ok: true, fields: payload.fields})) {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {value: '', checked: false, disabled: false, textContent: '', innerHTML: '', listeners: new Map(),
      classList: {add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: () => true},
      addEventListener(event: string, callback: Function) { this.listeners.set(event, callback); }});
    return elements.get(id);
  };
  const bridge = {disableSaveButton: vi.fn(), enableSaveButton: vi.fn(), request: vi.fn(async (path: string, payload: any) => path === '/fields-save' ? requestFields(payload) : {ok: true})};
  const context = createContext({window: {homebridge: bridge}, document: {getElementById: element}, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1});
  const html = readFileSync('homebridge-ui/public/index.html', 'utf8');
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]).runInContext(context);
  const run = (code: string) => new Script(code).runInContext(context);
  run("fieldActive = ['balance', 'currentMonthUsage']; fieldSaved = JSON.stringify(fieldActive); fieldsLoaded = true; updateDraftState();");
  return {bridge, element, run, save: () => element('fieldsSaveBtn').listeners.get('click')()};
}

describe('卡片保存交互', () => {
  it('删除指标后阻止通用保存丢弃草稿，保存指标成功才重新开放', async () => {
    const page = ui();
    page.run('removeField(1)');
    expect(page.bridge.disableSaveButton).toHaveBeenCalled();
    expect(page.element('draftState').textContent).toContain('草稿未保存');
    await page.save();
    expect(page.bridge.request).toHaveBeenCalledWith('/fields-save', {fields: ['balance']});
    expect(page.element('draftState').textContent).toBe('当前配置已保存');
    expect(page.element('fieldsTip').textContent).toContain('无需再点底部保存');
    expect(page.bridge.enableSaveButton).toHaveBeenCalled();
  });

  it('提交失败时仍保留草稿和禁用通用保存', async () => {
    const page = ui(async () => ({ok: false, message: '写入失败'} as any));
    page.run('removeField(1)');
    page.bridge.enableSaveButton.mockClear();
    await page.save();
    expect(page.element('fieldsTip').textContent).toBe('写入失败');
    expect(page.run('JSON.stringify(fieldActive)')).toBe('["balance"]');
    expect(page.bridge.enableSaveButton).not.toHaveBeenCalled();
  });

  it('请求异常时显示错误并保留未保存草稿', async () => {
    const page = ui(async () => {throw new Error('连接中断');});
    page.run('removeField(1)');
    await page.save();
    expect(page.element('fieldsTip').textContent).toBe('连接中断');
    expect(page.element('draftState').textContent).toContain('草稿未保存');
    expect(page.element('fieldsSaveBtn').disabled).toBe(false);
  });

  it('保存请求未返回时继续编辑，不会被旧响应覆盖', async () => {
    let finish!: Function;
    const page = ui((payload) => new Promise(resolve => { finish = () => resolve({ok: true, fields: payload.fields}); }));
    page.run('removeField(1)');
    const saving = page.save();
    page.run("addField('latestMonthUsage')");
    finish(); await saving;
    expect(page.run('JSON.stringify(fieldActive)')).toBe('["balance","latestMonthUsage"]');
    expect(page.run('fieldSaved')).toBe('["balance"]');
    expect(page.element('fieldsTip').textContent).toContain('后续编辑仍为草稿');
  });

  it('切换户号后也不能用通用保存丢掉其他户号的名称草稿', () => {
    const page = ui();
    page.run("appearanceSaved.set('first', {name:'国家电网', showRegion:false}); appearanceDrafts.set('first', {name:'自家用电', showRegion:false}); updateDraftState();");
    expect(page.bridge.disableSaveButton).toHaveBeenCalled();
  });
});
