import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { StateGridClient } from '../src/sgcc/client.js';
import { StateGridAuthenticationError, StateGridDeviceVerificationRequired, type DeviceProfile, type PowerAccount } from '../src/sgcc/types.js';
import { PluginStore, atomicWrite } from '../src/services/store.js';
import { StateGridPlatform } from '../src/platform.js';
import { resolveAppearance } from '../src/services/appearance.js';
import { renderCard } from '../src/renderer/card-svg.js';
import { estimateCharge } from '../src/services/summary.js';

const require = createRequire(import.meta.url);
const { UiGateway } = require('../homebridge-ui/lib/gateway.js');
const dirs: string[] = [];
function storage() { const dir = mkdtempSync(join(tmpdir(), 'sgcc-regression-')); dirs.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
const profile = {baseUrl: 'https://invalid.example', serverPublicKey: '', clientPrivateKey: ''} as DeviceProfile;
const session = () => ({token: 'test-token', userId: 'test-user', expiresAt: Date.now() + 3600000, userInfo: {}});
const account = {consNoSrc: 'test-account', consNo: 'opaque', name: '测试', accountId: 'a', proNo: 'p', orgNo: 'o', elecType: '01', consType: '01', address: '', raw: {}} as PowerAccount;
function client(password = 'test-password') { return new StateGridClient({profile, username: 'test-user', password, session: session()}) as any; }
const log = {info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn()};
function platform(dir: string) { return new StateGridPlatform(log as any, {} as any, {user: {storagePath: () => dir}, on: () => {}} as any) as any; }

describe('登录生命周期', () => {
  it('保留服务端有效期、嵌套 userId，并立即通知持久化', async () => {
    const save = vi.fn(); const c = new StateGridClient({profile, username: 'test-user', password: 'test-password', onSession: save}) as any;
    c.post = vi.fn().mockResolvedValue({code: '1', data: {bizrt: {token: 'fresh', tokenExpireTime: 1296000, userInfo: [{userId: 'nested-id'}]}}});
    const result = await c.smsLogin('123456', 'test-code-key');
    expect(result.userId).toBe('nested-id');
    expect(result.expiresAt - Date.now()).toBeGreaterThan(1295999000);
    expect(save).toHaveBeenCalledWith(result);
  });
  it('token 被提前撤销时仅重登一次再重试', async () => {
    const c = client(); c.post = vi.fn().mockResolvedValueOnce({code: '-200'}).mockResolvedValueOnce({code: '1', data: {ok: true}});
    c.login = vi.fn().mockImplementation(async () => {c.session = session(); return c.session;});
    await expect(c.authenticatedData('test', {})).resolves.toEqual({ok: true});
    expect(c.login).toHaveBeenCalledTimes(1); expect(c.post).toHaveBeenCalledTimes(2);
  });
  it('第二次 token 拒绝不会无限重试', async () => {
    const c = client(); c.post = vi.fn().mockResolvedValue({code: '-201'}); c.login = vi.fn().mockResolvedValue(session());
    await expect(c.authenticatedData('test', {})).rejects.toBeInstanceOf(StateGridAuthenticationError);
    expect(c.login).toHaveBeenCalledTimes(1); expect(c.post).toHaveBeenCalledTimes(2);
  });
  it('设备验证码不会静默重登', async () => {
    const c = client(); c.post = vi.fn().mockResolvedValue({code: '4006'}); c.login = vi.fn();
    await expect(c.authenticatedData('test', {})).rejects.toBeInstanceOf(StateGridDeviceVerificationRequired);
    expect(c.login).not.toHaveBeenCalled();
  });
  it('纯短信登录的有效会话可被主进程复用，无需密码', async () => {
    const dir = storage(); const store = new PluginStore(dir); store.saveAccount('test-user', undefined); store.saveSession(session());
    const p = platform(dir); await p.connect(); expect(p.client.currentSession.token).toBe('test-token'); p.stop();
  });
  it('旧版猜测有效期迁移为未知，用户 ID 从 userInfo 恢复', () => {
    const dir = storage(); const store = new PluginStore(dir);
    writeFileSync(join(dir, 'state-grid/session.json'), JSON.stringify({...session(), userId: '', expiresAt: 1, userInfo: {userId: 'nested'}}));
    expect(store.loadSession()).toMatchObject({userId: 'nested', expiresAt: 0});
  });
});

describe('业务数据边界', () => {
  it('rtnCode 失败不会伪装成空数据', async () => {
    const c = client(); c.authenticatedData = vi.fn().mockResolvedValue({rtnCode: 'E_TEST', rtnMsg: '拒绝'});
    await expect(c.queryDailyUsage(account, '2026-10-01', '2026-10-29')).rejects.toMatchObject({code: 'E_TEST'});
  });
  it('年度总量和嵌套月结算字段得以保留', async () => {
    const c = client(); c.authenticatedData = vi.fn().mockResolvedValue({yearPq: '1000', yearAmt: '500', list: [{ym: '202609', eleList: [{pq: '100', amt: '50'}, {pq: '20', amt: '10'}]}]});
    const bills = await c.queryMonthlyBills(account, 2026);
    expect(bills[0]).toMatchObject({month: '2026-09', usage: 120, charge: 60}); expect(bills.yearUsage).toBe(1000);
  });
  it('月度累计优先用服务端 totalPq，避免只加接口提供的几天', async () => {
    vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(new Date('2026-10-29T12:00:00+08:00'));
    const c = client(); c.queryDailyUsage = vi.fn().mockResolvedValue(Object.assign([{date: '2026-10-27', usage: 7}], {total: 200}));
    c.queryBalance = vi.fn().mockResolvedValue(null); c.queryMonthlyBills = vi.fn().mockResolvedValue([{month: '2026-09', usage: 100, charge: 50}]);
    const s = await c.snapshot(account); expect(s.currentMonthUsage).toBe(200); expect(s.currentMonthPartial).toBe(false);
    expect(c.queryDailyUsage).toHaveBeenCalledWith(account, '2026-10-01', '2026-10-29');
  });
  it('零用电估算是零；缺失值仍然未知', () => {
    expect(estimateCharge({latestMonthCharge: 50, latestMonthUsage: 100, currentMonthUsage: 0} as any)).toBe(0);
    expect(estimateCharge({latestMonthCharge: 50, latestMonthUsage: 0, currentMonthUsage: 1} as any)).toBeUndefined();
  });
  it('明确预付费类型的零余额不变成后付费', async () => {
    const c = client(); c.authenticatedData = vi.fn().mockResolvedValue({list: [{consType: '1', prepayBal: 0, sumMoney: 0}]});
    expect(await c.queryBalance(account)).toMatchObject({balance: 0, amountDue: undefined});
  });
});

describe('缓存和主进程恢复', () => {
  it('设备档案损坏时保留原文件，不重新生成身份', () => {
    const dir = storage(); const store = new PluginStore(dir); writeFileSync(store.deviceFile, '{broken');
    expect(() => store.loadProfile()).toThrow('设备档案损坏'); expect(readFileSync(store.deviceFile, 'utf8')).toBe('{broken');
  });
  it('原子写只留下完整目标文件', () => {
    const dir = storage(); const file = join(dir, 'state.json'); atomicWrite(file, '{"a":1}'); atomicWrite(file, '{"a":2}');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({a: 2}); expect(readdirSync(dir)).toEqual(['state.json']);
  });
  it('更换手机号不会继承旧密码', () => {
    const store = new PluginStore(storage()); store.saveAccount('first', 'secret'); store.saveAccount('second', undefined);
    expect(store.loadPassword()).toBeNull();
  });
  it('刷新失败重绘旧图并标记失败，鉴权错误进入验证流程', async () => {
    const p = platform(storage()); const entry = {camera: {stopStream: vi.fn()}, title: '测试', jpeg: Buffer.from('old'), snapshot: {updatedAt: 1}};
    p.entries.set(account.consNoSrc, entry); p.accounts = () => [account]; p.enabled = () => true; p.reconcileAccessories = vi.fn(); p.persistStatus = vi.fn(); p.paint = vi.fn();
    p.client = {snapshot: vi.fn().mockRejectedValue(new StateGridDeviceVerificationRequired('4006', 'verify')), currentSession: session()};
    await p.refreshAll(); expect(p.paint).toHaveBeenCalledWith(entry); expect(p.status.state).toBe('needs_verification'); p.stop();
  });
  it('同时触发刷新合并为一次取数', async () => {
    const p = platform(storage()); let done!: Function;
    p.doRefreshAll = vi.fn().mockReturnValue(new Promise((resolve) => {done = resolve;}));
    const first = p.refreshAll(); const second = p.refreshAll(); expect(first).toBe(second); expect(p.doRefreshAll).toHaveBeenCalledTimes(1); done(); await first; p.stop();
  });
});

describe('设置页草稿预览', () => {
  it('户号选择展示接口户名、完整户号、地址和停用状态，摄像头名独立', () => {
    const gateway = new UiGateway(storage());
    const identity = {consNo: '001234567890', consNoMasked: '0012****7890', name: '示例户主', address: '示例省示例市测试区示例路1号', title: '国家电网', enabled: false};
    gateway.store.saveAccountsCache({updatedAt: Date.now(), accounts: [identity]});
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = gateway.previewDraft({consNo: identity.consNo, fields: ['balance']});
    expect(result.account).toMatchObject({consNo: identity.consNo, name: identity.name, address: identity.address, enabled: false});
    expect(result.accounts[0].title).toBe([identity.name, identity.address, identity.consNo].join(' · '));
    expect(result.accounts[0].title).not.toContain('****');
    expect(result.appearance.name).toBe('国家电网');
    expect(gateway.store.loadAccountsCache().accounts[0]).toEqual(identity);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('模拟预览不联网、不保存草稿，不创建客户端', () => {
    const dir = storage(); const gateway = new UiGateway(dir); const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = gateway.previewDraft({fields: ['balance', 'currentMonthUsage'], theme: 'dark'});
    expect(result.ok).toBe(true); expect(result.source).toBe('sample'); expect(result.image.startsWith('data:image/png;base64,')).toBe(true);
    expect(gateway.store.loadFields()).toBeNull(); expect(gateway.client).toBeNull(); expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('停用户号按当前已保存指标重绘预览，不复用旧图也不请求网络', () => {
    const gateway = new UiGateway(storage());
    const identity = {consNo: '001234567890', name: '示例户主', address: '示例地址', enabled: false, data: {consNo: '001234567890', balance: 12, latestMonthUsage: 34, dailySeries: [], updatedAt: Date.now()}};
    gateway.store.saveAccountsCache({updatedAt: Date.now(), accounts: [identity]});
    gateway.store.saveCachedPreview(identity.consNo, Buffer.from('old-preview'));
    gateway.setFields(['balance', 'latestMonthUsage']);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const preview = gateway.cachedPreview(identity.consNo);
    expect(preview.ok).toBe(true); expect(preview.image).toMatch(/^data:image\/png;base64,/);
    expect(preview.fields).toEqual(['balance', 'latestMonthUsage']);
    expect(gateway.store.loadVisibility()).toEqual({});
    expect(gateway.store.loadAccountsCache().accounts[0].enabled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('保存零指标被明确拒绝', () => { const gateway = new UiGateway(storage()); expect(() => gateway.setFields([])).toThrow('至少保留'); });
  it('预览拒绝未知户号和路径穿越', () => { const gateway = new UiGateway(storage()); expect(gateway.previewDraft({consNo: '../secret'}).ok).toBe(false); expect(() => gateway.store.loadCachedPreview('../secret')).toThrow(); });
  it('运行状态取自主进程，而非 UI 自己的客户端', () => {
    const dir = storage(); const gateway = new UiGateway(dir); atomicWrite(join(gateway.store.cacheDir(), 'status.json'), JSON.stringify({state: 'error', message: '更新失败'}));
    gateway.client = {currentSession: session()}; expect(gateway.status()).toMatchObject({connected: false, runtimeState: 'error'});
  });
  it('短信登录重发保持 login 类型', async () => {
    const gateway = new UiGateway(storage()); gateway.credentials = {username: 'test-user', password: ''};
    gateway.client = {sendLoginSms: vi.fn().mockResolvedValue('test-key'), sendDeviceVerificationSms: vi.fn()};
    await gateway.sendSms('login'); await gateway.sendSms(gateway.pending.kind); expect(gateway.pending.kind).toBe('login'); expect(gateway.client.sendDeviceVerificationSms).not.toHaveBeenCalled();
  });
  it('设置页脚本语法有效，重发使用当前模式', () => {
    const html = readFileSync(join(process.cwd(), 'homebridge-ui/public/index.html'), 'utf8');
    expect(() => new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1])).not.toThrow();
    expect(html).toContain('kind: smsKind');
  });
});


describe('摄像头名称与地区显示', () => {
  it('默认名称与户号、地址无关，地区默认隐藏', () => {
    expect(resolveAppearance('12345678', '河北省示例市测试区*', undefined)).toEqual({name: '国家电网', showRegion: false, region: undefined});
    expect(resolveAppearance('87654321', '北京市测试区*', undefined).name).toBe('国家电网');
  });
  it('户号可单独命名，地区开关独立于名称', () => {
    const first = resolveAppearance('first', '河北省示例市测试区测试路1号', {name: '父母家用电', showRegion: true});
    const second = resolveAppearance('second', '河北省示例市测试区*', {name: '自家用电', showRegion: false});
    expect(first).toEqual({name: '父母家用电', showRegion: true, region: '河北省示例市测试区'});
    expect(second).toMatchObject({name: '自家用电', region: undefined});
  });
  it('保留显式配置名称，按户号的显示开关优先于全局', () => {
    const config = {showRegion: true, accounts: [{consNo: 'first', title: '客厅用电'}]};
    expect(resolveAppearance('first', '河南省新乡市红旗区*', {showRegion: false}, config)).toMatchObject({name: '客厅用电', region: undefined});
    expect(resolveAppearance('first', '河南省新乡市红旗区*', undefined, config).region).toBe('河南省新乡市红旗区');
  });
  it('名称与显示设置持久化且不改变字段顺序', () => {
    const store = new PluginStore(storage()); store.saveFields(['balance']); store.saveAppearance('first', {name: '父母家用电', showRegion: true});
    expect(store.loadAppearance()).toEqual({first: {name: '父母家用电', showRegion: true}}); expect(store.loadFields()).toEqual(['balance']);
    expect(() => store.saveAppearance('first', {name: '电', showRegion: true})).toThrow('2～32');
  });
  it('渲染器只在开启时输出地区，标题始终是摄像头名称', () => {
    const base = {title: '国家电网', primaryLabel: '账户余额', dailySeries: [], updatedAt: Date.now()};
    expect(renderCard(base)).not.toContain('河北省');
    expect(renderCard({...base, region: '河北省示例市测试区'})).toContain('河北省示例市测试区');
    expect(renderCard({...base, region: '河北省示例市测试区'})).toContain('国家电网');
  });
  it('只更改 HomeKit 名称特征，不更换配件 UUID', () => {
    const p = platform(storage()); const set = vi.fn(); const update = vi.fn(); const information = {setCharacteristic: set};
    p.api.hap = {Service: {AccessoryInformation: 'info'}, Characteristic: {Name: 'name', ConfiguredName: 'configured'}}; p.api.updatePlatformAccessories = update;
    const accessory = {UUID: 'unchanged-uuid', displayName: '旧户号名称', getService: () => information}; const entry = {accessory};
    p.applyAppearance(entry, account); expect(accessory.UUID).toBe('unchanged-uuid'); expect(accessory.displayName).toBe('国家电网');
    expect(set).toHaveBeenCalledWith('name', '国家电网'); expect(set).toHaveBeenCalledWith('configured', '国家电网'); p.stop();
  });
  it('名称和地区草稿可预览，但只有明确保存才落盘', () => {
    const gateway = new UiGateway(storage()); const cacheAccount = {consNo: 'first', consNoMasked: 'first', title: '旧地区标题', address: '河北省示例市测试区*', enabled: true};
    gateway.store.saveAccountsCache({updatedAt: Date.now(), accounts: [cacheAccount]});
    const result = gateway.previewDraft({consNo: 'first', name: '父母家用电', showRegion: true});
    expect(result.appearance).toMatchObject({name: '父母家用电', showRegion: true, region: '河北省示例市测试区'});
    expect(gateway.store.loadAppearance()).toEqual({});
    gateway.setAppearance({consNo: 'first', name: '父母家用电', showRegion: true});
    expect(gateway.previewDraft({consNo: 'first'}).appearance.name).toBe('父母家用电');
  });
});
