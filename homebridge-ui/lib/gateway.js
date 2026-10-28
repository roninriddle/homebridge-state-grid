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
const { renderJpeg } = loadDist('renderer/image-renderer.js');

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
    if (this.client) return this.client;

    const account = this.store.loadAccount();
    const username = credentials?.username || account?.username || '';
    // 短信登录不需要密码，所以这里只强制要求手机号；密码登录（/login）在
    // 前端已经做了「手机号与密码都要填」的校验，这里留空密码也能安全地发短信。
    const password = credentials?.password || this.store.loadPassword() || '';
    if (!username) {
      throw new Error('请先填写手机号');
    }

    const assembled = assembleProfile(this.store);
    this.client = new StateGridClient({
      profile: assembled.device,
      username,
      password,
      session: this.store.loadSession(),
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
    return {
      storagePath: this.storagePath,
      username: account && account.username ? maskPhone(account.username) : '',
      hasPassword: Boolean(account && account.passwordEnc),
      hasSession: Boolean(session && session.token),
      sessionExpiresAt: (session && session.expiresAt) || null,
      pending: this.pending ? { kind: this.pending.kind, sentAt: this.pending.at } : null,
      connected: Boolean(this.client && this.client.currentSession),
    };
  }

  /** 拉取户号列表（含各户号的最新快照）。 */
  async accounts() {
    const client = this.ensureClient();
    try {
      await client.ensureLogin();
      this.persistSession(client.currentSession);
      return { ok: true, accounts: this.accountsOf(client) };
    } catch (error) {
      return { ok: false, ...describeError(error) };
    }
  }

  accountsOf(client) {
    const session = client.currentSession;
    return client.accounts.map((account) => ({
      consNo: account.consNoSrc,
      consNoMasked: maskConsNo(account.consNoSrc),
      name: account.name || '',
      address: account.address || '',
      consType: account.consType || '',
      province: String((session && session.userInfo && session.userInfo.addressProvince) || ''),
    }));
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
      const theme = (options && options.theme) === 'dark' ? 'dark' : 'light';
      const card = {
        title: (options && options.title) || account.name || `用电 ${consNo.slice(-4)}`,
        primaryValue: snapshot.balance !== undefined ? snapshot.balance : snapshot.amountDue,
        primaryLabel: snapshot.balance !== undefined ? '账户余额' : '应交电费',
        latestDailyUsage: snapshot.latestDailyUsage,
        latestDailyDate: snapshot.latestDailyDate,
        currentMonthUsage: snapshot.currentMonthUsage,
        monthEstimateCharge: estimateCharge(snapshot),
        latestMonthUsage: snapshot.latestMonthUsage,
        latestMonthCharge: snapshot.latestMonthCharge,
        currentYearUsage: snapshot.currentYearUsage,
        currentYearCharge: snapshot.currentYearCharge,
        dailySeries: snapshot.dailySeries,
        updatedAt: snapshot.updatedAt,
        theme,
      };
      const jpeg = await renderJpeg(renderCompactCard(card), { width: 640, quality: 80 });
      return {
        ok: true,
        snapshot: summarize(snapshot),
        image: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      };
    } catch (error) {
      return { ok: false, ...describeError(error), snapshot: null };
    }
  }
}

function summarize(snapshot) {
  return {
    consNo: snapshot.consNo,
    latestDailyUsage: snapshot.latestDailyUsage ?? null,
    latestDailyDate: snapshot.latestDailyDate ?? null,
    currentMonthUsage: snapshot.currentMonthUsage ?? null,
    latestMonthUsage: snapshot.latestMonthUsage ?? null,
    latestMonthCharge: snapshot.latestMonthCharge ?? null,
    currentYearUsage: snapshot.currentYearUsage ?? null,
    currentYearCharge: snapshot.currentYearCharge ?? null,
    balance: snapshot.balance ?? null,
    amountDue: snapshot.amountDue ?? null,
    estimate: estimateCharge(snapshot) ?? null,
    updatedAt: snapshot.updatedAt,
    seriesDays: snapshot.dailySeries.length,
  };
}

/** 与平台层同一条估算规则：用最近结算月的实际均价反推本月。 */
function estimateCharge(snapshot) {
  const { latestMonthCharge, latestMonthUsage, currentMonthUsage } = snapshot;
  if (!latestMonthCharge || !latestMonthUsage || !currentMonthUsage) return undefined;
  const unitPrice = latestMonthCharge / latestMonthUsage;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return undefined;
  return Math.round(currentMonthUsage * unitPrice * 100) / 100;
}

function maskPhone(value) {
  const text = String(value);
  return text.length >= 11 ? `${text.slice(0, 3)}****${text.slice(-4)}` : text;
}

function maskConsNo(value) {
  const text = String(value);
  return text.length > 8 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
}

module.exports = { UiGateway, describeError, estimateCharge };
