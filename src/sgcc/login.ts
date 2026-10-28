/**
 * 登录明文构造：密码登录、短信验证、以及登录专用的 md5 头。
 *
 * 三个容易被忽略的细节：
 *  1. `checkCode` = 24 位随机十进制 + AES-256-ECB(PKCS7, account+timestamp)
 *  2. `md5` 头对**入口 HashMap 的线上顺序**敏感，不是简单按键名排序
 *  3. `pushId` 是 pushId 与 pushTokenAli 的拼接
 */

import { createCipheriv, createHash, randomBytes, randomInt } from 'node:crypto';

const CHECK_CODE_AES_KEY = Buffer.from('LNPO+ISJ+QeqNemFK+3OMUdexSn2i6pB', 'utf8');

export interface LoginMapContext {
  pushId: string;
  pushTokenAli: string;
  cityId: string;
  provinceId: string;
  districtId: string;
  isEncrypt: boolean;
  deviceIp: string;
  deviceId: string;
  androidRelease: string;
  operatorType: string;
  deviceModel: string;
  code: string;
  codeKey: string;
  avalonValidCode: string;
}

export function defaultLoginContext(): LoginMapContext {
  return {
    pushId: '000000',
    pushTokenAli: '000000',
    cityId: '',
    provinceId: '',
    districtId: '',
    isEncrypt: false,
    deviceIp: '127.0.0.1',
    deviceId: '000000',
    androidRelease: '13',
    operatorType: '',
    deviceModel: 'sdk_gphone64_arm64',
    code: '',
    codeKey: '',
    avalonValidCode: '',
  };
}

export function passwordMd5(rawPassword: string): string {
  return createHash('md5').update(rawPassword, 'utf8').digest('hex');
}

function randomDigits(count: number): string {
  let out = '';
  const bytes = randomBytes(count);
  for (let i = 0; i < count; i++) out += String(bytes[i] % 10);
  return out;
}

export function generateCheckCode(
  account: string,
  options: { timestampMs?: number; random24?: string } = {},
): string {
  const timestampMs = options.timestampMs ?? Date.now();
  const random24 = options.random24 ?? randomDigits(24);
  if (!/^\d{24}$/.test(random24)) {
    throw new Error('random24 must contain exactly 24 decimal digits');
  }
  const cipher = createCipheriv('aes-256-ecb', CHECK_CODE_AES_KEY, null);
  const encrypted = Buffer.concat([
    cipher.update(`${account}${timestampMs}`, 'utf8'),
    cipher.final(),
  ]);
  return random24 + encrypted.toString('hex');
}

export function buildPasswordLoginMap(
  account: string,
  password: string,
  context: LoginMapContext,
  options: { timestampMs?: number; random24?: string } = {},
): Record<string, unknown> {
  const push = `${context.pushId},${context.pushTokenAli}`;
  return {
    quInfo: {
      code: context.code,
      codeKey: context.codeKey,
      account,
      password: passwordMd5(password),
      optSys: 'Android',
      pushId: push,
      addressCity: context.cityId,
      addressProvince: context.provinceId,
      addressRegion: context.districtId,
    },
    uscInfo: {
      isEncrypt: String(context.isEncrypt),
      devciceIp: context.deviceIp,
      devciceId: context.deviceId,
      tenant: 'state_grid',
      member: '2202',
      optSys: `Android ${context.androidRelease}`,
      operatorType: context.operatorType,
      devciceName: context.deviceModel,
      pushId: push,
    },
    checkCode: generateCheckCode(account, options),
    avalonValidCode: context.avalonValidCode,
  };
}

export function buildDeviceSmsPayload(
  account: string,
  context: LoginMapContext,
  businessType: 'logindevice' | 'login' = 'logindevice',
): Record<string, unknown> {
  return {
    uscInfo: {
      tenant: 'state_grid',
      member: '2202',
      devciceId: context.deviceId,
      devciceName: context.deviceModel,
      devciceIp: context.deviceIp,
    },
    quInfo: {
      voiceCodeFlag: false,
      account,
      sendType: 0,
      businessType,
    },
  };
}

export function buildLoginSmsPayload(account: string, context: LoginMapContext): Record<string, unknown> {
  return buildDeviceSmsPayload(account, context, 'login');
}

export function buildSmsLoginMap(
  account: string,
  code: string,
  codeKey: string,
  context: LoginMapContext,
): Record<string, unknown> {
  if (!/^\d{6}$/.test(code)) throw new Error('SMS login code must contain exactly six digits');
  if (!codeKey) throw new Error('SMS login codeKey must not be empty');
  const push = `${context.pushId},${context.pushTokenAli}`;
  return {
    quInfo: {
      account,
      businessType: 'login',
      code,
      optSys: 'Android',
      pushId: push,
      codeKey,
    },
    uscInfo: {
      isEncrypt: String(context.isEncrypt),
      devciceIp: context.deviceIp,
      devciceId: context.deviceId,
      tenant: 'state_grid',
      member: '2202',
      optSys: `Android ${context.androidRelease}`,
      operatorType: context.operatorType,
      devciceName: context.deviceModel,
      pushId: push,
    },
  };
}

/** Java 的 String.hashCode，按 UTF-16 码元计算并保持 32 位回绕。 */
function javaStringHash(value: string): number {
  let result = 0;
  for (let i = 0; i < value.length; i++) {
    result = (Math.imul(result, 31) + value.charCodeAt(i)) >>> 0;
  }
  return result >>> 0;
}

/**
 * 复刻 Java `HashMap` 的遍历顺序：先按桶号（spread ^ 16 后取低 4 位）升序，
 * 桶内保持插入顺序。登录 md5 依赖这个顺序，按字母序算出来服务端会拒绝。
 */
function javaHashmapOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(javaHashmapOrder);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const buckets = new Map<number, string[]>();
    for (const key of Object.keys(source)) {
      let hashed = javaStringHash(key);
      hashed = (hashed ^ (hashed >>> 16)) >>> 0;
      const bucket = hashed & 15;
      const list = buckets.get(bucket);
      if (list) list.push(key);
      else buckets.set(bucket, [key]);
    }
    const result: Record<string, unknown> = {};
    for (const bucket of [...buckets.keys()].sort((a, b) => a - b)) {
      for (const key of buckets.get(bucket) as string[]) {
        result[key] = javaHashmapOrder(source[key]);
      }
    }
    return result;
  }
  return value;
}

/** 登录请求的 `md5` 头：外层键排序，内层按 Java HashMap 线上顺序。 */
export function loginHeaderMd5(params: Record<string, unknown>): string {
  const material = Object.keys(params)
    .sort()
    .map((key) => key + JSON.stringify(javaHashmapOrder(params[key])))
    .join('');
  return createHash('md5').update(material, 'utf8').digest('hex');
}

export function randomInt64String(digits = 24): string {
  return randomDigits(digits);
}

export { randomInt };
