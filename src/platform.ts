/**
 * Homebridge 动态平台：把每个户号变成一个 HomeKit 虚拟摄像头。
 *
 * 只做三件事——把凭据交给协议层、按固定周期刷新数据、把数据渲染成快照挂到
 * 摄像头上。所有 HomeKit 细节都收敛在这里，`src/sgcc/**` 不依赖 Homebridge。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';
import ffmpegStatic from 'ffmpeg-for-homebridge';

import {
  StateGridAuthenticationError,
  StateGridDeviceVerificationRequired,
  StateGridError,
  StateGridInteractiveChallengeRequired,
  powerAccounts,
  type AccountSnapshot,
  type PowerAccount,
} from './sgcc/types.js';
import { StateGridClient } from './sgcc/client.js';
import { renderCard, type CardData } from './renderer/card-svg.js';
import { normalizeFieldOrder, type FieldKey } from './renderer/fields.js';
import { fallbackCardSvg, pngToJpeg, renderPng } from './renderer/image-renderer.js';
import { UsageCamera } from './camera/camera-accessory.js';
import { PluginStore, atomicWrite } from './services/store.js';
import { resolveAppearance } from './services/appearance.js';
import { snapshotToCard, cachedSnapshot } from './services/card.js';
import { assembleProfile } from './services/device-profile.js';
import { formatClock } from './renderer/format.js';
import {
  estimateCharge,
  maskConsNo,
  regionFromAddress,
  summarizeSnapshot,
} from './services/summary.js';

export const PLATFORM_NAME = 'StateGrid';
export const PLUGIN_NAME = 'homebridge-state-grid';

interface AccountConfig {
  consNo?: string;
  title?: string;
  showRegion?: boolean;
  enabled?: boolean;
}

export interface StateGridConfig extends PlatformConfig {
  username?: string;
  password?: string;
  updateIntervalHours?: number;
  theme?: 'light' | 'dark';
  showRegion?: boolean;
  snapshotWidth?: number;
  snapshotHeight?: number;
  accounts?: AccountConfig[];
  /** 卡片指标显示与顺序（key 数组或 [{key}] 数组）。 */
  fields?: Array<FieldKey | { key: FieldKey }>;
}

interface CameraEntry {
  accessory: PlatformAccessory;
  camera: UsageCamera;
  consNo: string;
  title: string;
  region?: string;
  /** HomeKit 快照（JPEG），有人打开摄像头时直接返回。 */
  jpeg?: Buffer;
  /** ffmpeg 的循环输入帧（PNG），视频流用它。 */
  png?: Buffer;
  snapshot?: AccountSnapshot;
  lastSuccess?: number;
  lastError?: string;
  cameraError?: (id: string) => void;
}

const DEFAULT_INTERVAL_HOURS = 12;
const MIN_INTERVAL_HOURS = 6;
const MAX_INTERVAL_HOURS = 24;
/** 超过这个时长没拿到新数据，卡片上会显示"数据未更新"。 */
const STALE_AFTER_MS = 26 * 3600 * 1000;

/** 去掉配件名首尾的脱敏星号，避免 HomeKit 因非法字符拒绝注册。 */
function cleanAccessoryName(name: string): string {
  const cleaned = (name || '').replace(/^\*+|\*+$/g, '').trim();
  // HAP 要求名称首尾各至少一个字母/数字（长度 ≥ 2），单字名（如脱敏后仅剩"邗"）无法通过校验。
  return Array.from(cleaned).length >= 2 ? cleaned : '';
}

export class StateGridPlatform implements DynamicPlatformPlugin {
  private readonly entries = new Map<string, CameraEntry>();
  private client: StateGridClient | null = null;
  private store: PluginStore;
  private refreshInFlight: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay = 60_000;
  private stopped = false;
  private verificationToken = '';
  private refreshTimer: NodeJS.Timeout | null = null;
  /** 卡在"需要验证码"时，轮询磁盘 session 是否已被设置页更新。 */
  private verifyPollTimer: NodeJS.Timeout | null = null;
  /** 监听设置页写入的字段顺序/户号开关，实时同步 HomeKit。 */
  private configWatcher: NodeJS.Timeout | null = null;
  private lastFieldsRaw = '';
  private lastAppearanceRaw = '';
  private lastVisibilityRaw = '';
  /** 需要人工处理的状态（短信验证 / 风控挑战），供 UI 读取。 */
  private readonly status: {
    state: 'starting' | 'ready' | 'needs_verification' | 'error';
    message: string;
    updatedAt: number;
  } = { state: 'starting', message: '正在启动', updatedAt: Date.now() };

  constructor(
    private readonly log: Logger,
    private readonly config: StateGridConfig,
    private readonly api: API,
  ) {
    this.store = new PluginStore(this.api.user.storagePath());

    this.api.on('didFinishLaunching', () => {
      void this.bootstrap();
    });
    this.api.on('shutdown', () => {
      this.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    // 历史缓存里的配件名可能带脱敏星号（如 *博帆），或只剩单字（如 邗），
    // 都会被 HAP 拒绝，恢复时顺手修正，避免启动告警。
    const cleaned = cleanAccessoryName(accessory.displayName);
    if (cleaned !== accessory.displayName) {
      const fallback = cleaned || `用电 ${accessory.UUID.split('-')[0]}`;
      this.log.info(`配件名称已修正：${accessory.displayName} → ${fallback}`);
      accessory.displayName = fallback;
    }
    // 已有配件先挂到缓存，等数据到位后再补摄像头控制器。
    this.log.debug(`恢复配件 ${accessory.displayName}`);
    this.pendingAccessories.push(accessory);
  }

  private readonly pendingAccessories: PlatformAccessory[] = [];

  private get width(): number {
    return this.config.snapshotWidth ?? 1280;
  }

  private get height(): number {
    return this.config.snapshotHeight ?? 720;
  }

  private get theme(): 'light' | 'dark' {
    return this.config.theme ?? 'light';
  }

  private get fields(): FieldKey[] {
    // 设置页「卡片指标」里的配置写在 storage/fields.json（主进程与设置页共享），
    // 优先读它；没配置过再回退到 config.json 的 fields。
    const stored = this.store.loadFields();
    if (stored && stored.length) return normalizeFieldOrder(stored);
    return normalizeFieldOrder(this.config.fields);
  }

  private get intervalHours(): number {
    const raw = this.config.updateIntervalHours ?? DEFAULT_INTERVAL_HOURS;
    return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, raw));
  }

  private async bootstrap(): Promise<void> {
    if (this.stopped) return;
    this.startConfigWatcher();
    try {
      this.restoreCachedEntries();
      await this.connect();
      await this.refreshAll();
      this.scheduleRefresh();
      this.retryDelay = 60_000;
    } catch (error) {
      this.setError(error);
    }
  }

  private setError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.status.updatedAt = Date.now();
    if (error instanceof StateGridDeviceVerificationRequired) {
      this.status.state = 'needs_verification';
      this.status.message = '需要短信验证码：请在插件设置页完成验证';
      this.log.warn(this.status.message);
      this.persistStatus();
      this.startVerifyPolling();
      return;
    }
    if (error instanceof StateGridInteractiveChallengeRequired) {
      this.status.state = 'needs_verification';
      this.status.message = `需要完成安全校验（${(error as StateGridError).code}），请打开网上国网 App 处理`;
      this.log.warn(this.status.message);
      this.persistStatus();
      this.startVerifyPolling();
      return;
    }
    // 密码登录被国网风控拒绝（典型如 RK007「密码过于简单」）时，让用户走
    // 「短信验证码登录」绕过密码校验。这条登录态由设置页写入 session.json，
    // 因此这里同样进入 needs_verification 并轮询磁盘，恢复成功后自动重连。
    if (error instanceof StateGridAuthenticationError) {
      this.status.state = 'needs_verification';
      this.status.message = '密码登录被国网拒绝，请在插件设置页用「短信验证码登录」';
      this.log.warn(`国家电网密码登录失败：${message}；请改用短信验证码登录`);
      this.persistStatus();
      this.startVerifyPolling();
      return;
    }
    this.status.state = 'error';
    this.status.message = message;
    this.log.error(`国家电网数据获取失败：${message}`);
    this.persistStatus();
    if (!this.stopped && !this.retryTimer) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.bootstrap(); }, this.retryDelay);
      this.retryTimer.unref?.();
      this.retryDelay = Math.min(30 * 60_000, this.retryDelay * 2);
    }
  }

  /**
   * 卡在「需要短信验证码」时，轮询磁盘上的 session。
   *
   * 为什么需要：设置页跑在独立进程里，用户在那边完成验证码登录后会把 session
   * 写到 session.json；本进程若不主动去看，就得等下一个更新周期（最长 24 小时）。
   * 这里每 30 秒查一次 token 是否变了，一旦变了立即重建连接、拉户号、刷新卡片。
   */
  private startVerifyPolling(): void {
    if (this.verifyPollTimer) return;
    this.verificationToken = this.store.loadSession()?.token ?? '';
    this.verifyPollTimer = setInterval(() => {
      void this.tryRecoverFromVerification();
    }, 30_000);
    this.verifyPollTimer.unref?.();
  }

  private async tryRecoverFromVerification(): Promise<void> {
    if (this.status.state !== 'needs_verification') {
      this.stopVerifyPolling();
      return;
    }
    const saved = this.store.loadSession();
    if (!saved?.token || saved.token === this.verificationToken || (saved.expiresAt !== 0 && saved.expiresAt <= Date.now())) return;

    this.log.info('检测到验证已完成，重新连接网上国网…');
    this.stopVerifyPolling();
    try {
      // 直接走一遍 connect：它会从磁盘 loadSession 并 ensureLogin（session 未过期
      // 就直接复用，不再触发验证），随后 refreshAll 拉户号、渲染卡片。
      await this.connect();
      await this.refreshAll();
      this.scheduleRefresh();
      this.persistStatus();
      this.log.info('验证恢复流程已完成，运行状态已更新');
    } catch (error) {
      this.setError(error);
    }
  }

  private stopVerifyPolling(): void {
    if (this.verifyPollTimer) clearInterval(this.verifyPollTimer);
    this.verifyPollTimer = null;
  }

  /**
   * 监听设置页写入的配置变化（字段顺序、户号开关），实时同步 HomeKit。
   *
   * 为什么需要：设置页跑在独立进程里，它改「卡片指标」「户号开关」后直接落盘；
   * 本进程若不主动去看，停用的户号会一直挂在 HomeKit 上、改动的指标也不会
   * 立即生效。这里每 8 秒比对一次文件内容，变了就立即处理。
   */
  private startConfigWatcher(): void {
    if (this.configWatcher) return;
    // 初始化基线，避免启动时把「首次读到的内容」误判成变化。
    this.lastAppearanceRaw = this.store.readAppearanceRaw();
    this.lastFieldsRaw = this.store.readFieldsRaw();
    this.lastVisibilityRaw = this.store.readVisibilityRaw();
    this.configWatcher = setInterval(() => {
      void this.reconcileAppearance().catch((error) => this.log.warn(`名称更新失败：${(error as Error).message}`));
      this.reconcileFields();
      void this.reconcileVisibility();
    }, 8_000);
    this.configWatcher.unref?.();
  }

  /** 字段顺序变了就立即重绘所有已拿到数据的卡片，无需重启。 */
  private reconcileFields(): void {
    const raw = this.store.readFieldsRaw();
    if (raw === this.lastFieldsRaw) return;
    this.lastFieldsRaw = raw;
    this.log.info('检测到卡片指标配置变化，重新渲染卡片…');
    for (const entry of this.entries.values()) {
      if (entry.snapshot) void this.paint(entry).catch((error) => this.log.warn(`重新渲染失败：${(error as Error).message}`));
    }
  }

  /** 户号开关变了就同步配件：停用的移除、启用的补上，再拉一遍数据。 */
  private async reconcileVisibility(): Promise<void> {
    const raw = this.store.readVisibilityRaw();
    if (raw === this.lastVisibilityRaw) return;
    this.lastVisibilityRaw = raw;
    if (!this.client?.currentSession) return;
    this.log.info('检测到户号开关变化，同步 HomeKit 配件…');
    this.reconcileAccessories();
    this.persistStatus();
  }

  /** 让 HomeKit 里挂着的配件与「启用」状态对齐。 */
  private reconcileAccessories(): void {
    const accounts = this.accounts();
    const enabledSet = new Set(
      accounts.filter((account) => this.enabled(account)).map((account) => account.consNoSrc),
    );
    // 移除已停用的配件（可能在 entries 里）。
    for (const [consNo, entry] of [...this.entries.entries()]) {
      if (!enabledSet.has(consNo)) this.removeEntry(consNo, entry);
    }
    // 重启后 configureAccessory 把 Homebridge 缓存里的配件先塞进了 pendingAccessories，
    // 已停用的户号还没进 entries，也要在这里一并从 HomeKit 移除。
    // 反查方式：优先用 context.consNo（本次运行写入），旧版本没写 context 就用 UUID 兜底
    // （UUID 由 consNo 确定性生成，能跨版本还原）。
    const disabledUuids = new Map(
      accounts
        .filter((account) => !this.enabled(account))
        .map((account) => [
          this.api.hap.uuid.generate(`${PLUGIN_NAME}:${account.consNoSrc}`),
          account.consNoSrc,
        ]),
    );
    for (let i = this.pendingAccessories.length - 1; i >= 0; i--) {
      const accessory = this.pendingAccessories[i];
      const contextConsNo = (accessory.context && accessory.context.consNo) || '';
      const byUuid = disabledUuids.get(accessory.UUID) || '';
      const consNo = contextConsNo || byUuid;
      if (consNo && !enabledSet.has(String(consNo))) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.pendingAccessories.splice(i, 1);
        this.log.info(`已从 HomeKit 移除配件：${accessory.displayName}`);
      }
    }
    // 启用但还没进 entries 的，注册并挂上摄像头控制器。
    for (const account of accounts) {
      if (enabledSet.has(account.consNoSrc)) this.ensureEntry(account);
    }
  }

  /** 从 HomeKit 移除一个配件。 */
  private removeEntry(consNo: string, entry: CameraEntry): void {
    try {
      entry.camera.stopStream();
    } catch {
      /* 忽略停止流的异常 */
    }
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [entry.accessory]);
    this.entries.delete(consNo);
    this.log.info(`已从 HomeKit 移除配件：${entry.title}`);
  }

  /** 组装设备档案并建立会话。 */
  private async connect(): Promise<void> {
    const savedAccount = this.store.loadAccount();
    const username = savedAccount?.username || this.config.username || '';
    const password = this.store.loadPassword() || ((!savedAccount || savedAccount.username === this.config.username) ? this.config.password : '') || '';
    if (!username) throw new StateGridAuthenticationError('missing_credentials', '尚未配置手机号');

    const assembled = assembleProfile(this.store);
    const device = assembled.device;

    this.client = new StateGridClient({
      profile: device,
      username,
      password,
      session: this.store.loadSession(),
      onSession: (session) => this.store.saveSession(session),
      profileProvider: () => {
        // 每次请求前取一次 token（4 小时缓存，过期才重新生成）。
        const refreshed = assembled.refresh();
        return {
          ...device,
          deviceTokenTx: refreshed.token,
          deviceTokenTxTime: refreshed.tokenTime,
        };
      },
    });

    await this.client.ensureLogin();
    const session = this.client.currentSession;
    if (session) this.store.saveSession(session);

    // 首次拿到省份后写回：后续请求头要用，重登时也得保持一致。
    const province = String(session?.userInfo.addressProvince ?? '');
    if (province && province !== device.provinceHeader) {
      device.provinceHeader = province;
      this.store.saveRegion(province);
    }
  }

  private restoreCachedEntries(): void {
    const cache = this.store.loadAccountsCache();
    if (!cache) return;
    for (const account of this.accounts()) {
      if (!this.enabled(account) || this.entries.has(account.consNoSrc)) continue;
      const saved = cache.accounts.find((item) => item.consNo === account.consNoSrc);
      const entry = this.ensureEntry(account);
      entry.snapshot = cachedSnapshot(saved?.data ?? saved?.snapshot);
      entry.lastSuccess = saved?.lastSuccess ?? undefined;
      entry.lastError = saved?.lastError ?? undefined;
      if (entry.snapshot) void this.paint(entry).catch(() => undefined);
    }
  }

  private accounts(): PowerAccount[] {
    const live = this.client?.accounts ?? [];
    if (live.length) return live;
    // 登录态过期/密码登录被风控时，client.session 已被清空，但磁盘 session 的
    // userInfo 里还留着户号列表。用它兜底，保证设置页仍能看到户号（数据标「—」），
    // 而不是「没读到户号」。
    const session = this.store.loadSession();
    if (session?.userInfo) {
      const fromDisk = powerAccounts(session.userInfo);
      if (fromDisk.length) return fromDisk;
    }
    return [];
  }

  private configFor(account: PowerAccount): AccountConfig | undefined {
    return this.config.accounts?.find((item) => item.consNo && item.consNo === account.consNoSrc);
  }

  private enabled(account: PowerAccount): boolean {
    const configured = this.configFor(account);
    if (configured?.enabled === false) return false;
    // 设置页「户号与卡片预览」里的启用/停用开关，持久化在 storage。
    const visibility = this.store.loadVisibility();
    if (visibility[account.consNoSrc] === false) return false;
    return true;
  }

  private titleFor(account: PowerAccount): string {
    return this.appearanceFor(account).name;
  }

  private appearanceFor(account: PowerAccount) {
    return resolveAppearance(account.consNoSrc, account.address || '', this.store.loadAppearance()[account.consNoSrc], this.config);
  }

  private applyAppearance(entry: CameraEntry, account: PowerAccount, persist = true): void {
    const appearance = this.appearanceFor(account);
    entry.title = appearance.name;
    entry.region = appearance.region;
    entry.accessory.displayName = appearance.name;
    const information = entry.accessory.getService(this.api.hap.Service.AccessoryInformation);
    information?.setCharacteristic(this.api.hap.Characteristic.Name, appearance.name);
    if (this.api.hap.Characteristic.ConfiguredName) information?.setCharacteristic(this.api.hap.Characteristic.ConfiguredName, appearance.name);
    if (persist) this.api.updatePlatformAccessories([entry.accessory]);
  }

  private async reconcileAppearance(): Promise<void> {
    const raw = this.store.readAppearanceRaw();
    if (raw === this.lastAppearanceRaw) return;
    this.lastAppearanceRaw = raw;
    for (const account of this.accounts()) {
      const entry = this.entries.get(account.consNoSrc);
      if (!entry) continue;
      this.applyAppearance(entry, account);
      if (entry.snapshot) await this.paint(entry);
    }
    this.persistStatus();
  }

  private refreshAll(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefreshAll().finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  private async doRefreshAll(): Promise<void> {
    if (!this.client) return;
    // 每次刷新前先对齐配件：停用的户号从 HomeKit 移除、启用的补上。
    this.reconcileAccessories();
    const accounts = this.accounts().filter((account) => this.enabled(account));

    let successes = 0;
    for (const account of accounts) {
      const entry = this.entries.get(account.consNoSrc) ?? this.ensureEntry(account);
      try {
        const snapshot = await this.client.snapshot(account);
        successes++;
        entry.snapshot = snapshot;
        entry.lastSuccess = Date.now();
        entry.lastError = undefined;
        await this.paint(entry);
      } catch (error) {
        entry.lastError = error instanceof Error ? error.message : String(error);
        this.log.warn(`${entry.title} 数据刷新失败：${entry.lastError}`);
        if (entry.snapshot) await this.paint(entry);
        else await this.paintFallback(entry, '数据获取失败');
        if (error instanceof StateGridAuthenticationError || error instanceof StateGridDeviceVerificationRequired || error instanceof StateGridInteractiveChallengeRequired) {
          this.setError(error);
          return;
        }
      }
    }
    this.status.state = successes || !accounts.length ? 'ready' : 'error';
    this.status.message = successes === accounts.length ? '已连接网上国网' : `本次成功更新 ${successes}/${accounts.length} 个户号，失败数据已保留并标记`;
    this.status.updatedAt = Date.now();
    if (this.client.currentSession) this.store.saveSession(this.client.currentSession);
    this.persistStatus();
    if (accounts.length && !successes) this.setError(new Error('本次所有户号更新失败，将退避重试'));
  }

  /**
   * 把户号列表 + 各户号快照摘要落盘，供设置页读取。
   *
   * 设置页跑在独立进程里，唯一的共享面是 storage 目录。默认读这份缓存、
   * 不联网，就不会反复触发国网的短信/密码风控（RK007 超时）。
   */
  private persistAccountsCache(): void {
    try {
      const previous = this.store.loadAccountsCache();
      const accounts = this.accounts().map((account) => {
        const entry = this.entries.get(account.consNoSrc);
        const saved = previous?.accounts.find((item) => item.consNo === account.consNoSrc);
        return {
          consNo: account.consNoSrc,
          consNoMasked: maskConsNo(account.consNoSrc),
          name: account.name || '',
          address: account.address || '',
          consType: account.consType || '',
          title: this.titleFor(account),
        showRegion: this.appearanceFor(account).showRegion,
          enabled: this.enabled(account),
          lastSuccess: entry?.lastSuccess ?? saved?.lastSuccess ?? null,
          lastError: entry?.lastError ?? null,
          snapshot: entry?.snapshot ? summarizeSnapshot(entry.snapshot) : saved?.snapshot ?? null,
          data: entry?.snapshot ?? saved?.data,
        };
      });
      this.store.saveAccountsCache({ updatedAt: Date.now(), accounts });
    } catch (error) {
      this.log.debug(`写入户号缓存失败：${(error as Error).message}`);
    }
  }

  /** 把快照渲染成 PNG（给 ffmpeg）与 JPEG（给 HomeKit）。 */
  private async paint(entry: CameraEntry): Promise<void> {
    if (!entry.snapshot) return;
    const stale = entry.snapshot.updatedAt < Date.now() - STALE_AFTER_MS;
    const card = snapshotToCard(entry.snapshot, {
      title: entry.title, region: entry.region, fields: this.fields, theme: this.theme,
      staleNote: entry.lastError ? `更新失败 · 最近成功 ${formatClock(entry.snapshot.updatedAt)}` : stale ? `数据未更新 · 最近成功 ${formatClock(entry.snapshot.updatedAt)}` : undefined,
    });
    try {
      const png = renderPng(renderCard(card), { width: this.width });
      entry.png = png;
      atomicWrite(join(this.store.frameDir(), `${entry.consNo}.png`), png);
      entry.jpeg = await pngToJpeg(png, { width: this.width, quality: 88 });
      // 落盘预览缓存：设置页读它渲染缩略图，避免每次打开都联网拉数据。
      try {
        this.store.saveCachedPreview(entry.consNo, entry.jpeg);
      } catch (error) {
        this.log.debug(`写入预览缓存失败：${(error as Error).message}`);
      }
    } catch (error) {
      this.log.warn(`卡片渲染失败：${(error as Error).message}`);
      await this.paintFallback(entry, '卡片渲染失败');
    }
  }

  private async paintFallback(entry: CameraEntry, message: string): Promise<void> {
    const png = renderPng(fallbackCardSvg(this.width, this.height, message), { width: this.width });
    entry.png = png;
    atomicWrite(join(this.store.frameDir(), `${entry.consNo}.png`), png);
    try {
      entry.jpeg = await pngToJpeg(png, { width: this.width });
    } catch (error) {
      this.log.warn(`占位图转码失败：${(error as Error).message}`);
    }
  }

  /**
   * 把状态写到磁盘，供自定义 UI 读取。
   *
   * 必须这样做：`homebridge-ui/server.js` 跑在独立进程里，拿不到本进程的内存，
   * 两个进程之间唯一的通道就是 storage 目录。
   */
  private persistStatus(): void {
    try {
      atomicWrite(
        join(this.store.cacheDir(), 'status.json'),
        `${JSON.stringify({ ...this.statusSnapshot(), intervalHours: this.intervalHours }, null, 2)}\n`,
      );
    } catch (error) {
      this.log.debug(`写入状态文件失败：${(error as Error).message}`);
    }
    // 状态与户号缓存一起落盘，保证「需要验证码/风控」等非 ready 状态下，
    // 设置页仍能读到户号列表（数据标「—」）。
    this.persistAccountsCache();
  }

  private async detailSnapshot(title: string, snapshot: AccountSnapshot): Promise<Buffer> {
    const account = this.accounts().find((item) => item.consNoSrc === snapshot.consNo);
    const card = snapshotToCard(snapshot, { title, region: account ? this.appearanceFor(account).region : undefined, fields: this.fields, theme: this.theme });
    return pngToJpeg(renderPng(renderCard(card), { width: 1920 }), { quality: 90 });
  }

  private ensureEntry(account: PowerAccount): CameraEntry {
    const existing = this.entries.get(account.consNoSrc);
    if (existing) return existing;

    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${account.consNoSrc}`);
    const title = this.titleFor(account);
    const cached = this.pendingAccessories.find((item) => item.UUID === uuid);
    if (cached) this.pendingAccessories.splice(this.pendingAccessories.indexOf(cached), 1);

    const accessory =
      cached ?? new this.api.platformAccessory(title, uuid, this.api.hap.Categories.CAMERA);

    accessory.displayName = title;
    // 把户号写进 context，重启后 configureAccessory 能据此反查，停用的户号才能被移除。
    accessory.context.consNo = account.consNoSrc;

    const entry: CameraEntry = {
      accessory,
      consNo: account.consNoSrc,
      title,
      camera: undefined as unknown as UsageCamera,
    };

    entry.camera = new UsageCamera({
      name: title,
      onStreamError: (id) => entry.cameraError?.(id),
      log: this.log,
      width: this.width,
      height: this.height,
      ffmpegPath: (ffmpegStatic as unknown as string) || 'ffmpeg',
      // HomeKit 快照：优先给缓存好的 JPEG，没有就现渲染一张。
      snapshot: async () => {
        const current = this.entries.get(entry.consNo);
        if (current?.snapshot && (current.lastError || current.snapshot.updatedAt < Date.now() - STALE_AFTER_MS)) await this.paint(current);
        if (current?.jpeg) return current.jpeg;
        if (current?.png) {
          const png = current.png;
          current.jpeg = await pngToJpeg(png, { width: this.width });
          return current.jpeg;
        }
        return pngToJpeg(
          renderPng(fallbackCardSvg(this.width, this.height, '正在获取数据'), {
            width: this.width,
          }),
          { width: this.width },
        );
      },
      // 视频流的输入帧用 PNG，省一次转码。
      frame: async () => {
        const current = this.entries.get(entry.consNo);
        if (current?.png) return current.png;
        return renderPng(fallbackCardSvg(this.width, this.height, '正在获取数据'), {
          width: this.width,
        });
      },
      writeFrame: async (frame: Buffer) => {
        const file = join(this.store.frameDir(), `${entry.consNo}.png`);
        atomicWrite(file, frame);
        return file;
      },
    });

    this.entries.set(account.consNoSrc, entry);
    this.applyAppearance(entry, account, false);
    this.attachCameraController(accessory, entry);
    const saved = this.store.loadAccountsCache()?.accounts.find((item) => item.consNo === entry.consNo);
    entry.snapshot = cachedSnapshot(saved?.data ?? saved?.snapshot);
    entry.lastSuccess = saved?.lastSuccess ?? undefined;
    entry.lastError = saved?.lastError ?? undefined;
    if (entry.snapshot) void this.paint(entry).catch(() => undefined);

    if (!cached) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
    return entry;
  }

  /**
   * hap 的 CameraController 负责快照/流的协商，我们只实现 delegate。
   * 用 any 是因为 homebridge 与 hap-nodejs 的类型路径随版本变化，
   * 这里宁可放宽类型也要兼容 1.8 与 2.x 两条线。
   *
   * 关键：新版 hap-nodejs 把「协商好的地址/端口/SRTP 密钥」只放在
   * prepareStream 的 request 里，handleStreamRequest 阶段只有 sessionID +
   * 分辨率/码率等参数。因此必须用 sessionID 把 prepareStream 阶段收到的
   * 连接信息存起来，启动流时再取回。
   */
  private attachCameraController(accessory: PlatformAccessory, entry: CameraEntry): void {
    const hap = this.api.hap as unknown as Record<string, any>;
    const CameraController = hap.CameraController;
    if (!CameraController) {
      this.log.error('当前 Homebridge 未提供 CameraController，无法创建虚拟摄像头');
      return;
    }

    // sessionID -> prepareStream 阶段收到的连接信息。
    const sessions = new Map<string, import('./camera/camera-accessory.js').CameraStreamRequest>();

    const delegate = {
      handleSnapshotRequest: (
        _request: unknown,
        callback: (error?: Error, buffer?: Buffer) => void,
      ) => {
        void (async () => {
          try {
            callback(undefined, await entry.camera.snapshot());
          } catch (error) {
            callback(error as Error);
          }
        })();
      },
      prepareStream: (request: any, callback: (error?: Error, response?: unknown) => void) => {
        void (async () => {
          try {
            const info = { sessionID: request.sessionID, address: request.targetAddress, videoPort: request.video.port, videoSrtpKey: request.video.srtp_key, videoSrtpSalt: request.video.srtp_salt };
            sessions.set(request.sessionID, info);
            const plan = await entry.camera.prepareStream(info);
            callback(undefined, { video: { port: plan.port, ssrc: plan.ssrc, srtp_key: plan.srtpKey, srtp_salt: plan.srtpSalt } });
          } catch (error) { sessions.delete(request.sessionID); callback(error as Error); }
        })();
      },
      handleStreamRequest: (request: any, callback: (error?: Error) => void) => {
        void (async () => {
          try {
            if (request.type === 'stop') { entry.camera.stopStream(request.sessionID); sessions.delete(request.sessionID); callback(); return; }
            const info = sessions.get(request.sessionID);
            if (!info) throw new Error('找不到视频协商会话');
            const video = request.video || {};
            const options = { ...info, payloadType: video.pt ?? info.payloadType, width: video.width ?? info.width, height: video.height ?? info.height, fps: video.fps ?? info.fps, bitrate: video.max_bit_rate ?? info.bitrate, mtu: video.mtu ?? info.mtu };
            sessions.set(request.sessionID, options);
            if (request.type === 'reconfigure') await entry.camera.reconfigure(request.sessionID, options);
            else await entry.camera.startStream(options);
            callback();
          } catch (error) {
            entry.camera.stopStream(request.sessionID); sessions.delete(request.sessionID);
            this.log.warn(`视频流启动失败：${(error as Error).message}`);
            callback(error as Error);
          }
        })();
      },
    };

    const controller = new CameraController({
      cameraStreamCount: 2,
      delegate,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          codec: {
            profiles: [hap.H264Profile.BASELINE],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2],
          },
          resolutions: [
            [1280, 720, 15],
            [640, 360, 15],
            [320, 180, 15],
          ],
        },
        audio: { codecs: [] },
      },
    });

    entry.cameraError = (id: string) => { sessions.delete(id); controller.forceStopStreamingSession(id); };
    accessory.configureController(controller);
  }

  private scheduleRefresh(): void {
    // 只重置数据刷新定时器，绝不动 configWatcher（否则监听器会被误清）。
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    const intervalMs = this.intervalHours * 3600 * 1000;
    this.refreshTimer = setInterval(() => {
      void this.refreshAll().catch((error) => this.setError(error));
    }, intervalMs);
    this.refreshTimer.unref?.();
  }

  private stop(): void {
    this.stopped = true;
    this.stopVerifyPolling();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.configWatcher) clearInterval(this.configWatcher);
    this.configWatcher = null;
    for (const entry of this.entries.values()) entry.camera.stopStream();
  }

  /** 供自定义 UI 调用的状态快照。 */
  statusSnapshot(): Record<string, unknown> {
    return {
      state: this.status.state,
      message: this.status.message,
      updatedAt: this.status.updatedAt,
      accounts: this.accounts().map((account) => ({
        consNo: account.consNoSrc,
        name: account.name,
        address: account.address,
        title: this.titleFor(account),
        enabled: this.enabled(account),
        lastSuccess: this.entries.get(account.consNoSrc)?.lastSuccess ?? null,
        lastError: this.entries.get(account.consNoSrc)?.lastError ?? null,
      })),
    };
  }

  /** 供插件主动触发一次刷新（UI 的"立即更新"）。 */
  async refreshNow(): Promise<void> {
    await this.refreshAll();
  }

  /** 详情图，供 UI 预览。 */
  async detailImage(consNo: string): Promise<Buffer | null> {
    const entry = this.entries.get(consNo);
    if (!entry?.snapshot) return null;
    return this.detailSnapshot(entry.title, entry.snapshot);
  }
}

export const __test = { estimateCharge };
