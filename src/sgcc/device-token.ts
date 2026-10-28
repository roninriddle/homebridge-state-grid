/**
 * 生成 TuringFD v90 `deviceTokenTX`（mode-1 分支）。
 *
 * 与上游一致：token 由「稳定的设备特征 + 请求时间戳」构成，不含账号信息。
 * 服务端用它做风控判定，因此同一安装必须始终产生一致的设备画像。
 */

import { randomBytes } from 'node:crypto';
import { PACKAGE_NAME, StableProfile, type AndroidIdentity } from './turing-profile.js';
import { generateFeatureHashTags } from './hash.js';
import { encodeMode1, serializeM90Full } from './jce.js';
import { buildNestedStruct } from './m90.js';

export const FALLBACK_STATUS_CODE = -22056;
export const TOKEN_SCHEMA_VERSION = 6;

export interface DeviceToken {
  token: string;
  tokenTime: string;
  timestampMs: number;
  profileId: string;
  featureCount: number;
  nestedFeatureCount: number;
  fallbackStatusCode: number;
}

export interface DeviceTokenOptions {
  timestampMs?: number;
  fallbackStatusCode?: number;
  /** 仅用于测试/回归，正常流程应随机生成。 */
  nonce?: string;
  /** 仅用于测试/回归，固定 XXTEA 密钥。 */
  randomKey?: Buffer;
}

const NONCE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function randomNonce(length = 32): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += NONCE_ALPHABET[bytes[i] % NONCE_ALPHABET.length];
  return out;
}

export function generateDeviceToken(
  profile: StableProfile,
  options: DeviceTokenOptions = {},
): DeviceToken {
  const timestampMs = options.timestampMs ?? Date.now();
  const fallbackStatusCode = options.fallbackStatusCode ?? FALLBACK_STATUS_CODE;
  const identity: AndroidIdentity = profile.identity();
  const nonce = options.nonce ?? randomNonce();

  const features = profile.featureMap(timestampMs, { fallbackStatusCode, tokenNonce: nonce });
  const nestedFeatures = [...profile.nativeFeatureMap(timestampMs).entries()].sort(
    (a, b) => a[0] - b[0],
  );
  const tags = generateFeatureHashTags(new Map(nestedFeatures), timestampMs);
  const nested = buildNestedStruct(profile, features, tags, timestampMs);

  const m90 = serializeM90Full({
    channel: identity.channel,
    brand: identity.brand,
    model: identity.model,
    timestampMs,
    cacheFlag: 1,
    nestedFields: nested,
    contextValue: PACKAGE_NAME,
    statusCode: fallbackStatusCode,
    statusText: String(fallbackStatusCode),
    extraField: nonce,
  });

  return {
    token: encodeMode1(m90, options.randomKey),
    tokenTime: String(timestampMs).slice(0, 10),
    timestampMs,
    profileId: identity.profileId,
    featureCount: nestedFeatures.length,
    nestedFeatureCount: nestedFeatures.length,
    fallbackStatusCode,
  };
}
