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
  type AccountSnapshot,
  type PowerAccount,
} from './sgcc/types.js';
import { StateGridClient } from './sgcc/client.js';
import { renderCompactCard, renderDetailCard, type CardData } from './renderer/card-svg.js';
import { fallbackCardSvg, pngToJpeg, renderPng } from './renderer/image-renderer.js';
import { UsageCamera } from './camera/camera-accessory.js';
import { PluginStore } from './services/store.js';
import { assembleProfile } from './services/device-profile.js';
import { formatClock } from './renderer/format.js';

export const PLATFORM_NAME = 'StateGrid';
export const PLUGIN_NAME = 'homebridge-state-grid';

interface AccountConfig {
  consNo?: string;
  title?: string;
  enabled?: boolean;
}

export interface StateGridConfig extends PlatformConfig {
  username?: string;
  password?: string;
  updateIntervalHours?: number;
  theme?: 'light' | 'dark';
  snapshotWidth?: number;
  snapshotHeight?: number;
  accounts?: AccountConfig[];
}

interface CameraEntry {
  accessory: PlatformAccessory;
  camera: UsageCamera;
  consNo: string;
  title: string;
  /** HomeKit 快照（JPEG），有人打开摄像头时直接返回。 */
  jpeg?: Buffer;
  /** ffmpeg 的循环输入帧（PNG），视频流用它。 */
  png?: Buffer;
  snapshot?: AccountSnapshot;
  lastSuccess?: number;
  lastError?: string;
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

/** 从脱敏地址提取地区（省/市/区），去掉 `*` 及之后的详细地址与省级前缀。 */
function regionFromAddress(address: string): string {
  const region = (address || '').split('*')[0].trim();
  if (!region) return '';
  // 去掉省级前缀（如"河北省"→"石家庄市裕华区"）；直辖市（"北京市"）不含"省"，原样保留。
  return region.replace(/^[\u4e00-\u9fa5]{1,3}省/, '').trim();
}

export class StateGridPlatform implements DynamicPlatformPlugin {
  private readonly entries = new Map<string, CameraEntry>();
  private client: StateGridClient | null = null;
  private store: PluginStore;
  private refreshTimer: NodeJS.Timeout | null = null;
  /** 卡在"需要验证码"时，轮询磁盘 session 是否已被设置页更新。 */
  private verifyPollTimer: NodeJS.Timeout | null = null;
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

  private get intervalHours(): number {
    const raw = this.config.updateIntervalHours ?? DEFAULT_INTERVAL_HOURS;
    return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, raw));
  }

  private async bootstrap(): Promise<void> {
    try {
      await this.connect();
      await this.refreshAll();
      this.scheduleRefresh();
      this.status.state = 'ready';
      this.status.message = '已连接网上国网';
      this.status.updatedAt = Date.now();
      this.persistStatus();
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
    const currentToken = this.client?.currentSession?.token ?? '';
    if (!saved?.token || saved.token === currentToken) return;

    this.log.info('检测到验证已完成，重新连接网上国网…');
    this.stopVerifyPolling();
    try {
      // 直接走一遍 connect：它会从磁盘 loadSession 并 ensureLogin（session 未过期
      // 就直接复用，不再触发验证），随后 refreshAll 拉户号、渲染卡片。
      await this.connect();
      await this.refreshAll();
      this.status.state = 'ready';
      this.status.message = '已连接网上国网';
      this.status.updatedAt = Date.now();
      this.scheduleRefresh();
      this.persistStatus();
      this.log.info('网上国网连接已恢复');
    } catch (error) {
      this.setError(error);
    }
  }

  private stopVerifyPolling(): void {
    if (this.verifyPollTimer) clearInterval(this.verifyPollTimer);
    this.verifyPollTimer = null;
  }

  /** 组装设备档案并建立会话。 */
  private async connect(): Promise<void> {
    const username = this.config.username || this.store.loadAccount()?.username || '';
    const password = this.config.password || this.store.loadPassword() || '';
    if (!username || !password) {
      throw new StateGridAuthenticationError('missing_credentials', '尚未配置手机号或密码');
    }

    const assembled = assembleProfile(this.store);
    const device = assembled.device;

    this.client = new StateGridClient({
      profile: device,
      username,
      password,
      session: this.store.loadSession(),
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

  private accounts(): PowerAccount[] {
    return this.client?.accounts ?? [];
  }

  private configFor(account: PowerAccount): AccountConfig | undefined {
    return this.config.accounts?.find((item) => item.consNo && item.consNo === account.consNoSrc);
  }

  private enabled(account: PowerAccount): boolean {
    return this.configFor(account)?.enabled !== false;
  }

  private titleFor(account: PowerAccount): string {
    const match = this.configFor(account);
    const configured = match?.title?.trim();
    if (configured) return configured;
    // 户号名称只显示地区，不暴露脱敏真实姓名。
    const region = regionFromAddress(account.address || '');
    if (region) return region;
    return `用电 ${account.consNoSrc.slice(-4)}`;
  }

  private async refreshAll(): Promise<void> {
    if (!this.client) return;
    const accounts = this.accounts().filter((account) => this.enabled(account));

    for (const account of accounts) {
      const entry = this.ensureEntry(account);
      try {
        const snapshot = await this.client.snapshot(account);
        entry.snapshot = snapshot;
        entry.lastSuccess = Date.now();
        entry.lastError = undefined;
        await this.paint(entry);
      } catch (error) {
        entry.lastError = error instanceof Error ? error.message : String(error);
        this.log.warn(`${entry.title} 数据刷新失败：${entry.lastError}`);
        if (!entry.jpeg) await this.paintFallback(entry, '数据获取失败');
      }
    }
    this.persistStatus();
  }

  /** 把快照渲染成 PNG（给 ffmpeg）与 JPEG（给 HomeKit）。 */
  private async paint(entry: CameraEntry): Promise<void> {
    if (!entry.snapshot) return;
    const stale = entry.snapshot.updatedAt < Date.now() - STALE_AFTER_MS;
    const card: CardData = {
      title: entry.title,
      primaryValue: entry.snapshot.balance ?? entry.snapshot.amountDue,
      primaryLabel: entry.snapshot.balance !== undefined ? '账户余额' : '应交电费',
      latestDailyUsage: entry.snapshot.latestDailyUsage,
      latestDailyDate: entry.snapshot.latestDailyDate,
      currentMonthUsage: entry.snapshot.currentMonthUsage,
      monthEstimateCharge: estimateCharge(entry.snapshot),
      latestMonthUsage: entry.snapshot.latestMonthUsage,
      latestMonthCharge: entry.snapshot.latestMonthCharge,
      currentYearUsage: entry.snapshot.currentYearUsage,
      currentYearCharge: entry.snapshot.currentYearCharge,
      dailySeries: entry.snapshot.dailySeries,
      updatedAt: entry.snapshot.updatedAt,
      theme: this.theme,
      staleNote: stale ? `数据未更新 · 最近成功 ${formatClock(entry.snapshot.updatedAt)}` : undefined,
    };
    try {
      const png = renderPng(renderCompactCard(card), { width: this.width });
      entry.png = png;
      entry.jpeg = await pngToJpeg(png, { width: this.width, quality: 88 });
    } catch (error) {
      this.log.warn(`卡片渲染失败：${(error as Error).message}`);
      await this.paintFallback(entry, '卡片渲染失败');
    }
  }

  private async paintFallback(entry: CameraEntry, message: string): Promise<void> {
    const png = renderPng(fallbackCardSvg(this.width, this.height, message), { width: this.width });
    entry.png = png;
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
      writeFileSync(
        join(this.store.cacheDir(), 'status.json'),
        `${JSON.stringify({ ...this.statusSnapshot(), intervalHours: this.intervalHours }, null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      this.log.debug(`写入状态文件失败：${(error as Error).message}`);
    }
  }

  private async detailSnapshot(title: string, snapshot: AccountSnapshot): Promise<Buffer> {
    const card: CardData = {
      title,
      primaryValue: snapshot.balance ?? snapshot.amountDue,
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
      theme: this.theme,
    };
    return pngToJpeg(renderPng(renderDetailCard(card), { width: 1920 }), { quality: 90 });
  }

  private ensureEntry(account: PowerAccount): CameraEntry {
    const existing = this.entries.get(account.consNoSrc);
    if (existing) return existing;

    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${account.consNoSrc}`);
    const title = this.titleFor(account);
    const cached = this.pendingAccessories.find((item) => item.UUID === uuid);

    const accessory =
      cached ?? new this.api.platformAccessory(title, uuid, this.api.hap.Categories.CAMERA);

    accessory.displayName = title;

    const entry: CameraEntry = {
      accessory,
      consNo: account.consNoSrc,
      title,
      camera: undefined as unknown as UsageCamera,
    };

    entry.camera = new UsageCamera({
      name: title,
      log: this.log,
      width: this.width,
      height: this.height,
      ffmpegPath: (ffmpegStatic as unknown as string) || 'ffmpeg',
      // HomeKit 快照：优先给缓存好的 JPEG，没有就现渲染一张。
      snapshot: async () => {
        const current = this.entries.get(entry.consNo);
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
        writeFileSync(file, frame, { mode: 0o600 });
        return file;
      },
    });

    this.entries.set(account.consNoSrc, entry);
    this.attachCameraController(accessory, entry);

    if (!cached) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
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
    const sessions = new Map<
      string,
      { address: string; videoPort: number; videoSrtpKey: Buffer; videoSrtpSalt: Buffer }
    >();

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
        try {
          const info = {
            address: request.targetAddress,
            videoPort: request.video.port,
            videoSrtpKey: request.video.srtp_key,
            videoSrtpSalt: request.video.srtp_salt,
          };
          sessions.set(request.sessionID, info);
          const plan = entry.camera.prepareStream(info);
          callback(undefined, {
            video: {
              port: plan.port,
              ssrc: plan.ssrc,
              srtp_key: plan.srtpKey,
              srtp_salt: plan.srtpSalt,
            },
          });
        } catch (error) {
          callback(error as Error);
        }
      },
      handleStreamRequest: (request: any, callback: () => void) => {
        void (async () => {
          try {
            if (request.type === 'stop') {
              entry.camera.stopStream();
              callback();
              return;
            }
            if (request.type === 'reconfigure') {
              // 虚拟静态卡片：重配置只改变分辨率参数，无需重建 ffmpeg。
              callback();
              return;
            }
            const info = sessions.get(request.sessionID);
            if (!info) {
              throw new Error('找不到会话信息（session 未协商）');
            }
            await entry.camera.startStream(info);
            callback();
          } catch (error) {
            this.log.warn(`视频流启动失败：${(error as Error).message}`);
            callback();
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

    accessory.configureController(controller);
  }

  private scheduleRefresh(): void {
    this.stop();
    const intervalMs = this.intervalHours * 3600 * 1000;
    this.refreshTimer = setInterval(() => {
      void this.refreshAll().catch((error) => this.setError(error));
    }, intervalMs);
    this.refreshTimer.unref?.();
  }

  private stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
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

/**
 * 本月电费估算：用最近结算月的**实际均价**反推，而不是硬编码阶梯电价。
 *
 * 这样能自动适配地区差异，误差比固定电价小得多，但仍然只是估算——
 * 卡片上必须带"估算"字样。
 */
function estimateCharge(snapshot: AccountSnapshot): number | undefined {
  const { latestMonthCharge, latestMonthUsage, currentMonthUsage } = snapshot;
  if (!latestMonthCharge || !latestMonthUsage || !currentMonthUsage) return undefined;
  const unitPrice = latestMonthCharge / latestMonthUsage;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return undefined;
  return Math.round(currentMonthUsage * unitPrice * 100) / 100;
}

export const __test = { estimateCharge };
