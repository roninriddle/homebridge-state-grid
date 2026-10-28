/**
 * 各业务接口的请求体构造。
 *
 * 字段名与取值来自上游对 App 3.2.3 的抓包还原。其中 `consNo` 必须使用
 * **未加密户号**（consNoSrc）——这是上游 f3c7910 修复的 bug，用加密户号会被
 * 服务端以 `code: 0` / `consNo: null` 拒绝。
 */

import type { PowerAccount } from './types.js';

export const PATHS = {
  login: 'emss-uia-center-front/member/c2/f01',
  deviceSms: 'emss-uia-center-front/member/c1/f01',
  smsLogin: 'emss-uia-center-front/member/c2/f02',
  dailyUsage: 'emss-bia-bill-front/member/c11/f01',
  monthlyBills: 'emss-bia-bill-front/member/c51/f04',
  accountBalance: 'emss-bia-balance-front/member/c16/f01',
  meterList: 'emss-bia-bill-front/member/c11/f09',
  meterDetail: 'emss-bia-bill-front/member/c11/f10',
} as const;

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
}

/** 上海时区的当前时间，YYYYMMDDHHmmssSSS + 6 位随机数字。 */
export function requestTimestamp(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const millis = String(now.getMilliseconds()).padStart(3, '0');
  const suffix = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('');
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}${millis}${suffix}`;
}

/** 登录请求头用的时间戳：精确到秒，无毫秒。 */
export function loginTimestamp(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}`;
}

export function buildDailyUsagePayload(
  account: PowerAccount,
  startDate: string,
  endDate: string,
): Record<string, unknown> {
  return {
    serviceCode: 'BCP_000026',
    source: 'app',
    target: account.proNo,
    data: {
      acctId: 'acctid01',
      channelCode: 'SGAPP',
      consNo: account.consNoSrc,
      consNosrc: account.consNoSrc,
      endTime: endDate,
      consType: account.consType,
      funcCode: 'ALIPAY_01',
      orgNo: account.orgNo,
      proCode: account.proNo,
      promotCode: '1',
      promotType: '1',
      serialNo: '',
      srvCode: '',
      startTime: startDate,
      userName: 'acctid01',
    },
  };
}

export function buildMonthlyBillsPayload(account: PowerAccount, year: number): Record<string, unknown> {
  return {
    serviceCode: 'BCP_000026',
    source: 'app',
    target: account.proNo,
    data: {
      year,
      consNo: account.consNoSrc,
      provinceCode: account.proNo,
      startYm: `${year}01`,
      endYm: `${year}12`,
      funcCode: 'ALIPAY_01',
    },
  };
}

export function buildAccountBalancePayload(
  account: PowerAccount,
  userId: string,
): Record<string, unknown> {
  return {
    serviceCode: '0101143',
    source: 'app',
    target: account.proNo,
    data: {
      srvCode: '',
      serialNo: '',
      channelCode: '0902',
      funcCode: 'A1007200',
      acctId: userId,
      userName: 'acctid01',
      promotType: '1',
      promotCode: '1',
      userAccountId: userId,
      list: [
        {
          consNoSrc: account.consNoSrc,
          proCode: account.proNo,
          sceneType: account.elecType,
          consNo: account.consNo,
          orgNo: account.orgNo,
        },
      ],
    },
  };
}

export function buildMeterPayload(
  account: PowerAccount,
  readingDate: string,
  meterBarCode = '',
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    promotCode: '1',
    promotType: '1',
    funcCode: 'A10071400',
    acctId: 'acctid01',
    userName: 'acctid01',
    serialNo: '',
    srvCode: '123',
    channelCode: 'SGAPP',
    consNo: account.consNoSrc,
    proCode: account.proNo,
    ymd: readingDate,
  };
  if (meterBarCode) data.meterBarCode = meterBarCode;
  return { serviceCode: '0102719', source: 'app', target: account.proNo, data };
}
