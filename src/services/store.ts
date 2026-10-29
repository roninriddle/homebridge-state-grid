/**
 * 插件私有存储。
 *
 * 三份数据分开存：
 *  - device.json：设备种子与 Turing token 缓存（决定"是不是同一台设备"）；
 *  - session.json：登录 token；
 *  - account.json：手机号与加密后的密码。
 *
 * 密码不落明文：用 AES-256-GCM 加密，密钥由「主机名 + 用户名 + 插件固定盐」
 * 派生。这是明文遮蔽，不抵御已知主机名/用户名的离线恢复；
 * 文件权限和备份访问控制仍须保护凭据。保留既有格式以兼容升级。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

import type { AccountAppearance } from './appearance.js';
import type { LoginSession, AccountSnapshot } from '../sgcc/types.js';
import {
  createProfileState,
  profileFromState,
  type ProfileState,
  type StableProfile,
} from '../sgcc/turing-profile.js';
import { generateDeviceToken, TOKEN_SCHEMA_VERSION, type DeviceToken } from '../sgcc/device-token.js';

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

/** 单个户号的缓存条目（主进程刷新后落盘，设置页读它避免联网）。 */
export interface CachedAccount {
  consNo: string;
  consNoMasked: string;
  name: string;
  address: string;
  consType: string;
  title: string;
  enabled: boolean;
  lastSuccess: number | null;
  lastError: string | null;
  /** summarizeSnapshot 的产物；没拉到数据时为 null。 */
  snapshot: Record<string, unknown> | null;
  data?: AccountSnapshot;
}

/** 户号缓存文件结构。 */
export interface AccountsCache {
  updatedAt: number;
  accounts: CachedAccount[];
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

export function atomicWrite(file: string, value: string | Buffer): void {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function writeJson(file: string, value: unknown): void {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
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
        throw new Error('设备档案不兼容，请保留 device.json 并从备份恢复，不能自动更换设备身份');
      }
    }
    if (existsSync(this.deviceFile)) throw new Error('设备档案损坏，请保留 device.json 并从备份恢复');
    // 注意：必须写回同一份状态，否则内存里的种子和磁盘上的不是同一个。
    const fresh = createProfileState();
    try {
      writeFileSync(this.deviceFile, JSON.stringify({ schemaVersion: 1, profile: fresh }), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return this.loadProfile();
    }
    return profileFromState(fresh);
  }

  loadToken(profile: StableProfile): DeviceToken | null {
    const state = readJson<DeviceState>(this.deviceFile);
    const cache = state?.tokenCache;
    if (!cache || cache.schemaVersion !== TOKEN_SCHEMA_VERSION) return null;
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
    if (!state?.profile) throw new Error('设备档案不可读，拒绝更换设备身份');
    writeJson(this.deviceFile, {
      schemaVersion: 1,
      profile: state.profile,
      tokenCache: {
        schemaVersion: TOKEN_SCHEMA_VERSION,
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
    const value = readJson<LoginSession & { schemaVersion?: number }>(join(this.dir, 'session.json'));
    if (!value?.token) return null;
    // 旧版只保存了本地猜测的 30 分钟，不能据此认定服务端 token 已过期。
    // 迁移为未知有效期，由下一次正常业务请求验证，失败仍只重登一次。
    if (!value.schemaVersion) value.expiresAt = 0;
    value.userId = value.userId || String(value.userInfo?.userId || '0');
    return value;
  }

  saveSession(session: LoginSession): void {
    writeJson(join(this.dir, 'session.json'), { ...session, schemaVersion: 2 });
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
      if (previous?.username === username && previous.passwordEnc) next.passwordEnc = previous.passwordEnc;
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

  /** 卡片预览 JPEG 的缓存目录，设置页读它渲染缩略图，不用联网。 */
  previewDir(): string {
    const dir = join(this.cacheDir(), 'preview');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** 户号列表 + 快照摘要缓存。 */
  loadAccountsCache(): AccountsCache | null {
    return readJson<AccountsCache>(join(this.cacheDir(), 'accounts-cache.json'));
  }

  saveAccountsCache(cache: AccountsCache): void {
    writeJson(join(this.cacheDir(), 'accounts-cache.json'), cache);
  }

  /** 读取某户号的预览图缓存（JPEG），没有则返回 null。 */
  loadCachedPreview(consNo: string): Buffer | null {
    this.validateConsNo(consNo);
    const file = join(this.previewDir(), `${consNo}.jpg`);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file);
    } catch {
      return null;
    }
  }

  saveCachedPreview(consNo: string, jpeg: Buffer): void {
    this.validateConsNo(consNo);
    atomicWrite(join(this.previewDir(), `${consNo}.jpg`), jpeg);
  }

  private validateConsNo(consNo: string): void {
    if (!/^[\w-]{1,128}$/.test(consNo)) throw new Error('无效户号');
  }

  loadRuntimeStatus(): Record<string, unknown> | null {
    return readJson(join(this.cacheDir(), 'status.json'));
  }

  loadAppearance(): Record<string, AccountAppearance> {
    return readJson<Record<string, AccountAppearance>>(join(this.dir, 'appearance.json')) ?? {};
  }

  saveAppearance(consNo: string, value: AccountAppearance): AccountAppearance {
    this.validateConsNo(consNo);
    if (typeof value.name !== 'string' || typeof value.showRegion !== 'boolean') throw new Error('名称和地区显示设置无效');
    const name = value.name.trim();
    if ((name && Array.from(name).length < 2) || Array.from(name).length > 32 || /[\x00-\x1f]/.test(name)) throw new Error('摄像头名称请填写 2～32 个字符，留空恢复国家电网');
    const appearance = { name, showRegion: value.showRegion };
    const values = this.loadAppearance(); values[consNo] = appearance;
    writeJson(join(this.dir, 'appearance.json'), values);
    return appearance;
  }

  readAppearanceRaw(): string {
    try { return readFileSync(join(this.dir, 'appearance.json'), 'utf8'); } catch { return ''; }
  }

  /** 户号显示开关（设置页「户号与卡片预览」里的启用/停用）。 */
  loadVisibility(): Record<string, boolean> {
    return readJson<Record<string, boolean>>(join(this.dir, 'visibility.json')) ?? {};
  }

  setAccountVisibility(consNo: string, enabled: boolean): void {
    const map = this.loadVisibility();
    map[consNo] = enabled;
    writeJson(join(this.dir, 'visibility.json'), map);
  }

  /** 卡片指标顺序（fields.json）。不存在或结构非法时返回 null，由调用方归一化。 */
  loadFields(): string[] | null {
    const value = readJson<string[]>(join(this.dir, 'fields.json'));
    return Array.isArray(value) ? value : null;
  }

  saveFields(fields: string[]): void {
    writeJson(join(this.dir, 'fields.json'), fields);
  }

  /**
   * 读 fields.json 的原始文本，供主进程轮询比对变化。
   * 设置页跑在独立进程里，写文件后主进程只能靠比对内容感知变化。
   */
  readFieldsRaw(): string {
    const file = join(this.dir, 'fields.json');
    if (!existsSync(file)) return '';
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  /** 读 visibility.json 的原始文本，同上，用于轮询感知户号开关变化。 */
  readVisibilityRaw(): string {
    const file = join(this.dir, 'visibility.json');
    if (!existsSync(file)) return '';
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }
}
