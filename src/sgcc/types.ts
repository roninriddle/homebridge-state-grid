/** 网上国网 App 的数据模型与错误类型。 */

export const DEFAULT_BASE_URL = 'https://csc-service.sgcc.com.cn:28630';
export const APP_VERSION = '3.2.3';

export interface DeviceProfile {
  baseUrl: string;
  serverPublicKey: string;
  clientPrivateKey: string;
  deviceTokenTx: string;
  deviceTokenTxTime: string;
  appGuid: string;
  deviceId: string;
  deviceModel: string;
  androidRelease: string;
  deviceIp: string;
  operatorType: string;
  pushId: string;
  pushTokenAli: string;
  addressProvince: string;
  addressCity: string;
  addressRegion: string;
  provinceHeader: string;
  datacenter: string;
}

export interface LoginSession {
  token: string;
  userId: string;
  /** 毫秒时间戳；0 表示未知。 */
  expiresAt: number;
  userInfo: Record<string, unknown>;
}

export interface PowerAccount {
  accountId: string;
  consNo: string;
  /** 历史接口要求的是未加密户号，不是 consNo。 */
  consNoSrc: string;
  proNo: string;
  orgNo: string;
  elecType: string;
  /** 日用电接口的 consType 字段，与 elecType 分开保存。 */
  consType: string;
  name: string;
  address: string;
  raw: Record<string, unknown>;
}

function firstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return '';
}

export function powerAccountFromApi(value: Record<string, unknown>): PowerAccount | null {
  // 加密户号（consNo）与未加密户号（consNo_dst）是两回事：
  // 历史/日用电接口要求未加密户号 consNoSrc，加密串会被服务端以 code:0 拒绝。
  const consNo = firstString(value, ['powerUserNo', 'consNo']);
  const consNoSrc = firstString(value, ['powerUserNo_dst', 'consNo_dst']) || consNo;
  const accountId =
    firstString(value, ['id', 'userId', 'consNo_dst', 'powerUserNo_dst']) || consNoSrc;
  if (!consNoSrc) return null;
  return {
    accountId,
    consNo,
    consNoSrc,
    proNo: firstString(value, ['proNo', 'provinceId', 'proCode', 'provinceCode']),
    orgNo: firstString(value, ['orgNo']),
    elecType: firstString(value, ['elecTypeCode', 'elecType', 'constType', 'sceneType', 'consType']),
    // 日用电接口的 consType 只接受 01(低压)/02(高压)，对应 elecTypeCode，
    // 不能用 constType（户类型，如 03）替代。
    consType: firstString(value, ['elecTypeCode', 'elecType', 'consType', 'sceneType']),
    name: firstString(value, ['consName_dst', 'consName', 'name', 'accountName']),
    address: firstString(value, ['elecAddr_dst', 'elecAddr', 'eleAddress', 'address']),
    raw: value,
  };
}

export function powerAccounts(userInfo: Record<string, unknown>): PowerAccount[] {
  const raw = userInfo.powerUserList;
  if (!Array.isArray(raw)) return [];
  const result: PowerAccount[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const account = powerAccountFromApi(item as Record<string, unknown>);
    if (!account || seen.has(account.accountId)) continue;
    seen.add(account.accountId);
    result.push(account);
  }
  return result;
}

/** 单个户号的一次采样结果。字段缺失即保持 undefined，绝不补 0。 */
export interface AccountSnapshot {
  consNo: string;
  name: string;
  /** 最新一个已发布数据日的用电量（kWh）。 */
  latestDailyUsage?: number;
  /** 该数据所属日期（YYYY-MM-DD）。 */
  latestDailyDate?: string;
  currentMonthUsage?: number;
  latestMonthUsage?: number;
  latestMonthCharge?: number;
  currentYearUsage?: number;
  currentYearCharge?: number;
  /** 预付费余额（正数为有余额）。 */
  balance?: number;
  /** 后付费应交金额（正数为欠费）。 */
  amountDue?: number;
  latestMonthMeterReading?: number;
  /** 上日分时用电（峰/谷/平/尖，kWh）。 */
  latestPeakUsage?: number;
  latestValleyUsage?: number;
  latestFlatUsage?: number;
  latestSharpUsage?: number;
  /** 当月分时用电（峰/谷/平/尖，kWh）。 */
  monthPeakUsage?: number;
  monthValleyUsage?: number;
  monthFlatUsage?: number;
  monthSharpUsage?: number;
  /** 当前阶梯档位（1/2/3）。 */
  ladderLevel?: number;
  /** 违约金（元）。 */
  penalty?: number;
  /** 历史欠费（元）。 */
  historyOwe?: number;
  /** 最近 N 天每日用电，按日期升序。 */
  dailySeries: Array<{ date: string; usage: number }>;
  updatedAt: number;
}

export class StateGridError extends Error {
  readonly code: string;
  readonly source: string;
  constructor(message: string, code = '', source = 'service') {
    super(message);
    this.name = 'StateGridError';
    this.code = code;
    this.source = source;
  }
}

export class StateGridNetworkError extends StateGridError {
  constructor(message: string) {
    super(message, 'network', 'transport');
    this.name = 'StateGridNetworkError';
  }
}

export class StateGridApiError extends StateGridError {
  constructor(code: string, message: string, source = 'service') {
    super(message || `国家电网接口返回错误 ${code}`, code, source);
    this.name = 'StateGridApiError';
  }
}

export class StateGridAuthenticationError extends StateGridError {
  constructor(code: string, message: string, source = 'service') {
    super(message || '登录状态已失效', code, source);
    this.name = 'StateGridAuthenticationError';
  }
}

/** 服务端要求新设备短信验证。 */
export class StateGridDeviceVerificationRequired extends StateGridError {
  constructor(code: string, message: string, source = 'service') {
    super(message || '需要短信验证码以验证新设备', code, source);
    this.name = 'StateGridDeviceVerificationRequired';
  }
}

/** 需要人工完成的额外风控挑战（例如 RK008 滑块）。 */
export class StateGridInteractiveChallengeRequired extends StateGridError {
  constructor(code: string, message: string, source = 'service') {
    super(message || `需要人工完成安全校验（${code}）`, code, source);
    this.name = 'StateGridInteractiveChallengeRequired';
  }
}

export const AUTH_ERROR_CODES = new Set(['-200', '-201']);
export const DEVICE_VERIFICATION_CODE = '4006';
export const INTERACTIVE_CHALLENGE_CODES = new Set(['RK008']);
