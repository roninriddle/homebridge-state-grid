/**
 * 网上国网 App 网关客户端。
 *
 * 设计约束：
 *  - 传输层与业务层分离，任何 Homebridge 概念都不出现在这里；
 *  - 只在确有必要时重试，绝不对 4006/RK008 这类需要人工介入的错误反复重试；
 *  - 字段缺失一律返回 undefined，不用 0 填充（0 会被误读成"这个月没用电"）。
 */

import {
  buildRequestEnvelope,
  decryptResponseEnvelope,
  type RequestEnvelope,
} from './crypto.js';
import {
  AUTH_ERROR_CODES,
  DEVICE_VERIFICATION_CODE,
  INTERACTIVE_CHALLENGE_CODES,
  StateGridApiError,
  StateGridAuthenticationError,
  StateGridDeviceVerificationRequired,
  StateGridError,
  StateGridInteractiveChallengeRequired,
  StateGridNetworkError,
  powerAccounts,
  type DeviceProfile,
  type LoginSession,
  type PowerAccount,
  type AccountSnapshot,
} from './types.js';
import {
  buildDeviceSmsPayload,
  buildLoginSmsPayload,
  buildPasswordLoginMap,
  buildSmsLoginMap,
  loginHeaderMd5,
  type LoginMapContext,
} from './login.js';
import {
  PATHS,
  buildAccountBalancePayload,
  buildDailyUsagePayload,
  buildMeterPayload,
  buildMonthlyBillsPayload,
  formatDate,
  loginTimestamp,
  requestTimestamp,
} from './payloads.js';

export interface ClientOptions {
  profile: DeviceProfile;
  username: string;
  password: string;
  session?: LoginSession | null;
  /** 每次请求前刷新设备 token（App 的 4 小时缓存行为）。 */
  profileProvider?: () => Promise<DeviceProfile> | DeviceProfile;
  /** 注入 fetch 以便测试。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DailyReading {
  date: string;
  usage?: number;
  charge?: number;
}

export interface MonthlyBill {
  month: string;
  usage?: number;
  charge?: number;
}

export interface BalanceInfo {
  consType: string;
  /** 预付费余额，正数表示还有余额。 */
  balance?: number;
  /** 后付费应交金额，正数表示欠费。 */
  amountDue?: number;
  historyOwe?: number;
  date: string;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class StateGridClient {
  private profile: DeviceProfile;
  private session: LoginSession | null;
  private readonly username: string;
  private readonly password: string;
  private readonly profileProvider?: () => Promise<DeviceProfile> | DeviceProfile;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private loginInFlight: Promise<LoginSession> | null = null;

  constructor(options: ClientOptions) {
    this.profile = options.profile;
    this.session = options.session ?? null;
    this.username = options.username;
    this.password = options.password;
    this.profileProvider = options.profileProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get currentSession(): LoginSession | null {
    return this.session;
  }

  get accounts(): PowerAccount[] {
    return this.session ? powerAccounts(this.session.userInfo) : [];
  }

  private context(): LoginMapContext {
    return {
      pushId: this.profile.pushId,
      pushTokenAli: this.profile.pushTokenAli,
      cityId: this.profile.addressCity,
      provinceId: this.profile.addressProvince,
      districtId: this.profile.addressRegion,
      isEncrypt: false,
      deviceIp: this.profile.deviceIp,
      deviceId: this.profile.deviceId,
      androidRelease: this.profile.androidRelease,
      operatorType: this.profile.operatorType,
      deviceModel: this.profile.deviceModel,
      code: '',
      codeKey: '',
      avalonValidCode: '',
    };
  }

  private province(): string {
    const value = this.session?.userInfo.addressProvince;
    if (value !== undefined && value !== null && value !== '') return String(value);
    return this.profile.provinceHeader || this.profile.addressProvince;
  }

  private headers(
    authenticated: boolean,
    loginParams?: Record<string, unknown>,
    session?: LoginSession | null,
  ): Record<string, string> {
    const current = authenticated ? session ?? this.session : null;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=UTF-8',
      timeStamp: loginParams ? loginTimestamp() : requestTimestamp(),
      t: current?.token ?? '',
      userid: current?.userId || '0',
      AppGuid: this.profile.appGuid,
      AppGuidNew: appGuidNew(),
      security: 'android',
      appcode: 'WSGW-SG1001-APP',
      datacenter: this.profile.datacenter,
      AccessMethod: 'App',
      deviceTokenTX: this.profile.deviceTokenTx,
      deviceTokenTXTime: this.profile.deviceTokenTxTime,
      province: authenticated ? this.province() : '',
      version: '3.2.3',
      wsgwType: 'android',
      ip: this.profile.deviceIp,
      os: 'android',
      'User-Agent': 'okhttp/3.14.9',
    };
    if (loginParams) headers.md5 = loginHeaderMd5(loginParams);
    return headers;
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
    options: {
      authenticated: boolean;
      loginParams?: Record<string, unknown>;
      session?: LoginSession | null;
    },
  ): Promise<Record<string, unknown>> {
    const session = options.authenticated ? options.session ?? this.session : null;

    if (this.profileProvider) {
      this.profile = await this.profileProvider();
    }

    const envelope: RequestEnvelope = buildRequestEnvelope(payload, {
      serverPublicKey: this.profile.serverPublicKey,
    });
    const url = `${this.profile.baseUrl.replace(/\/+$/, '')}/${path}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(options.authenticated, options.loginParams, session),
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new StateGridNetworkError(
        `无法连接网上国网网关：${(error as Error).message}`,
      );
    }

    if (response.status >= 500) {
      throw new StateGridNetworkError(`网关返回 HTTP ${response.status}`);
    }
    let outer: Record<string, unknown>;
    try {
      outer = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new StateGridNetworkError('网关返回的不是合法 JSON');
    }
    if (!outer.respKey || !outer.encryptData) {
      throw new StateGridNetworkError('响应缺少加密字段，可能被网关拦截');
    }
    let plain: unknown;
    try {
      plain = decryptResponseEnvelope(
        outer as { respKey: string; encryptData: string },
        this.profile.clientPrivateKey,
      );
    } catch (error) {
      throw new StateGridNetworkError(
        `无法解密网关响应：${(error as Error).message}`,
      );
    }
    const record = asRecord(plain);
    if (!record) throw new StateGridNetworkError('网关响应不是 JSON 对象');
    return record;
  }

  /** 把网关错误码翻译成可区分的异常类型。 */
  private raiseForError(response: Record<string, unknown>): Record<string, unknown> {
    const topCode = String(response.code ?? '');
    const data = asRecord(response.data) ?? {};
    const server = asRecord(data.srvrt);
    const serverCode = server ? String(server.resultCode ?? '') : '';
    let message = String(response.message ?? '');
    if (server && server.resultMessage !== undefined) {
      message = String(server.resultMessage);
    }
    const code = serverCode || topCode;
    const source = serverCode ? 'srvrt' : 'gateway';

    if (code === DEVICE_VERIFICATION_CODE) {
      throw new StateGridDeviceVerificationRequired(code, message, source);
    }
    if (INTERACTIVE_CHALLENGE_CODES.has(code)) {
      throw new StateGridInteractiveChallengeRequired(code, message, source);
    }
    if (AUTH_ERROR_CODES.has(code)) {
      throw new StateGridAuthenticationError(code, message, source);
    }
    if (serverCode && serverCode !== '0000') {
      throw new StateGridApiError(serverCode, message, 'srvrt');
    }
    if (topCode !== '' && topCode !== '1') {
      throw new StateGridApiError(topCode, message || String(response.message ?? ''), 'gateway');
    }
    return data;
  }

  private raiseForBusinessError(data: Record<string, unknown>, operation: string): void {
    const server = asRecord(data.srvrt);
    if (!server) return;
    const code = String(server.resultCode ?? '');
    if (code && code !== '0000') {
      throw new StateGridApiError(
        code,
        String(server.resultMessage ?? operation),
        'business',
      );
    }
  }

  async login(options: { verificationCode?: string; codeKey?: string } = {}): Promise<LoginSession> {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = this.doLogin(options).finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async doLogin(
    options: { verificationCode?: string; codeKey?: string },
  ): Promise<LoginSession> {
    const verificationCode = options.verificationCode ?? '';
    const codeKey = options.codeKey ?? '';
    if (Boolean(verificationCode) !== Boolean(codeKey)) {
      throw new Error('verificationCode 与 codeKey 必须同时提供');
    }
    if (verificationCode && !/^\d{6}$/.test(verificationCode)) {
      throw new Error('短信验证码必须是 6 位数字');
    }

    const context: LoginMapContext = {
      ...this.context(),
      code: verificationCode,
      codeKey,
    };
    const params = buildPasswordLoginMap(this.username, this.password, context);
    this.session = null;

    const response = await this.post(PATHS.login, params, {
      authenticated: false,
      loginParams: params,
    });

    let data: Record<string, unknown>;
    try {
      data = this.raiseForError(response);
    } catch (error) {
      if (
        error instanceof StateGridDeviceVerificationRequired ||
        error instanceof StateGridInteractiveChallengeRequired
      ) {
        throw error;
      }
      if (error instanceof StateGridApiError) {
        throw new StateGridAuthenticationError(error.code, error.message, error.source);
      }
      throw error;
    }

    const bizrt = asRecord(data.bizrt);
    if (!bizrt || !bizrt.token) {
      throw new StateGridAuthenticationError('invalid_auth', '登录未返回 token');
    }
    this.session = this.saveSession(bizrt);
    return this.session;
  }

  private saveSession(bizrt: Record<string, unknown>): LoginSession {
    const raw = bizrt.userInfo;
    let userInfo: Record<string, unknown> = {};
    if (Array.isArray(raw)) {
      userInfo = asRecord(raw.find((item) => asRecord(item))) ?? {};
    } else {
      userInfo = asRecord(raw) ?? {};
    }
    const expires = Number(bizrt.expiresIn ?? bizrt.expireIn ?? 0);
    return {
      token: String(bizrt.token),
      userId: String(bizrt.userId ?? bizrt.userid ?? ''),
      expiresAt: Number.isFinite(expires) && expires > 0
        ? Date.now() + expires * 1000
        : Date.now() + 30 * 60 * 1000,
      userInfo,
    };
  }

  /** 触发新设备短信验证码。返回服务端的 codeKey。 */
  async sendDeviceVerificationSms(): Promise<string> {
    const payload = buildDeviceSmsPayload(this.username, this.context());
    const response = await this.post(PATHS.deviceSms, payload, { authenticated: false });
    const data = this.raiseForError(response);
    return String(data.codeKey ?? data.bizrt ?? '');
  }

  async sendLoginSms(): Promise<string> {
    const payload = buildLoginSmsPayload(this.username, this.context());
    const response = await this.post(PATHS.deviceSms, payload, { authenticated: false });
    const data = this.raiseForError(response);
    return String(data.codeKey ?? data.bizrt ?? '');
  }

  async smsLogin(code: string, codeKey: string): Promise<LoginSession> {
    const params = buildSmsLoginMap(this.username, code, codeKey, this.context());
    const response = await this.post(PATHS.smsLogin, params, {
      authenticated: false,
      loginParams: params,
    });
    const data = this.raiseForError(response);
    const bizrt = asRecord(data.bizrt);
    if (!bizrt || !bizrt.token) {
      throw new StateGridAuthenticationError('invalid_auth', '短信登录未返回 token');
    }
    this.session = this.saveSession(bizrt);
    return this.session;
  }

  async ensureLogin(): Promise<LoginSession> {
    if (this.session && this.session.expiresAt > Date.now()) return this.session;
    return this.login();
  }

  /** 带一次自动重登的鉴权请求。 */
  private async authenticatedData(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const session = await this.ensureLogin();
    let response: Record<string, unknown>;
    try {
      response = await this.post(path, payload, { authenticated: true, session });
    } catch (error) {
      if (!(error instanceof StateGridAuthenticationError)) throw error;
      await this.login();
      response = await this.post(path, payload, { authenticated: true });
    }
    return this.raiseForError(response);
  }

  async queryDailyUsage(
    account: PowerAccount,
    startDate: string,
    endDate: string,
  ): Promise<DailyReading[]> {
    const data = await this.authenticatedData(
      PATHS.dailyUsage,
      buildDailyUsagePayload(account, startDate, endDate),
    );
    this.raiseForBusinessError(data, '日用电查询');
    const raw = data.sevenEleList;
    if (!Array.isArray(raw)) return [];
    const readings: DailyReading[] = [];
    for (const item of raw) {
      const record = asRecord(item);
      if (!record) continue;
      const date = String(record.day ?? record.ymd ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      readings.push({
        date,
        usage: numberOrUndefined(record.dayElePq),
        charge: numberOrUndefined(record.thisAmt),
      });
    }
    return readings.sort((a, b) => a.date.localeCompare(b.date));
  }

  async queryMonthlyBills(account: PowerAccount, year: number): Promise<MonthlyBill[]> {
    const data = await this.authenticatedData(
      PATHS.monthlyBills,
      buildMonthlyBillsPayload(account, year),
    );
    this.raiseForBusinessError(data, '月度账单查询');
    const raw = Array.isArray(data.list)
      ? data.list
      : Array.isArray(data.mothEleList)
        ? data.mothEleList
        : [];
    const bills: MonthlyBill[] = [];
    for (const item of raw) {
      const record = asRecord(item);
      if (!record) continue;
      const month = String(record.ym ?? record.month ?? '').replace(/^(\d{4})(\d{2})$/, '$1-$2');
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      bills.push({
        month,
        usage: numberOrUndefined(record.pq ?? record.elePq ?? record.usage),
        charge: numberOrUndefined(record.amt ?? record.charge ?? record.sumMoney),
      });
    }
    return bills.sort((a, b) => a.month.localeCompare(b.month));
  }

  async queryBalance(account: PowerAccount): Promise<BalanceInfo | null> {
    const session = await this.ensureLogin();
    const data = await this.authenticatedData(
      PATHS.accountBalance,
      buildAccountBalancePayload(account, session.userId),
    );
    this.raiseForBusinessError(data, '账户余额查询');
    if (!Array.isArray(data.list)) return null;
    const record = asRecord(data.list.find((item) => asRecord(item)));
    if (!record) return null;
    return {
      consType: String(record.consType ?? ''),
      balance: numberOrUndefined(record.prepayBalance) ?? numberOrUndefined(record.accountBalance),
      amountDue: numberOrUndefined(record.sumMoney),
      historyOwe: numberOrUndefined(record.historyOwe),
      date: String(record.date ?? ''),
    };
  }

  async queryMonthEndMeter(account: PowerAccount, readingDate: string): Promise<number | undefined> {
    const listData = await this.authenticatedData(
      PATHS.meterList,
      buildMeterPayload(account, readingDate),
    );
    this.raiseForBusinessError(listData, '电表列表查询');
    if (!Array.isArray(listData.list)) return undefined;
    const meter = asRecord(listData.list.find((item) => asRecord(item)));
    if (!meter || !meter.meterBarCode) return undefined;

    const detailData = await this.authenticatedData(
      PATHS.meterDetail,
      buildMeterPayload(account, readingDate, String(meter.meterBarCode)),
    );
    this.raiseForBusinessError(detailData, '电表读数查询');
    if (!Array.isArray(detailData.list)) return undefined;
    let best: { time: number; reading: number } | undefined;
    for (const item of detailData.list) {
      const record = asRecord(item);
      if (!record) continue;
      const time = Number(record.time ?? 0);
      const reading = Number(record.readPq);
      if (!Number.isFinite(reading)) continue;
      if (!best || time > best.time) best = { time, reading };
    }
    return best?.reading;
  }

  /**
   * 汇总一个户号的全部指标。
   *
   * 估算电费**不在这里做**——那是渲染层的职责，并且必须标注"估算"。
   * 这里只返回接口原值，缺失即 undefined。
   */
  async snapshot(account: PowerAccount, days = 31): Promise<AccountSnapshot> {
    const today = new Date();
    const start = new Date(today.getTime() - (days - 1) * 86_400_000);
    const readings = await this.queryDailyUsage(account, formatDate(start), formatDate(today));
    const balance = await this.queryBalance(account);

    const sorted = readings.filter((item) => item.usage !== undefined);
    const latest = sorted[sorted.length - 1];
    const monthKey = formatDate(today).slice(0, 7);
    const monthReadings = sorted.filter((item) => item.date.startsWith(monthKey));

    let bills: MonthlyBill[] = [];
    try {
      bills = await this.queryMonthlyBills(account, today.getFullYear());
    } catch (error) {
      if (error instanceof StateGridError && !(error instanceof StateGridApiError)) throw error;
    }
    const settled = bills.filter((bill) => bill.month < monthKey && bill.usage !== undefined);
    const lastSettled = settled[settled.length - 1];

    const sum = (values: Array<number | undefined>): number | undefined => {
      const present = values.filter((value): value is number => value !== undefined);
      return present.length ? present.reduce((a, b) => a + b, 0) : undefined;
    };

    return {
      consNo: account.consNoSrc,
      name: account.name || account.consNoSrc,
      latestDailyUsage: latest?.usage,
      latestDailyDate: latest?.date,
      currentMonthUsage: sum(monthReadings.map((item) => item.usage)),
      latestMonthUsage: lastSettled?.usage,
      latestMonthCharge: lastSettled?.charge,
      currentYearUsage: sum(bills.map((bill) => bill.usage)),
      currentYearCharge: sum(bills.map((bill) => bill.charge)),
      balance: balance?.balance,
      amountDue: balance?.amountDue ?? balance?.historyOwe,
      dailySeries: sorted.map((item) => ({ date: item.date, usage: item.usage as number })),
      updatedAt: Date.now(),
    };
  }
}

function appGuidNew(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let prefix = '';
  for (let i = 0; i < 40; i++) {
    prefix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const stamp = `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}${String(new Date().getMilliseconds()).padStart(3, '0')}`.slice(0, 17);
  return `${prefix}${stamp}${Math.floor(Math.random() * 900) + 100}`;
}
