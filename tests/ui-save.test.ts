import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Script, createContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {UiGateway} = require('../homebridge-ui/lib/gateway.js');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });

function ui(hook = async (_path: string, _payload: any) => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sgcc-ui-save-')); dirs.push(dir);
  const other = {platform: 'OtherPlugin', name: '保留'};
  const original = {platform: 'StateGrid', _bridge: {username: '02:00:00:00:00:01', port: 50123}, updateIntervalHours: 12};
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({bridge: {name: '保留主桥'}, platforms: [other, original]}));
  const gateway = new UiGateway(dir);
  gateway.setFields(['balance', 'currentMonthUsage']);
  gateway.store.saveAccountsCache({updatedAt: Date.now(), accounts: [{consNo: 'first', name: '示例户主', enabled: false}]});
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {value: '', checked: false, disabled: false, textContent: '', innerHTML: '', listeners: new Map(),
      classList: {add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: () => true},
      addEventListener(event: string, callback: Function) { this.listeners.set(event, callback); }});
    return elements.get(id);
  };
  let blocks = [original] as any[];
  const bridge = {
    disableSaveButton: vi.fn(), enableSaveButton: vi.fn(),
    getPluginConfig: vi.fn(async () => structuredClone(blocks)),
    updatePluginConfig: vi.fn(async (next: any[]) => {blocks = structuredClone(next); return blocks;}),
    savePluginConfig: vi.fn(async () => { const cfg = JSON.parse(readFileSync(configFile, 'utf8')); cfg.platforms = [other, ...blocks]; writeFileSync(configFile, JSON.stringify(cfg)); }),
    request: vi.fn(async (path: string, payload: any) => {
      await hook(path, payload);
      if (path === '/card-draft') return gateway.cardDraft(payload);
      if (path === '/card-apply') return gateway.applyCardConfig();
      return {ok: true};
    }),
  };
  const context = createContext({window: {homebridge: bridge}, document: {getElementById: element}, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1});
  const html = readFileSync('homebridge-ui/public/index.html', 'utf8');
  new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]).runInContext(context);
  const run = (code: string) => new Script(code).runInContext(context);
  run("fieldActive = ['balance', 'currentMonthUsage']; fieldSaved = JSON.stringify(fieldActive); fieldsLoaded = true; updateDraftState();");
  return {dir, gateway, bridge, element, run, configFile, save: () => element('fieldsSaveBtn').listeners.get('click')(), ready: () => run('hostDraftReady'),
    bottomSave: async () => {await run('stageHostDraft()'); await bridge.savePluginConfig();}};
}

describe('原生保存与卡片保存统一', () => {
  it('草稿进入原生配置模型但不落盘，底部保存后下次读取生效', async () => {
    const page = ui(); page.run('removeField(1)'); await page.ready();
    expect(page.gateway.currentFields()).toEqual(['balance', 'currentMonthUsage']);
    expect(page.bridge.enableSaveButton).toHaveBeenCalled();
    await page.bottomSave();
    expect(new UiGateway(page.dir).fields().active).toEqual(['balance']);
    const config = JSON.parse(readFileSync(page.configFile, 'utf8'));
    expect(config.platforms[0]).toEqual({platform: 'OtherPlugin', name: '保留'});
    expect(config.platforms[1]._bridge).toEqual({username: '02:00:00:00:00:01', port: 50123});
  });

  it('保存卡片按钮也走相同 config.json 链路并确认应用', async () => {
    const page = ui(); page.run('removeField(1)'); await page.save();
    expect(page.bridge.savePluginConfig).toHaveBeenCalledOnce();
    expect(page.gateway.currentFields()).toEqual(['balance']);
    expect(page.element('draftState').textContent).toBe('当前配置已保存');
  });

  it('底部保存同时提交其他户号的名称草稿，保留停用状态', async () => {
    const page = ui();
    page.run("appearanceDrafts.set('first', {name:'自家用电', showRegion:true}); scheduleDraft();");
    await page.bottomSave();
    expect(new UiGateway(page.dir).appearanceFor('first', '河北省示例市测试区')).toMatchObject({name: '自家用电', showRegion: true});
    expect(page.gateway.store.loadAccountsCache().accounts[0].enabled).toBe(false);
  });

  it('原生保存失败时不谎报成功且保留草稿，可再次保存', async () => {
    const page = ui(); page.run('removeField(1)');
    page.bridge.savePluginConfig.mockRejectedValueOnce(new Error('连接中断'));
    await page.save();
    expect(page.element('fieldsTip').textContent).toBe('连接中断');
    expect(page.gateway.currentFields()).toEqual(['balance', 'currentMonthUsage']);
    expect(page.run('JSON.stringify(fieldActive)')).toBe('["balance"]');
    await page.save(); expect(page.gateway.currentFields()).toEqual(['balance']);
  });

  it('无效名称修正后底部保存可恢复，不会卡在旧的失败请求', async () => {
    const page = ui(); await page.run('stageHostDraft()');
    page.run("appearanceDrafts.set('first', {name:'电', showRegion:false}); scheduleDraft();");
    await expect(page.ready()).rejects.toThrow('2～32');
    page.run("appearanceDrafts.clear(); scheduleDraft();");
    await page.bottomSave();
    expect(page.bridge.enableSaveButton).toHaveBeenCalled();
    expect(new UiGateway(page.dir).fields().active).toEqual(['balance', 'currentMonthUsage']);
  });

  it('快速连续编辑只把最新草稿送入底部保存模型', async () => {
    let finish!: () => void;
    let first = true;
    const page = ui(async (path) => {if(path === '/card-draft' && first) {first = false; await new Promise<void>(resolve => {finish = resolve;});}});
    page.run('removeField(1)'); await Promise.resolve(); await Promise.resolve();
    page.run("addField('latestMonthUsage')"); finish();
    await page.bottomSave();
    expect(new UiGateway(page.dir).fields().active).toEqual(['balance', 'latestMonthUsage']);
  });
});
