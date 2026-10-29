/**
 * 插件设置页的后端逻辑。
 *
 * 这一层刻意不碰 Homebridge：`homebridge-ui/server.js` 只做协议适配，
 * 所有真正干活的东西都在这里，于是可以在命令行里直接跑起来自测
 * （`node tools/ui-probe.mjs`），不必先装一套 Homebridge。
 *
 * 依赖的是**编译产物** dist/**：设置页和主进程走同一套协议实现，
 * 不存在"设置页能登录、主进程登不上"这类漂移。
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const DIST = path.join(__dirname, '..', '..', 'dist');

/** dist 还没编译时给一句人话，而不是 MODULE_NOT_FOUND。 */
function loadDist(relative) {
  const file = path.join(DIST, relative);
  try {
    return require(file);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes(DIST)) {
      throw new Error(`插件尚未编译（缺 dist/${relative}），请先在插件目录执行 npm run build`);
    }
    throw error;
  }
}

const { PluginStore } = loadDist('services/store.js');
const { assembleProfile } = loadDist('services/device-profile.js');
const { StateGridClient } = loadDist('sgcc/client.js');
const { renderCompactCard } = loadDist('renderer/card-svg.js');
const { renderJpeg, renderPng } = loadDist('renderer/image-renderer.js');
const { resolveAppearance } = loadDist('services/appearance.js');
const { snapshotToCard, cachedSnapshot } = loadDist('services/card.js');
const {
  FIELD_KEYS,
  FIELD_META,
  DEFAULT_FIELD_ORDER,
  normalizeFieldOrder,
} = loadDist('renderer/fields.js');
const {
  estimateCharge,
  summarizeSnapshot,
  maskConsNo,
  maskPhone,
  regionFromAddress,
} = loadDist('services/summary.js');

/** 把异常翻译成前端能判断的结构，避免把堆栈直接甩给用户。 */
function describeError(error) {
  const name = (error && error.constructor && error.constructor.name) || 'Error';
  const code = error && error.code ? String(error.code) : '';
  const message = (error && error.message) || String(error);

  /** @type {'ok' | 'need_device_sms' | 'need_challenge' | 'bad_credentials' | 'network' | 'error'} */
  let reason = 'error';
  if (name === 'StateGridDeviceVerificationRequired') reason = 'need_device_sms';
  else if (name === 'StateGridInteractiveChallengeRequired') reason = 'need_challenge';
  else if (name === 'StateGridAuthenticationError') reason = 'bad_credentials';
  else if (name === 'StateGridNetworkError') reason = 'network';

  return { reason, code, message };
}

class UiGateway {
  /** @param {string} storagePath Homebridge 的 storage 目录 */
  constructor(storagePath) {
    this.storagePath = storagePath;
    this.store = new PluginStore(storagePath);
    /** @type {import('../dist/sgcc/client.js').StateGridClient | null} */
    this.client = null;
    /** 短信验证码的中间状态：codeKey 只在本次会话内有效。 */
    this.pending = null;
  }

  // ---------------------------------------------------------------- 会话

  /**
   * 建（或复用）一个已经完成设备档案装配的客户端。
   *
   * 关键点：设备档案必须来自磁盘上那份种子，绝不能在这里新生成一份——
   * 否则设置页登录时是一次"新设备登录"，主进程又变成另一次，
   * 服务端会接连下发两条短信验证。
   */
  ensureClient(credentials) {
    if (credentials?.username && this.credentials?.username && credentials.username !== this.credentials.username) this.resetClient();
    if (this.client) return this.client;

    const account = this.store.loadAccount();
    const username = credentials?.username || account?.username || '';
    // 短信登录不需要密码，所以这里只强制要求手机号；密码登录（/login）在
    // 前端已经做了「手机号与密码都要填」的校验，这里留空密码也能安全地发短信。
    const password = credentials?.password || (username === account?.username ? this.store.loadPassword() : '') || '';
    if (!username) {
      throw new Error('请先填写手机号');
    }

    const assembled = assembleProfile(this.store);
    this.client = new StateGridClient({
      profile: assembled.device,
      username,
      password,
      session: !account || account.username === username ? this.store.loadSession() : null,
      onSession: (session) => this.store.saveSession(session),
      profileProvider: () => {
        const refreshed = assembled.refresh();
        return {
          ...assembled.device,
          deviceTokenTx: refreshed.token,
          deviceTokenTxTime: refreshed.tokenTime,
        };
      },
    });
    this.credentials = { username, password };
    return this.client;
  }

  /** 丢弃内存里的客户端（改了手机号/密码时必须重建）。 */
  resetClient() {
    this.client = null;
    this.pending = null;
  }

  /** 登录成功后落盘：手机号、密码（加密）、省份，主进程随后直接可用。 */
  persistSession(session) {
    const province = String((session && session.userInfo && session.userInfo.addressProvince) || '');
    this.store.saveSession(session);
    this.store.saveAccount(
      this.credentials.username,
      this.credentials.password,
      province || (this.store.loadAccount() || {}).region,
    );
  }

  // ---------------------------------------------------------------- 动作

  async login(credentials) {
    if (credentials && (credentials.username || credentials.password)) this.resetClient();
    const client = this.ensureClient(credentials);
    try {
      const session = await client.login();
      this.persistSession(session);
      this.pending = null;
      return { ok: true, accounts: this.accountsOf(client) };
    } catch (error) {
      const described = describeError(error);
      if (described.reason === 'need_device_sms') {
        // 记下"这次登录是卡在验证码上"，前端据此把发送验证码按钮点亮。
        this.pending = { kind: 'device', codeKey: '', at: Date.now() };
        // 关键：先把凭据落盘。设置页 server 进程会随页面关闭而终止，
        // 下次打开是全新进程，若不落盘，发验证码/提交验证码就会用空账号
        // 发请求，网关会返回 RK007 之类的异常。
        this.persistCredentialsOnly();
      }
      return { ok: false, ...described };
    }
  }

  /**
   * 只落盘凭据、不落盘 session（此时还没有拿到 token）。
   * 用于"登录走到短信验证"这个中间态，保证换页/重开设置页后凭据还在。
   */
  persistCredentialsOnly() {
    const username = this.credentials?.username;
    const password = this.credentials?.password;
    if (!username) return;
    const region = (this.store.loadAccount() || {}).region;
    this.store.saveAccount(username, password || undefined, region);
  }

  /**
   * 请求短信验证码。
   * `kind=device` 用于新设备校验（登录返回 4006 后），`kind=login` 用于短信验证码登录。
   * 短信登录允许只传手机号（不填密码也能发码）。
   */
  async sendSms(kind, username) {
    const client = this.ensureClient(username ? { username } : undefined);
    try {
      const codeKey =
        kind === 'login' ? await client.sendLoginSms() : await client.sendDeviceVerificationSms();
      this.persistCredentialsOnly();
      this.pending = { kind: kind === 'login' ? 'login' : 'device', codeKey, at: Date.now() };
      return { ok: true, codeKey };
    } catch (error) {
      return { ok: false, ...describeError(error) };
    }
  }

  /**
   * 提交验证码。按 pending.kind 分流到两条不同的协议：
   *  - kind='device'：新设备校验（businessType=logindevice），验证码要随「密码登录」一起
   *    重新提交（等价上游 config_flow 里的 async_login(verification_code, code_key)）；
   *  - kind='login'：短信验证码登录（businessType=login），走独立的 smsLogin 接口。
   */
  async verify(code) {
    if (!this.pending || !this.pending.codeKey) {
      return { ok: false, reason: 'error', message: '请先点击发送验证码' };
    }
    if (!/^\d{6}$/.test(String(code || ''))) {
      return { ok: false, reason: 'error', message: '验证码应为 6 位数字' };
    }
    const client = this.ensureClient();
    try {
      const session =
        this.pending.kind === 'login'
          ? await client.smsLogin(String(code), this.pending.codeKey)
          : await client.login({ verificationCode: String(code), codeKey: this.pending.codeKey });
      this.persistSession(session);
      this.pending = null;
      return { ok: true, accounts: this.accountsOf(client) };
    } catch (error) {
      return { ok: false, ...describeError(error) };
    }
  }

  /** 只读状态：不触发任何网络请求，设置页打开时先渲染这个。 */
  status() {
    const account = this.store.loadAccount();
    const session = this.store.loadSession();
    const runtime = this.store.loadRuntimeStatus();
    return {
      storagePath: this.storagePath,
      username: account && account.username ? maskPhone(account.username) : '',
      hasPassword: Boolean(account && account.passwordEnc),
      hasSession: Boolean(session && session.token),
      sessionExpiresAt: (session && session.expiresAt) || null,
      pending: this.pending ? { kind: this.pending.kind, sentAt: this.pending.at } : null,
      connected: runtime?.state === 'ready',
      runtimeState: runtime?.state ?? 'starting',
      runtimeMessage: runtime?.message ?? '等待主进程启动',
      build: '0.7.0',
    };
  }

  /** 拉取户号列表（联网，仅点「刷新」时调用），成功后回写缓存。 */
  async accounts() {
    const client = this.ensureClient();
    try {
      await client.ensureLogin();
      this.persistSession(client.currentSession);
      const accounts = this.accountsOf(client);
      this.mergeAccountsCache(accounts);
      return { ok: true, accounts };
    } catch (error) {
      return { ok: false, ...describeError(error) };
    }
  }

  /**
   * 读缓存里的户号列表 + 快照摘要（纯本地，不联网）。
   * 设置页打开时先渲染这个，避免反复触发国网的短信/密码风控（RK007 超时）。
   */
  cachedAccounts() {
    const cache = this.store.loadAccountsCache();
    if (!cache || !Array.isArray(cache.accounts)) {
      return { ok: true, updatedAt: null, accounts: [] };
    }
    return { ok: true, updatedAt: cache.updatedAt, accounts: cache.accounts };
  }

  /** 读缓存里的单户号预览图（纯本地，不联网）。 */
  cachedPreview(consNo) {
    if (!this.store.loadAccountsCache()?.accounts.some((a) => a.consNo === consNo)) return { ok: false, message: '户号不在缓存中' };
    const jpeg = this.store.loadCachedPreview(String(consNo));
    if (!jpeg) return { ok: false, reason: 'error', message: '暂无缓存预览' };
    return { ok: true, image: `data:image/jpeg;base64,${jpeg.toString('base64')}` };
  }

  accountsOf(client) {
    const session = client.currentSession;
    const visibility = this.store.loadVisibility();
    return client.accounts.map((account) => ({
      consNo: account.consNoSrc,
      consNoMasked: maskConsNo(account.consNoSrc),
      name: account.name || '',
      address: account.address || '',
      consType: account.consType || '',
      title: this.appearanceFor(account.consNoSrc, account.address).name,
      province: String((session && session.userInfo && session.userInfo.addressProvince) || ''),
      enabled: visibility[account.consNoSrc] !== false,
    }));
  }

  /** 户号显示名：只取地区，不暴露脱敏真实姓名。 */
  titleOf(account) {
    return this.appearanceFor(account.consNoSrc, account.address).name;
  }

  /** 把联网拉到的户号元信息合并进缓存，保留已有快照摘要。 */
  mergeAccountsCache(accounts) {
    const previous = this.store.loadAccountsCache();
    const byConsNo = new Map((previous?.accounts || []).map((a) => [a.consNo, a]));
    for (const account of accounts) {
      const prev = byConsNo.get(account.consNo);
      byConsNo.set(account.consNo, {
        consNo: account.consNo,
        consNoMasked: account.consNoMasked,
        name: account.name,
        address: account.address,
        consType: account.consType,
        title: account.title,
        enabled: account.enabled,
        lastSuccess: prev?.lastSuccess ?? null,
        lastError: prev?.lastError ?? null,
        snapshot: prev?.snapshot ?? null,
        data: prev?.data,
      });
    }
    this.store.saveAccountsCache({ updatedAt: Date.now(), accounts: [...byConsNo.values()] });
  }

  /** 单户号预览完成后，把快照摘要回写进缓存。 */
  mergeSnapshotCache(consNo, snapshot) {
    const cache = this.store.loadAccountsCache();
    if (!cache || !Array.isArray(cache.accounts)) return;
    const accounts = cache.accounts.map((a) =>
      a.consNo === consNo
        ? { ...a, data: snapshot, snapshot: summarizeSnapshot(snapshot), lastSuccess: Date.now(), lastError: null }
        : a,
    );
    this.store.saveAccountsCache({ ...cache, accounts, updatedAt: Date.now() });
  }

  /** 设置页切换某户号是否生成卡片。 */
  setAccountVisibility(consNo, enabled) {
    if (!consNo) return { ok: false, reason: 'error', message: '缺少户号' };
    if (!this.store.loadAccountsCache()?.accounts.some((a) => a.consNo === consNo)) throw new Error('户号不在缓存中');
    this.store.setAccountVisibility(String(consNo), enabled !== false);
    return { ok: true };
  }

  /**
   * 读取卡片指标配置：当前生效的字段顺序 + 完整字段目录。
   * 目录含 label/unit/estimated，供设置页渲染勾选列表（单一数据源，避免前后端漂移）。
   */
  fields() {
    const stored = this.store.loadFields();
    return {
      ok: true,
      active: normalizeFieldOrder(stored?.length ? stored : this.displayConfig().fields),
      catalog: FIELD_KEYS.map((key) => ({
        key,
        label: FIELD_META[key].label,
        unit: FIELD_META[key].unit,
        estimated: Boolean(FIELD_META[key].estimated),
      })),
      defaults: [...DEFAULT_FIELD_ORDER],
    };
  }

  /** 保存卡片指标配置（字段顺序 = 显示顺序，不在列表里 = 不显示）。 */
  setFields(fields) {
    if (!Array.isArray(fields) || fields.length === 0) throw new Error('请至少保留一个指标');
    const valid = normalizeFieldOrder(fields);
    this.store.saveFields(valid);
    return { ok: true, fields: valid };
  }

  /** 当前生效的字段顺序（设置页预览与主进程保持一致）。 */
  currentFields() {
    const stored = this.store.loadFields();
    return normalizeFieldOrder(stored?.length ? stored : this.displayConfig().fields);
  }

  displayConfig() {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(this.storagePath, 'config.json'), 'utf8'));
      return (config.platforms || []).find((item) => item.platform === 'StateGrid') || {};
    } catch { return {}; }
  }

  appearanceFor(consNo, address, config = this.displayConfig()) {
    return resolveAppearance(consNo, address || '', this.store.loadAppearance()[consNo], config);
  }

  setAppearance(payload = {}) {
    const account = this.store.loadAccountsCache()?.accounts.find((item) => item.consNo === payload.consNo);
    if (!account) throw new Error('请先选择已有户号');
    this.store.saveAppearance(payload.consNo, { name: payload.name, showRegion: payload.showRegion });
    return { ok: true, appearance: this.appearanceFor(payload.consNo, account.address) };
  }

  /** 草稿仅重绘本地缓存；绝不创建客户端或请求国网，也不改正式配置。 */
  previewDraft(payload = {}) {
    const config = this.displayConfig();
    const accounts = this.store.loadAccountsCache()?.accounts || [];
    const account = payload.consNo ? accounts.find((item) => item.consNo === payload.consNo) : accounts.find((item) => item.enabled && cachedSnapshot(item.data ?? item.snapshot)) || accounts.find((item) => item.enabled) || accounts[0];
    if (payload.consNo && !account) return { ok: false, message: '户号不在缓存中' };
    const snapshot = cachedSnapshot(account?.data ?? account?.snapshot);
    const source = snapshot ? 'cache' : 'sample';
    const data = snapshot || {
      consNo: '', name: '模拟数据', balance: 123.45, latestDailyUsage: 6.28,
      latestDailyDate: '2026-10-27', currentMonthUsage: 187.4,
      latestMonth: '2026-09', latestMonthUsage: 302.1, latestMonthCharge: 158.9,
      currentYearUsage: 2311.3, currentYearCharge: 1210.4, latestPeakUsage: 2.1,
      latestValleyUsage: 3.2, latestFlatUsage: 0.98, latestSharpUsage: 0,
      monthPeakUsage: 60, monthValleyUsage: 100, monthFlatUsage: 27.4,
      ladderLevel: 1, penalty: 0, historyOwe: 0, dailySeries: [], updatedAt: Date.now(),
    };
    const fields = normalizeFieldOrder(payload.fields ?? this.currentFields());
    const theme = payload.theme === 'dark' || payload.theme === 'light' ? payload.theme : config.theme || 'light';
    const savedAppearance = this.appearanceFor(account?.consNo || '', account?.address || '', config);
    const draftAppearance = { ...this.store.loadAppearance()[account?.consNo || ''] };
    if (typeof payload.name === 'string') draftAppearance.name = payload.name.trim().slice(0, 64);
    if (typeof payload.showRegion === 'boolean') draftAppearance.showRegion = payload.showRegion;
    const appearance = resolveAppearance(account?.consNo || '', account?.address || '', draftAppearance, config);
    const title = appearance.name;
    const staleNote = source === 'sample' ? '模拟数据 · 仅供排版预览' : account?.lastError ? '最近更新失败 · 显示缓存' : Date.now() - data.updatedAt > 26 * 3600000 ? '数据未更新 · 显示缓存' : undefined;
    const png = renderPng(renderCompactCard(snapshotToCard(data, { title, region: appearance.region, fields, theme, staleNote })), { width: 960 });
    return { ok: true, image: 'data:image/png;base64,' + png.toString('base64'), source, updatedAt: snapshot?.updatedAt ?? null, fields, theme,
      appearance, savedAppearance, accounts: accounts.map((a) => ({consNo: a.consNo, title: this.appearanceFor(a.consNo, a.address).name + ' · ' + a.consNoMasked})), selected: account?.consNo ?? '' };
  }

  /**
   * 单个户号的完整数据 + 卡片预览。
   *
   * 预览图按 640 宽渲染：设置页里只是让人确认"卡片长得对不对"，
   * 用 1920 原图既慢又没必要。
   */
  async preview(consNo, options) {
    const client = this.ensureClient();
    const account = client.accounts.find((item) => item.consNoSrc === consNo);
    if (!account) return { ok: false, reason: 'error', message: '户号不在当前登录账号下' };
    try {
      const snapshot = await client.snapshot(account);
      const config = this.displayConfig();
      const theme = options?.theme || config.theme || 'light';
      const appearance = this.appearanceFor(consNo, account.address, config);
      const card = snapshotToCard(snapshot, { title: appearance.name, region: appearance.region, theme, fields: this.currentFields() });
      const jpeg = await renderJpeg(renderCompactCard(card), { width: 640, quality: 80 });
      // 回写缓存：预览图 + 快照摘要，供下次打开设置页离线展示。
      this.store.saveCachedPreview(account.consNoSrc, jpeg);
      this.mergeSnapshotCache(account.consNoSrc, snapshot);
      return {
        ok: true,
        snapshot: summarizeSnapshot(snapshot),
        image: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      };
    } catch (error) {
      return { ok: false, ...describeError(error), snapshot: null };
    }
  }
}

module.exports = { UiGateway, describeError, estimateCharge };
