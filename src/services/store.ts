/**
 * 插件私有存储。
 *
 * 三份数据分开存：
 *  - device.json：设备种子与 Turing token 缓存（决定"是不是同一台设备"）；
 *  - session.json：登录 token；
 *  - account.json：手机号与加密后的密码。
 *
 * 密码不落明文：用 AES-256-GCM 加密，密钥由「主机名 + 用户名 + 插件固定盐」
 * 派生。这不是硬件级保护（同机同用户可解），但能避免备份、日志、误传配置
 * 文件时的直接泄露，而且不依赖 keytar ——后者在 Docker 里通常不可用。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

import type { LoginSession } from '../sgcc/types.js';
import {
  createProfileState,
  profileFromState,
  type ProfileState,
  type StableProfile,
} from '../sgcc/turing-profile.js';
import { generateDeviceToken, type DeviceToken } from '../sgcc/device-token.js';

const TOKEN_CACHE_MS = 4 * 3600 * 1000;
const KDF_SALT = 'homebridge-state-grid:v1';

interface DeviceState {
  schemaVersion: number;
  profile: ProfileState;
  tokenCache?: {
    schemaVersion: number;
    token: string;
    tokenTime: string;
    timestampMs: number;
    profileId: string;
    featureCount: number;
    nestedFeatureCount: number;
    fallbackStatusCode: number;
  };
}

interface AccountState {
  username: string;
  /** base64(iv || tag || ciphertext) */
  passwordEnc?: string;
  region?: string;
}

function derivedKey(): Buffer {
  const material = `${hostname()}|${userInfo().username}|${KDF_SALT}`;
  return createHash('sha256').update(material, 'utf8').digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function decryptSecret(payload: string): string | null {
  try {
    const raw = Buffer.from(payload, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const cipher = createDecipheriv('aes-256-gcm', derivedKey(), iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows 上 chmod 是空操作 */
  }
}

export class PluginStore {
  private readonly dir: string;

  constructor(storagePath: string) {
    this.dir = join(storagePath, 'state-grid');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  get deviceFile(): string {
    return join(this.dir, 'device.json');
  }

  /** 设备身份：种子必须跨重启保持，否则每次都会被判为新设备。 */
  loadProfile(): StableProfile {
    const state = readJson<DeviceState>(this.deviceFile);
    if (state?.profile) {
      try {
        return profileFromState(state.profile);
      } catch {
        /* 结构不兼容时重建 */
      }
    }
    // 注意：必须写回同一份状态，否则内存里的种子和磁盘上的不是同一个。
    const fresh = createProfileState();
    writeJson(this.deviceFile, { schemaVersion: 1, profile: fresh } satisfies DeviceState);
    return profileFromState(fresh);
  }

  loadToken(profile: StableProfile): DeviceToken | null {
    const state = readJson<DeviceState>(this.deviceFile);
    const cache = state?.tokenCache;
    if (!cache) return null;
    if (Date.now() - cache.timestampMs > TOKEN_CACHE_MS) return null;
    if (cache.profileId !== profile.identity().profileId) return null;
    if (!cache.token?.startsWith('v3:')) return null;
    return {
      token: cache.token,
      tokenTime: cache.tokenTime,
      timestampMs: cache.timestampMs,
      profileId: cache.profileId,
      featureCount: cache.featureCount,
      nestedFeatureCount: cache.nestedFeatureCount,
      fallbackStatusCode: cache.fallbackStatusCode,
    };
  }

  /** 取缓存的 token，过期或不存在则重新生成并落盘。 */
  deviceToken(profile: StableProfile): DeviceToken {
    const cached = this.loadToken(profile);
    if (cached) return cached;
    const generated = generateDeviceToken(profile);
    const state = readJson<DeviceState>(this.deviceFile);
    writeJson(this.deviceFile, {
      schemaVersion: 1,
      profile: state?.profile ?? createProfileState(),
      tokenCache: {
        schemaVersion: 6,
        token: generated.token,
        tokenTime: generated.tokenTime,
        timestampMs: generated.timestampMs,
        profileId: generated.profileId,
        featureCount: generated.featureCount,
        nestedFeatureCount: generated.nestedFeatureCount,
        fallbackStatusCode: generated.fallbackStatusCode,
      },
    } satisfies DeviceState);
    return generated;
  }

  loadSession(): LoginSession | null {
    const value = readJson<LoginSession>(join(this.dir, 'session.json'));
    if (!value?.token) return null;
    return value;
  }

  saveSession(session: LoginSession): void {
    writeJson(join(this.dir, 'session.json'), session);
  }

  clearSession(): void {
    writeJson(join(this.dir, 'session.json'), {});
  }

  loadAccount(): AccountState | null {
    return readJson<AccountState>(join(this.dir, 'account.json'));
  }

  saveAccount(username: string, password: string | undefined, region?: string): void {
    const next: AccountState = { username, region };
    if (password) next.passwordEnc = encryptSecret(password);
    else {
      const previous = this.loadAccount();
      if (previous?.passwordEnc) next.passwordEnc = previous.passwordEnc;
    }
    writeJson(join(this.dir, 'account.json'), next);
  }

  loadPassword(): string | null {
    const account = this.loadAccount();
    return account?.passwordEnc ? decryptSecret(account.passwordEnc) : null;
  }

  /** 省份来自登录返回的 userInfo，后续请求头要用，重登时也必须一致。 */
  saveRegion(region: string): void {
    const previous = this.loadAccount();
    if (!previous?.username) return;
    writeJson(join(this.dir, 'account.json'), { ...previous, region });
  }

  /** 快照缓存目录，同时给 ffmpeg 当输入源。 */
  frameDir(): string {
    const dir = join(this.dir, 'frames');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  cacheDir(): string {
    const dir = join(this.dir, 'cache');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
}
